/**
 * 流量统计服务：代理运行时每秒轮询 clash_api /connections，算出累计/速率/连接数，
 * 经 EVENT_STATS_UPDATED 推给渲染端展示。仅读取、不影响代理；轮询失败静默。
 */
import type { TrafficStats } from '../../shared/types';

const POLL_INTERVAL_MS = 1000;
const CLASH_API = 'http://127.0.0.1:9090/connections';

export class StatsService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: { up: number; down: number; at: number } | null = null;
  private snapshot: TrafficStats = {
    uploadSpeed: 0,
    downloadSpeed: 0,
    totalUpload: 0,
    totalDownload: 0,
    activeConnections: 0,
  };

  /**
   * @param onUpdate 每次拿到新快照时回调（广播给渲染端）
   * @param getSecret 取当前 clash_api secret（带 Authorization）
   */
  constructor(
    private readonly onUpdate: (stats: TrafficStats) => void,
    private readonly getSecret: () => string
  ) {}

  start(): void {
    if (this.timer) return;
    this.last = null;
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.last = null;
    this.snapshot = {
      uploadSpeed: 0,
      downloadSpeed: 0,
      totalUpload: 0,
      totalDownload: 0,
      activeConnections: 0,
    };
    this.onUpdate({ ...this.snapshot }); // 停止即清零广播
  }

  getSnapshot(): TrafficStats {
    return { ...this.snapshot };
  }

  private async poll(): Promise<void> {
    try {
      const secret = this.getSecret();
      const res = await fetch(CLASH_API, {
        headers: secret ? { Authorization: `Bearer ${secret}` } : {},
        signal: AbortSignal.timeout(900),
      });
      if (!res.ok) return; // 轮询失败静默（核心刚停/鉴权未就绪）
      const data = (await res.json()) as {
        uploadTotal?: number;
        downloadTotal?: number;
        connections?: unknown[];
      };

      const up = data.uploadTotal ?? 0;
      const down = data.downloadTotal ?? 0;
      const now = Date.now();
      if (this.last) {
        const dt = Math.max((now - this.last.at) / 1000, 0.001);
        // 核心重启会令累计回绕 → clamp 0，避免出现负速率
        this.snapshot.uploadSpeed = Math.max(0, (up - this.last.up) / dt);
        this.snapshot.downloadSpeed = Math.max(0, (down - this.last.down) / dt);
      }
      this.last = { up, down, at: now };
      this.snapshot.totalUpload = up;
      this.snapshot.totalDownload = down;
      this.snapshot.activeConnections = Array.isArray(data.connections)
        ? data.connections.length
        : 0;
      this.onUpdate({ ...this.snapshot });
    } catch {
      /* 静默：核心未运行 / 连接被拒 */
    }
  }
}
