/**
 * 出口 IP 信息服务：测出「本地直连出口 IP」与「代理出口 IP」，经 EVENT_IP_INFO_UPDATED 推渲染端。
 *
 * 取数走 ProxyManager 的探针 inbound（probe-direct-in / probe-proxy-in，见 ProxyManager.getProbePorts）：
 * 这两个本地 HTTP inbound 在 route.rules 头部被钉死分别走 direct / proxy-selector，因此无论「接管方式
 * (系统代理/TUN/手动)」与「分流策略(全局/智能/直连)」如何组合，都能稳定测出真实出口 IP。代理未运行时，
 * direct 退回主进程裸 fetch（此时无 TUN，必直连），proxy 置 null。
 *
 * 事件驱动刷新（无周期轮询）：省第三方配额、不持续暴露行为。60s TTL + in-flight 去重；失败保留旧值。
 */
import * as http from 'http';
import type { IpInfo, IpInfoSnapshot } from '../../shared/types';

const TTL_MS = 60_000;
const REQ_TIMEOUT_MS = 5000;

interface ProbeEndpoint {
  host: string;
  path: string;
}
// 本地出口主用国内接口：旁路由/软路由透明分流会把国外目标劫持走境外出口，导致 ip-api 把本地出口误标为
// 境外节点 IP；国内接口走真实大陆出口，是这类环境下唯一能测对本地出口的办法（也更快、不触 ip-api 限流）。
const EP_IPIP: ProbeEndpoint = { host: 'myip.ipip.net', path: '/json' };
const EP_IPAPI: ProbeEndpoint = {
  host: 'ip-api.com',
  path: '/json/?fields=status,query,country,countryCode',
};
const EP_IPIFY: ProbeEndpoint = { host: 'api.ipify.org', path: '/?format=json' };
// 代理出口：境外节点访国外接口快且对任意国家都有 ISO countryCode（国旗）；ipify 与 ip-api 限流无关联兜底；
// ipip 末位仅作路径分集保底（境外入境最不稳）。
const PROXY_CHAIN: ProbeEndpoint[] = [EP_IPAPI, EP_IPIFY, EP_IPIP];

/** ipip 无 ISO 国别码：中国→cn（港澳台细分），其余 undefined（渲染端 Globe 兜底）。 */
function ccFromIpipLocation(loc: readonly string[]): string | undefined {
  if (loc[0] !== '中国') return undefined;
  if (loc[1] === '香港') return 'hk';
  if (loc[1] === '澳门') return 'mo';
  if (loc[1] === '台湾') return 'tw';
  return 'cn';
}

export class IpInfoService {
  private snapshot: IpInfoSnapshot = { direct: null, proxy: null, updatedAt: 0 };
  private inflight: Promise<void> | null = null;

  /**
   * @param getProbePorts 取当前探针端口（代理未运行/分配失败时 null）
   * @param isRunning sing-box 是否在运行
   * @param onUpdate 快照更新时回调（广播给渲染端）
   */
  constructor(
    private readonly getProbePorts: () => { direct: number; proxy: number } | null,
    private readonly isRunning: () => boolean,
    private readonly onUpdate: (snap: IpInfoSnapshot) => void
  ) {}

  getSnapshot(): IpInfoSnapshot {
    return { ...this.snapshot };
  }

