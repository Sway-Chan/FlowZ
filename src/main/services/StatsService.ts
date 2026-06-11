/**
 * 流量统计服务：代理运行时每秒轮询 clash_api /connections，算出累计/速率/连接数，
 * 经 EVENT_STATS_UPDATED 推给渲染端展示。仅读取、不影响代理；轮询失败静默。
 */
import type { TrafficStats, ConnectionEntry, ConnectionsSnapshot } from '../../shared/types';

const POLL_INTERVAL_MS = 1000;
const CLASH_API = 'http://127.0.0.1:9090/connections';
const CONNECTIONS_PUSH_DIVIDER = 2; // 1s 轮询，每 2 tick 推一次连接快照 = 维持原 topology 2s 节奏

/** 裁剪 clash 原始 connection → topology 所需子集（丢弃 upload/download/sourceIP/processPath 等，含隐私字段不出 IPC）。 */
function trimConnection(c: any): ConnectionEntry {
  return {
    id: String(c?.id ?? ''),
    chains: Array.isArray(c?.chains) ? c.chains : [],
    rule: String(c?.rule ?? ''),
    rulePayload: String(c?.rulePayload ?? ''),
    metadata: c?.metadata
      ? { host: c.metadata.host, destinationIP: c.metadata.destinationIP }
      : undefined,
  };
}

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
  private connections: ConnectionEntry[] = [];
  private tick = 0;

  /**
   * @param onUpdate 每次拿到新快照时回调（广播给渲染端）
   * @param getSecret 取当前 clash_api secret（带 Authorization）
   * @param onConnections 连接快照回调（topology 统一供数；按 divider 节奏推送）
   */
  constructor(
    private readonly onUpdate: (stats: TrafficStats) => void,
    private readonly getSecret: () => string,
    private readonly onConnections?: (snap: ConnectionsSnapshot) => void
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
    this.connections = [];
    this.tick = 0;
    this.onConnections?.({ connections: [], at: Date.now() }); // 停止即广播空连接快照
  }

  getSnapshot(): TrafficStats {
    return { ...this.snapshot };
  }

  getConnectionsSnapshot(): ConnectionsSnapshot {
    return { connections: this.connections, at: Date.now() };
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

      // 连接快照：复用本次已取到的 data.connections，裁剪后按 divider 节奏推送（全局唯一 poller）
      this.connections = Array.isArray(data.connections)
        ? data.connections.map(trimConnection)
        : [];
      if (++this.tick % CONNECTIONS_PUSH_DIVIDER === 0) {
        this.onConnections?.({ connections: this.connections, at: now });
      }
    } catch {
      /* 静默：核心未运行 / 连接被拒 */
    }
  }
}
