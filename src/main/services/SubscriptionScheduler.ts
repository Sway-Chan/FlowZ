/**
 * 订阅自动更新调度器
 *
 * 职责：在不打断当前连接的前提下，按需自动刷新订阅节点。
 * - 启动补更：启动后延迟一段时间，对「陈旧」订阅（距上次更新 ≥ 间隔阈值，或从未更新）补一次更新。
 * - 周期巡检：每 30 分钟扫一遍，更新到期的订阅。
 * - 退避：单个订阅失败后指数退避（5min→…→上限 6h），避免对故障源高频重试。
 * - 不打断连接：只「落盘 + 通知 UI」，绝不重启代理——运行中的 sing-box 保持其内存配置，
 *   节点增删仅在下次（重）启动或热切换时生效。配合 reconcile 保留 id/选中节点，连接零中断。
 * - 经代理开关：viaProxy 时若代理未运行则本轮跳过（冷启动鸡生蛋），待代理就绪后周期巡检自动补上。
 */

import type { ConfigManager } from './ConfigManager';
import type { LogManager } from './LogManager';
import { SubscriptionService } from './SubscriptionService';
import type { UserConfig } from '../../shared/types';

export class SubscriptionScheduler {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private isRunning = false; // 防重入（巡检与启动补更不并发）
  // 每订阅退避状态：累计失败次数 + 下次可尝试时刻
  private backoff = new Map<string, { failures: number; nextEligibleAt: number }>();

  private static readonly TICK_MS = 30 * 60_000; // 30 分钟巡检一次
  private static readonly STARTUP_DELAY_MS = 8_000; // 启动延迟，避开启动高峰
  private static readonly BACKOFF_BASE_MS = 5 * 60_000; // 退避基数 5 分钟
  private static readonly BACKOFF_MAX_MS = 6 * 60 * 60_000; // 退避上限 6 小时
  private static readonly DEFAULT_INTERVAL_HOURS = 12;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly subscriptionService: SubscriptionService,
    private readonly logManager: LogManager,
    private readonly getProxyRunning: () => boolean,
    private readonly notifyConfigChanged: (config: UserConfig) => void
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    setTimeout(() => {
      this.runDueUpdates('启动补更').catch((e) => {
        this.logManager.addLog('warn', `订阅启动补更异常: ${e}`, 'SubScheduler');
      });
    }, SubscriptionScheduler.STARTUP_DELAY_MS);

    this.tickTimer = setInterval(() => {
      this.runDueUpdates('周期更新').catch((e) => {
        this.logManager.addLog('warn', `订阅周期更新异常: ${e}`, 'SubScheduler');
      });
    }, SubscriptionScheduler.TICK_MS);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.started = false;
  }

  private intervalMs(config: UserConfig): number {
    const h = config.subscriptionUpdateIntervalHours;
    const hours = typeof h === 'number' && h > 0 ? h : SubscriptionScheduler.DEFAULT_INTERVAL_HOURS;
    return hours * 3_600_000;
  }

  private async runDueUpdates(reason: string): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const config = await this.configManager.loadConfig();
      if (!config.autoUpdateSubscriptionOnStart) return; // 总开关未开
      const subs = config.subscriptions || [];
      if (subs.length === 0) return;

      const viaProxy = config.subscriptionUpdateViaProxy === true;
      // viaProxy 但代理未运行：冷启动鸡生蛋，本轮跳过，待代理就绪后由周期巡检补上
      if (viaProxy && !this.getProxyRunning()) {
        this.logManager.addLog(
          'info',
          '订阅更新经代理但代理未运行，本轮跳过（待代理就绪后自动补更）',
          'SubScheduler'
        );
        return;
      }

      const now = Date.now();
      const intervalMs = this.intervalMs(config);
      let failed = 0;

      // 阶段 1：仅做网络拉取（不触碰 config），收集到期订阅的抓取结果
      const fetched: Array<{
        subId: string;
        name: string;
        servers: typeof config.servers;
        userInfo: (typeof subs)[number]['userInfo'];
      }> = [];
      for (const sub of subs) {
        if (!sub.autoUpdate) continue;

        // 陈旧判断：从未更新或已超过间隔阈值
        const last = sub.lastUpdated ? Date.parse(sub.lastUpdated) : 0;
        const stale = !last || now - last >= intervalMs;
        if (!stale) continue;

        // 退避判断：失败源未到下次可尝试时刻则跳过
        const bo = this.backoff.get(sub.id);
        if (bo && now < bo.nextEligibleAt) continue;

        try {
          const result = await this.subscriptionService.fetchSubscription(
            sub.url,
            sub.id,
            viaProxy
          );
          fetched.push({
            subId: sub.id,
            name: sub.name,
            servers: result.servers,
            userInfo: result.userInfo,
          });
          this.backoff.delete(sub.id);
        } catch (e: any) {
          failed++;
          const failures = (this.backoff.get(sub.id)?.failures ?? 0) + 1;
          const delay = Math.min(
            SubscriptionScheduler.BACKOFF_BASE_MS * 2 ** (failures - 1),
            SubscriptionScheduler.BACKOFF_MAX_MS
          );
          this.backoff.set(sub.id, { failures, nextEligibleAt: now + delay });
          this.logManager.addLog(
            'warn',
            `[${reason}] 订阅 [${sub.name}] 更新失败(第 ${failures} 次)，${Math.round(delay / 60_000)} 分钟后重试: ${e?.message ?? e}`,
            'SubScheduler'
          );
        }
      }

      if (fetched.length === 0) return;

      // 阶段 2：重载最新 config，逐订阅对账并合并，单次落盘。
      // 关键：reconcile 针对「重载后的最新 servers」做，且只替换该订阅自己的节点 —— 期间渲染端对
      // 自建节点/其它订阅/其它设置的写入不会被本次后台更新覆盖（缩小读改写丢更新窗口）。
      const fresh = await this.configManager.loadConfig();
      const nowIso = new Date().toISOString();
      let updated = 0;
      for (const f of fetched) {
        const sub = fresh.subscriptions?.find((x) => x.id === f.subId);
        if (!sub) continue; // 订阅在此期间被删除 → 跳过
        const oldServers = fresh.servers.filter((s) => s.subscriptionId === f.subId);
        const { servers: kept, deletedIds } = SubscriptionService.reconcileServers(
          oldServers,
          f.servers,
          nowIso
        );
        if (fresh.selectedServerId && deletedIds.has(fresh.selectedServerId)) {
          fresh.selectedServerId = null;
        }
        const others = fresh.servers.filter((s) => s.subscriptionId !== f.subId);
        fresh.servers = [...others, ...kept];
        sub.lastUpdated = nowIso;
        if (f.userInfo) sub.userInfo = f.userInfo;
        updated++;
      }

      if (updated > 0) {
        // 仅落盘 + 通知 UI，绝不重启代理 → 不打断当前连接
        await this.configManager.saveConfig(fresh);
        this.notifyConfigChanged(fresh);
        this.logManager.addLog(
          'info',
          `[${reason}] 订阅自动更新完成：成功 ${updated}，失败 ${failed}`,
          'SubScheduler'
        );
      }
    } finally {
      this.isRunning = false;
    }
  }
}