  /** 把刷新任务排到当前在途之后（链式），避免 force/proxy 刷新被 in-flight 去重静默吞掉。 */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const prev = this.inflight;
    const task = (async () => {
      if (prev) await prev.catch(() => {});
      await fn();
    })();
    this.inflight = task;
    return task.finally(() => {
      if (this.inflight === task) this.inflight = null;
    });
  }

  /** 取出口 IP；命中 TTL 直接返回缓存；force 排队重测，非 force 复用在途。 */
  async refresh(force = false): Promise<IpInfoSnapshot> {
    if (!force && !this.snapshot.error && Date.now() - this.snapshot.updatedAt < TTL_MS) {
      return this.getSnapshot();
    }
    // 非强制：有在途则复用其结果（去重正确）；强制：链式排队，不被在途吞掉
    if (!force && this.inflight) {
      await this.inflight.catch(() => {});
      return this.getSnapshot();
    }
    await this.enqueue(() => this.doRefresh());
    return this.getSnapshot();
  }

  /**
   * 仅重测代理出口（切节点场景）：本地直连出口不因切节点改变（direct 出站绑物理网卡），无需重测。
   * 链式排到在途之后（不复用，避免切节点的代理 IP 被旧的全量刷新结果吞掉）。proxy-only 也推进 updatedAt。
   */
  async refreshProxy(): Promise<IpInfoSnapshot> {
    await this.enqueue(() => this.doRefreshProxy());
    return this.getSnapshot();
  }

  private async doRefreshProxy(): Promise<void> {
    const ports = this.getProbePorts();
    if (!this.isRunning() || !ports) {
      this.snapshot = { ...this.snapshot, proxy: null, updatedAt: Date.now(), loading: false };
      this.onUpdate(this.getSnapshot());
      return;
    }
    this.snapshot = { ...this.snapshot, loading: true };
    this.onUpdate(this.getSnapshot());
    const p = await this.queryViaProxy(ports.proxy);
    this.snapshot = {
      ...this.snapshot,
      proxy: p ?? this.snapshot.proxy, // 失败保留旧值
      updatedAt: Date.now(),
      loading: false,
      error: p ? undefined : 'fetch_failed',
    };
    this.onUpdate(this.getSnapshot());
  }

  private async doRefresh(): Promise<void> {
    this.snapshot = { ...this.snapshot, loading: true };
    this.onUpdate(this.getSnapshot());

    const ports = this.getProbePorts();
    const running = this.isRunning();

    let direct = this.snapshot.direct;
    let proxy = this.snapshot.proxy;
    let failed = false;

    if (running && ports) {
      const [d, p] = await Promise.all([
        this.queryDirectChain((ep) => this.viaProbe(ports.direct, ep)),
        this.queryViaProxy(ports.proxy),
      ]);
      if (d) direct = d;
      else failed = true;
      if (p) proxy = p;
      else failed = true; // 保留旧 proxy 值，仅标记失败（黄点提示）
    } else if (running) {
      // 核心在跑但探针端口分配失败：不能裸 fetch——TUN 下裸 fetch 会被捕获走代理出口，误标为本地出口。
      // 保留旧 direct + 旧 proxy，仅标记失败。
      failed = true;
    } else {
      // 核心未运行：direct 走主进程裸 fetch（无 TUN，必直连）；proxy 不可测
      const d = await this.queryDirect();
      if (d) direct = d;
      else failed = true;
      proxy = null;
    }

    this.snapshot = {
      direct,
      proxy,
      updatedAt: Date.now(),
      loading: false,
      error: failed ? 'fetch_failed' : undefined,
    };
    this.onUpdate(this.getSnapshot());
  }

  /** 经探针 HTTP 代理端口 absolute-form 请求端点。 */
  private viaProbe(proxyPort: number, ep: ProbeEndpoint): Promise<IpInfo | null> {
    return this.httpJson({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: `http://${ep.host}${ep.path}`,
      headers: { Host: ep.host, Connection: 'close' },
    });
  }

  /** 主进程裸直连请求端点。 */
  private bare(ep: ProbeEndpoint): Promise<IpInfo | null> {
    return this.httpJson({
      hostname: ep.host,
      port: 80,
      path: ep.path,
      headers: { Host: ep.host, Connection: 'close' },
    });
  }

  /**
   * 本地出口链：国内接口(ipip)为主；成功但缺 countryCode（多为境外直连出口，国内库无 ISO 码）→ ip-api
   * 增补（失败保留国内结果）；国内接口失败 → ip-api 兜底 → ipify 仅 IP 保底。
   */
  private async queryDirectChain(
    fetch: (ep: ProbeEndpoint) => Promise<IpInfo | null>
  ): Promise<IpInfo | null> {
    const primary = await fetch(EP_IPIP);
    if (primary?.countryCode) return primary;
    const enriched = await fetch(EP_IPAPI);
    if (enriched) return enriched;
    if (primary) return primary;
    return fetch(EP_IPIFY);
  }

  /** 代理出口：经探针端口依次尝试 PROXY_CHAIN，首个成功即返回。 */
  private async queryViaProxy(proxyPort: number): Promise<IpInfo | null> {
    for (const ep of PROXY_CHAIN) {
      const r = await this.viaProbe(proxyPort, ep);
      if (r) return r;
    }
    return null;
  }

  /** 主进程裸直连（核心未运行时的本地出口）。 */
  private queryDirect(): Promise<IpInfo | null> {
    return this.queryDirectChain((ep) => this.bare(ep));
  }

  private httpJson(options: http.RequestOptions): Promise<IpInfo | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: IpInfo | null) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };

      const req = http.get({ ...options, timeout: REQ_TIMEOUT_MS }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        // 任何提前关闭（含下面 oversize destroy）都兜底 done(null)，防 promise 永挂死整条刷新链
        res.on('close', () => done(null));
        res.on('data', (c) => {
          body += c;
          // 防异常大响应（如劫持页/portal/WAF 的大 HTML）。必须带 error 参数，否则 destroy() 不发
          // error/end 事件 → done 永不调用 → enqueue 的 inflight 永挂、IP 卡永久转圈（review P1）。
          if (body.length > 8192) req.destroy(new Error('oversize'));
        });
        res.on('end', () => {
          try {
            const j = JSON.parse(body) as Record<string, unknown>;
            // ip-api：{status:'success', query, country, countryCode}
            if (j && j.status === 'success' && typeof j.query === 'string') {
              done({
                ip: j.query,
                country: typeof j.country === 'string' ? j.country : undefined,
                countryCode: typeof j.countryCode === 'string' ? j.countryCode : undefined,
              });
              return;
            }
            // ipip：{ret:'ok', data:{ip, location:[国,省,市,区,ISP]}}
            if (j && j.ret === 'ok' && j.data && typeof j.data === 'object') {
              const d = j.data as { ip?: unknown; location?: unknown };
              if (typeof d.ip === 'string') {
                const raw = Array.isArray(d.location)
                  ? d.location.filter((s): s is string => typeof s === 'string')
                  : [];
                const parts = raw.filter((s) => s.length > 0);
                done({
                  ip: d.ip,
                  country: parts.length ? parts.join(' ') : undefined,
                  countryCode: ccFromIpipLocation(raw),
                });
                return;
              }
            }
            // ipify：{ip}
            if (j && typeof j.ip === 'string') {
              done({ ip: j.ip });
              return;
            }
            done(null);
          } catch {
            done(null);
          }
        });
      });

      req.on('error', () => done(null));
      req.on('timeout', () => {
        req.destroy();
        done(null);
      });
    });
  }
}
