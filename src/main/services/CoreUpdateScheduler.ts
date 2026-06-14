/**
 * 内核自动更新调度器（仅兼容版本带内）
 *
 * 职责：周期性触发 CoreUpdateService.runAutoUpdateCycle（检查→带内下载+预检+暂存/落位），
 * 并在代理停止 / App 启动 / 用户「立即应用」三个安全窗口推进 staged 落位。
 *
 * 不变量：
 * - **绝不主动断流**：换核落位只在代理进程不存在时发生（CoreUpdateService.tryApplyStaged 内守 running===false）。
 *   本调度器仅在「检测到代理已停止」后延 5s 双查再尝试落位，规避 attemptAutoRestart/switchMode 的 stop→start 窗口。
 * - **跨 minor 绝不自动**：兼容带硬闸在 runAutoUpdateCycle 内（sameMajorMinor），本调度器只负责触发时机。
 * - 依赖注入（不 import electron），便于单测（fake timers + mock 依赖）。
 */

import type { ConfigManager } from './ConfigManager';
import type { LogManager } from './LogManager';
import type { CoreUpdateService } from './CoreUpdateService';

export class CoreUpdateScheduler {
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private stoppedApplyTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private isRunning = false; // cycleIfDue 防重入

  // 启动延迟 30s：避开 2s autoConnect / 5s App 更新检查 / 8s 订阅补更高峰
  private static readonly STARTUP_DELAY_MS = 30_000;
  private static readonly TICK_MS = 6 * 60 * 60_000; // 6h 巡检一次
  private static readonly CHECK_INTERVAL_MS = 24 * 60 * 60_000; // 24h due（距上次检查满 24h 才真正跑）
  private static readonly STOPPED_APPLY_DELAY_MS = 5_000; // 代理停止后延 5s 双查再落位（规避 stop→start 窗口）

  constructor(
    private readonly configManager: ConfigManager,
    private readonly coreUpdateService: CoreUpdateService,
    private readonly logManager: LogManager,
    private readonly getProxyRunning: () => boolean
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.cycleIfDue();
    }, CoreUpdateScheduler.STARTUP_DELAY_MS);

    this.tickTimer = setInterval(() => {
      void this.cycleIfDue();
    }, CoreUpdateScheduler.TICK_MS);
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.stoppedApplyTimer) {
      clearTimeout(this.stoppedApplyTimer);
      this.stoppedApplyTimer = null;
    }
    this.started = false;
  }

  /** config 变更时调（开关刚开即时体感，无需等 6h tick）。幂等：未开/未 due 时自然跳过。 */
  kick(): void {
    void this.cycleIfDue();
  }

  /**
   * 代理停止事件：延 5s 双查代理仍未运行后，尝试落位 staged 内核。
   * 延迟+双查规避 attemptAutoRestart/switchMode 的瞬时 stop→start 窗口（误判停止而在重启间隙落位）。
   */
  onProxyStopped(): void {
    if (!this.started) return;
    if (this.stoppedApplyTimer) clearTimeout(this.stoppedApplyTimer);
    this.stoppedApplyTimer = setTimeout(() => {
      this.stoppedApplyTimer = null;
      if (this.getProxyRunning()) return; // 5s 内又起来了（重启窗口）→ 本次不落位
      this.coreUpdateService.tryApplyStaged('proxy-stopped').catch((e) => {
        this.logManager.addLog(
          'warn',
          `代理停止后落位 staged 内核异常: ${e}`,
          'CoreUpdateScheduler'
        );
      });
    }, CoreUpdateScheduler.STOPPED_APPLY_DELAY_MS);
  }

  /**
   * 周期检查：防重入 + autoUpdateCore 守门 + 24h due → runAutoUpdateCycle。
   * 网络/检查失败由 runAutoUpdateCycle 内部自吞，下轮 tick 重试，无需退避。
   */
  private async cycleIfDue(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const config = await this.configManager.loadConfig();
      if (config.autoUpdateCore !== true) return; // 总开关未开（默认 false）

      const status = await this.coreUpdateService.getAutoStatus();
      const last = status.lastCheckAt ?? 0;
      if (last && Date.now() - last < CoreUpdateScheduler.CHECK_INTERVAL_MS) return; // 未到 24h

      await this.coreUpdateService.runAutoUpdateCycle();
    } catch (e) {
      this.logManager.addLog('warn', `内核自动更新周期检查异常: ${e}`, 'CoreUpdateScheduler');
    } finally {
      this.isRunning = false;
    }
  }
}
