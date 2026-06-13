/**
 * 流量统计服务：代理运行时每秒轮询 clash_api /connections，算出累计/速率/连接数，
 * 经 EVENT_STATS_UPDATED 推给渲染端展示。仅读取、不影响代理；轮询失败静默。
 */
import * as http from 'http';
import type { TrafficStats, ConnectionEntry, ConnectionsSnapshot } from '../../shared/types';

const POLL_INTERVAL_MS = 1000;
const CLASH_API_PATH = '/connections';
const CONNECTIONS_PUSH_DIVIDER = 2; // 1s 轮询，每 2 tick 推一次连接快照 = 维持原 topology 2s 节奏

/**
 * 裁剪 clash 原始 connection → ConnectionEntry。
 * topology 用 id/chains/rule/rulePayload/metadata{host,destinationIP}；连接信息页额外用
 * network/type/sourceIP/sourcePort/destinationPort/processPath + upload/download/start（速率/源/进程/时长）。
 * ⚠️ metadata 含 sourceIP/processPath 隐私字段——出 IPC 供连接信息页用，由渲染端在隐私模式下屏蔽明细（决策）。
 * 数值字段经 Number()+isFinite 兜底为 undefined（避免 NaN 进 UI 差分）。导出供单测断言扩字段带出。
 */
export function trimConnection(c: any): ConnectionEntry {
  const m = c?.metadata;
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    id: String(c?.id ?? ''),
    chains: Array.isArray(c?.chains) ? c.chains : [],
    rule: String(c?.rule ?? ''),
    rulePayload: String(c?.rulePayload ?? ''),
    metadata: m
      ? {
          host: m.host,
          destinationIP: m.destinationIP,
          network: m.network,
          type: m.type,
          sourceIP: m.sourceIP,
          sourcePort: m.sourcePort,
          destinationPort: m.destinationPort,
          processPath: m.processPath,
        }
      : undefined,
    upload: num(c?.upload),
    download: num(c?.download),
    start: typeof c?.start === 'string' ? c.start : undefined,
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
  // 专属 http.Agent（keep-alive 复用单连接）。用它而非全局 fetch/undici → stop 时可定向 destroy 关掉到 9090 的
  // socket（client 主动 RST → server 被动关 → **9090 不进 TIME_WAIT**），杜绝下次用户态 sing-box 撞 root TIME_WAIT 等 30s。
  private agent = new http.Agent({ keepAlive: true, maxSockets: 2 });

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

  /** 关掉本服务到 9090 的所有 keep-alive socket（client 主动关 → 9090 不进 TIME_WAIT）。停代理/杀核前调。 */
  closeConnections(): void {
    try {
      this.agent.destroy();
    } catch {
      /* 忽略 */
    }
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
  }

  /** 经专属 agent 取 clash_api JSON（替代全局 fetch，使连接可被 closeConnections 定向关闭）。 */
  private getJson(path: string): Promise<{
    uploadTotal?: number;
    downloadTotal?: number;
    connections?: unknown[];
  } | null> {
    return new Promise((resolve) => {
      const secret = this.getSecret();
      const req = http.request(
        {
          host: '127.0.0.1',
          port: 9090,
          path,
          method: 'GET',
          agent: this.agent,
          timeout: 900,
          headers: secret ? { Authorization: `Bearer ${secret}` } : {},
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            resolve(null);
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  private async poll(): Promise<void> {
    try {
      const data = await this.getJson(CLASH_API_PATH);
      if (!data) return; // 轮询失败静默（核心刚停/鉴权未就绪）

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
