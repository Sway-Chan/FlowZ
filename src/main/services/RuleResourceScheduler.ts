/**
 * 规则资源自动更新调度器
 *
 * 职责：sing-box 不会自动重新下载本地 rule_set（res: 引用的 .srs，type:local 无 update_interval），
 * 故由 FlowZ 周期重下载保持本地资源新鲜。
 * - 启动补更：启动后延迟一段时间，对「陈旧」资源（距上次下载 ≥ 间隔，或从未记录）补更一次。
 * - 周期巡检：每 30 分钟扫一遍，更新到期资源。
 * - 退避：单资源失败后指数退避（10min→…→上限 6h）。
 * - 静默：后台更新 silent（不发进度事件、不弹 toast）；失败仅日志 + 退避。
 * - 不打断连接：更新经 RuleResourceManager.updateMany → 批末单次保存；仅「被引用且原文件缺失」才重启，
 *   已加载的 local rule_set 内容变更由 sing-box ≥1.10 fswatch 热重载（见 RuleResourceManager.download）。
 * - 下载走直连/gh-proxy（不依赖代理运行），无冷启动鸡生蛋问题。
 */

import * as fssync from 'fs';
import * as path from 'path';
import type { ConfigManager } from './ConfigManager';
import type { LogManager } from './LogManager';
import type { RuleResourceManager } from './RuleResourceManager';
import type { UserConfig } from '../../shared/types';
import { getRuleResourcesPath } from '../utils/paths';
import { BUILTIN_GEO_RULESETS, getRuleSetRuntimeDir, builtinIdFor } from './builtin-geo-rulesets';

export class RuleResourceScheduler {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private isRunning = false;
  private backoff = new Map<string, { failures: number; nextEligibleAt: number }>();

  private static readonly TICK_MS = 30 * 60_000;
  private static readonly STARTUP_DELAY_MS = 12_000; // 错开 SubscriptionScheduler 的 8s 启动高峰
  private static readonly BACKOFF_BASE_MS = 10 * 60_000;
  private static readonly BACKOFF_MAX_MS = 6 * 60 * 60_000;
  private static readonly DEFAULT_INTERVAL_HOURS = 24;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly ruleResourceManager: RuleResourceManager,
    private readonly logManager: LogManager
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    setTimeout(() => {
      this.runDueUpdates('启动补更').catch((e) => {
        this.logManager.addLog('warn', `规则资源启动补更异常: ${e}`, 'RuleResScheduler');
      });
    }, RuleResourceScheduler.STARTUP_DELAY_MS);

    this.tickTimer = setInterval(() => {
      this.runDueUpdates('周期更新').catch((e) => {
        this.logManager.addLog('warn', `规则资源周期更新异常: ${e}`, 'RuleResScheduler');
      });
    }, RuleResourceScheduler.TICK_MS);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.started = false;
  }

  private intervalMs(config: UserConfig): number {
    const h = config.ruleResourceUpdateIntervalHours;
    const hours = typeof h === 'number' && h > 0 ? h : RuleResourceScheduler.DEFAULT_INTERVAL_HOURS;
    return hours * 3_600_000;
  }

  private async runDueUpdates(reason: string): Promise<void> {
    if (!this.started || this.isRunning) return; // 已 stop（含启动补更定时器晚触发）则不跑
    this.isRunning = true;
    try {
      const config = await this.configManager.loadConfig();
      if (!config.ruleResourceAutoUpdate) return; // 总开关未开
      const resources = config.ruleResources || [];

      const dir = getRuleResourcesPath();
      const now = Date.now();
      const intervalMs = this.intervalMs(config);
      const staleIds: string[] = [];
      for (const res of resources) {
        // 陈旧：从未记录 / 超间隔 / 磁盘文件缺失（备份恢复或手删后下一轮即自动补回）
        const last = res.downloadedAt ? Date.parse(res.downloadedAt) : 0;
        const missing = !fssync.existsSync(path.join(dir, res.fileName));
        if (!missing && last && now - last < intervalMs) continue;
        const bo = this.backoff.get(res.id);
        if (bo && now < bo.nextEligibleAt) continue;
        staleIds.push(res.id);
      }

      // 内置 geo 规则集：陈旧判定用 builtinGeoMeta[tag].updatedAt（无记录=出厂=视为可补更），
      // 文件缺失也补；backoff 键用 builtin:tag（与 updateBuiltin 返回的 r.id 对齐）。
      const runtimeDir = getRuleSetRuntimeDir();
      const builtinMeta = config.builtinGeoMeta || {};
      for (const b of BUILTIN_GEO_RULESETS) {
        const lastIso = builtinMeta[b.tag]?.updatedAt;
        const last = lastIso ? Date.parse(lastIso) : 0;
        const missing = !fssync.existsSync(path.join(runtimeDir, b.fileName));
        if (!missing && last && now - last < intervalMs) continue;
        const id = builtinIdFor(b.tag);
        const bo = this.backoff.get(id);
        if (bo && now < bo.nextEligibleAt) continue;
        staleIds.push(id);
      }

      if (staleIds.length === 0) return;

      const results = await this.ruleResourceManager.updateMany(staleIds, { silent: true });
      let ok = 0;
      let failed = 0;
      for (const r of results) {
        if (r.ok) {
          ok++;
          if (r.id) this.backoff.delete(r.id);
        } else {
          failed++;
          if (r.id) {
            const failures = (this.backoff.get(r.id)?.failures ?? 0) + 1;
            const delay = Math.min(
              RuleResourceScheduler.BACKOFF_BASE_MS * 2 ** (failures - 1),
              RuleResourceScheduler.BACKOFF_MAX_MS
            );
            this.backoff.set(r.id, { failures, nextEligibleAt: now + delay });
          }
        }
      }
      if (ok > 0 || failed > 0) {
        this.logManager.addLog(
          'info',
          `[${reason}] 规则资源自动更新：成功 ${ok}，失败 ${failed}`,
          'RuleResScheduler'
        );
      }
    } finally {
      this.isRunning = false;
    }
  }
}
