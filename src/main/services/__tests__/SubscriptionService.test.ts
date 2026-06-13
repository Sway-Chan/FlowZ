/**
 * SubscriptionService 单测（node env）。mock electron(app/net/session) + node dns。
 * 覆盖 review 必修：
 *  - HIGH-1：JSON-Clash 0 节点 throw（不被 catch 吞 → 不 fall through 落空集）。
 *  - M5：sing-box JSON / URL-list / Base64 三分支 0 节点 throw。
 *  - partial：provider transient 失败 → partial=true（调用方 merge-only）；permanent → 不 partial。
 *  - H1（SSRF DNS rebinding）：域名解析到内网 IP → 拒绝。
 *  - H2（重定向绕过）：30x 跳到内网 → 拒绝；正常跳转过 guard 续跳。
 *  - M2：响应体积超限 → throw。
 *  - M6：日志 url 脱敏（去 query）。
 *  - vmess 指纹 parity（Clash vs ProtocolParser）。
 *  - LOW-1：provider 复用主解析；内容再嵌套 proxy-providers → warn 不递归。
 */

// ── electron mock（必须在 import SubscriptionService 之前）──────────────────────
const mockFetch = jest.fn();
const mockSetProxy = jest.fn().mockResolvedValue(undefined);
jest.mock('electron', () => ({
  app: { getVersion: () => '9.9.9' },
  net: { fetch: (...a: unknown[]) => mockFetch(...a) },
  session: {
    fromPartition: () => ({
      setProxy: mockSetProxy,
      fetch: (...a: unknown[]) => mockFetch(...a),
    }),
  },
}));

// ── node dns mock（H1 SSRF：控制解析结果）──────────────────────────────────────
const mockLookup = jest.fn();
jest.mock('dns', () => ({
  promises: { lookup: (...a: unknown[]) => mockLookup(...a) },
}));

import { SubscriptionService } from '../SubscriptionService';
import { ProtocolParser } from '../ProtocolParser';
import type { ServerConfig } from '../../../shared/types';

const SUB_ID = 'sub-x';

// LogManager 桩：仅收集日志供 M6 脱敏断言。
class FakeLog {
  entries: { level: string; message: string }[] = [];
  addLog(level: string, message: string) {
    this.entries.push({ level, message });
  }
}

/** 构造 fetch Response 桩。body 用 ReadableStream（走 readBodyCapped 流式路径）。 */
function makeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}): unknown {
  const status = opts.status ?? 200;
  const headersMap = new Map<string, string>(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const text = opts.body ?? '';
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headersMap.get(k.toLowerCase()) ?? null },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    async text() {
      return text;
    },
  };
}

function newService(log: FakeLog): SubscriptionService {
  return new SubscriptionService(new ProtocolParser(), log as never);
}

/** 默认：所有域名解析到公网 IP（不触发 SSRF 拒绝）。 */
function allowAllDns() {
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
}

beforeEach(() => {
  mockFetch.mockReset();
  mockLookup.mockReset();
  allowAllDns();
});

describe('HIGH-1 + M5 — 0 节点必须 throw（不穿仓）', () => {
  it('HIGH-1：JSON 编码 Clash 0 可用节点 → throw（不 fall through 落空集）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    // proxies 全是不支持类型 → 解析得 0 节点；JSON-Clash 分支应 throw 而非被 catch 吞。
    const body = JSON.stringify({
      proxies: [{ name: 'x', type: 'ssr', server: '1.1.1.1', port: 1 }],
    });
    mockFetch.mockResolvedValue(makeResponse({ body }));
    await expect(svc.fetchSubscription('https://sub.example.com/c', SUB_ID)).rejects.toThrow(
      /0 个可用节点/
    );
  });

  it('M5：sing-box JSON outbounds 0 节点 → throw', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const body = JSON.stringify({ outbounds: [{ type: 'direct', tag: 'd' }] }); // 无受支持节点
    mockFetch.mockResolvedValue(makeResponse({ body }));
    await expect(svc.fetchSubscription('https://sub.example.com/sb', SUB_ID)).rejects.toThrow(
      /sing-box 订阅解析得到 0/
    );
  });

  it('M5：URL-list 全不可解析 → throw', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockFetch.mockResolvedValue(makeResponse({ body: 'notaurl://garbage\nmailto:x@y' }));
    await expect(svc.fetchSubscription('https://sub.example.com/u', SUB_ID)).rejects.toThrow(
      /0 个可用节点|无法识别/
    );
  });

  it('M5：Base64 解码后 0 节点 → throw', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const b64 = Buffer.from('ssr://unsupported\n', 'utf-8').toString('base64');
    mockFetch.mockResolvedValue(makeResponse({ body: b64 }));
    await expect(svc.fetchSubscription('https://sub.example.com/b', SUB_ID)).rejects.toThrow(
      /0 个可用节点|无法识别/
    );
  });

  it('正常 JSON-Clash 有节点 → 不 throw，返回 servers', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const body = JSON.stringify({
      proxies: [{ name: 'ok', type: 'vless', server: '1.2.3.4', port: 443, uuid: 'u' }],
    });
    mockFetch.mockResolvedValue(makeResponse({ body }));
    const r = await svc.fetchSubscription('https://sub.example.com/c', SUB_ID);
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0].protocol).toBe('vless');
  });
});

describe('partial → merge-only（reconcile 不删 leftover）', () => {
  it('provider transient 失败 → partial=true', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    // 主订阅：内联 1 节点 + 1 个 http provider；provider fetch 抛错（transient）。
    const main = JSON.stringify({
      proxies: [{ name: 'inline', type: 'vless', server: '1.1.1.1', port: 443, uuid: 'a' }],
      'proxy-providers': { p1: { type: 'http', url: 'https://prov.example.com/p1' } },
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('prov.example.com')) throw new Error('HTTP Error: 503');
      return makeResponse({ body: main });
    });
    const r = await svc.fetchSubscription('https://sub.example.com/c', SUB_ID);
    expect(r.partial).toBe(true);
    expect(r.servers.map((s) => s.name)).toContain('inline');
  });

  it('reconcile：partial 时 deletedIds 的 leftover 保留（merge-only）', () => {
    const old: ServerConfig[] = [
      { id: 'old1', name: 'keep', protocol: 'vless', address: '1.1.1.1', port: 443, uuid: 'a' },
      { id: 'old2', name: 'gone', protocol: 'vless', address: '2.2.2.2', port: 443, uuid: 'b' },
    ];
    // 新抓取只含 old1 指纹 → old2 进 deletedIds。
    const fetched: ServerConfig[] = [
      {
        id: 'newx',
        name: 'keep-renamed',
        protocol: 'vless',
        address: '1.1.1.1',
        port: 443,
        uuid: 'a',
      },
    ];
    const { servers, deletedIds } = SubscriptionService.reconcileServers(old, fetched, 'NOW');
    expect(deletedIds.has('old2')).toBe(true);
    // reconcile 命中保留旧 id（old1），名字以新值（keep-renamed）为准。
    expect(servers.map((s) => s.id)).toEqual(['old1']);
    expect(servers[0].name).toBe('keep-renamed');
    // 模拟 handler 的 merge-only：partial 时把 leftover 加回 → old2 不删。
    const leftover = old.filter((s) => deletedIds.has(s.id));
    const finalKeep = [...servers, ...leftover];
    expect(finalKeep.map((s) => s.id).sort()).toEqual(['old1', 'old2']);
  });

  it('M1：leftoverToKeep 按 provider 精确——只留失败 provider 名下的下架节点', () => {
    const old: ServerConfig[] = [
      {
        id: 'a',
        name: 'failP',
        protocol: 'vless',
        address: '1.1.1.1',
        port: 1,
        uuid: 'a',
        providerName: 'P_fail',
      },
      {
        id: 'b',
        name: 'okP',
        protocol: 'vless',
        address: '2.2.2.2',
        port: 2,
        uuid: 'b',
        providerName: 'P_ok',
      },
      { id: 'c', name: 'legacy', protocol: 'vless', address: '3.3.3.3', port: 3, uuid: 'c' },
    ];
    const deletedIds = new Set(['a', 'b', 'c']);
    // 失败 provider(P_fail) 名下 → 保留；成功 provider(P_ok) 真下架 → 删；undefined 归属（迁移前/内联）→ 保守保留。
    const kept = SubscriptionService.leftoverToKeep(old, deletedIds, ['P_fail']);
    expect(kept.map((s) => s.id).sort()).toEqual(['a', 'c']);
  });

  it('M1：failedProviders 空/缺（partial 但失败名未知）→ 全保守保留（退回整订阅级）', () => {
    const old: ServerConfig[] = [
      {
        id: 'a',
        name: 'x',
        protocol: 'vless',
        address: '1.1.1.1',
        port: 1,
        uuid: 'a',
        providerName: 'P_ok',
      },
      { id: 'b', name: 'y', protocol: 'vless', address: '2.2.2.2', port: 2, uuid: 'b' },
    ];
    const deletedIds = new Set(['a', 'b']);
    expect(
      SubscriptionService.leftoverToKeep(old, deletedIds, [])
        .map((s) => s.id)
        .sort()
    ).toEqual(['a', 'b']);
    expect(
      SubscriptionService.leftoverToKeep(old, deletedIds, undefined)
        .map((s) => s.id)
        .sort()
    ).toEqual(['a', 'b']);
  });

  it('M1：仅作用于 deletedIds——未删除的节点不进 leftover', () => {
    const old: ServerConfig[] = [
      {
        id: 'a',
        name: 'x',
        protocol: 'vless',
        address: '1.1.1.1',
        port: 1,
        uuid: 'a',
        providerName: 'P_fail',
      },
    ];
    expect(SubscriptionService.leftoverToKeep(old, new Set<string>(), ['P_fail'])).toEqual([]);
  });
});

describe('H1 SSRF DNS rebinding', () => {
  it('域名解析到 127.0.0.1 → 拒绝（不发 fetch）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    mockFetch.mockResolvedValue(makeResponse({ body: '' }));
    await expect(svc.fetchSubscription('https://evil.example.com/c', SUB_ID)).rejects.toThrow(
      /本机\/内网\/link-local/
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('域名解析到 169.254.169.254（云元数据）→ 拒绝', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(svc.fetchSubscription('https://metadata.example.com/c', SUB_ID)).rejects.toThrow(
      /本机\/内网\/link-local/
    );
  });

  it('域名解析到内网 10.x → 拒绝', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    await expect(svc.fetchSubscription('https://x.example.com/c', SUB_ID)).rejects.toThrow(
      /本机\/内网/
    );
  });

  it('多解析结果含一个内网 IP → 拒绝（逐 IP 校验）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.0.5', family: 4 },
    ]);
    await expect(svc.fetchSubscription('https://x.example.com/c', SUB_ID)).rejects.toThrow(
      /本机\/内网/
    );
  });

  it('字面内网 IP host（localhost/127.0.0.1）直接拒（不查 DNS）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    await expect(svc.fetchSubscription('http://127.0.0.1:9090/c', SUB_ID)).rejects.toThrow(
      /本机\/内网/
    );
    await expect(svc.fetchSubscription('http://localhost/c', SUB_ID)).rejects.toThrow(/本机\/内网/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('解析到公网 IP → 放行', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    const body = JSON.stringify({
      proxies: [{ name: 'ok', type: 'vless', server: '1.2.3.4', port: 443, uuid: 'u' }],
    });
    mockFetch.mockResolvedValue(makeResponse({ body }));
    const r = await svc.fetchSubscription('https://ok.example.com/c', SUB_ID);
    expect(r.servers).toHaveLength(1);
  });
});

describe('isPrivateIp — IPv4-mapped IPv6 / fe80::/10 残留绕过', () => {
  // private static，单元直测：覆盖 hex/展开形 mapped + fe80 全段（assertHostAllowed 经它判定）。
  const isPrivateIp = (ip: string): boolean =>
    (SubscriptionService as unknown as { isPrivateIp(ip: string): boolean }).isPrivateIp(ip);

  it('IPv4-mapped hex / 展开 / 点分 各写法的内网地址 → BLOCK', () => {
    // 127.0.0.1
    expect(isPrivateIp('::ffff:7f00:1')).toBe(true);
    expect(isPrivateIp('0:0:0:0:0:ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('0:0:0:0:0:ffff:7f00:1')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    // 10.0.0.1
    expect(isPrivateIp('::ffff:0a00:0001')).toBe(true);
    // 192.168.1.1
    expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateIp('::ffff:c0a8:0101')).toBe(true);
  });

  it('IPv4-mapped 公网地址 → ALLOW（按内嵌 IPv4 判，8.8.8.8 放行）', () => {
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIp('::ffff:0808:0808')).toBe(false);
  });

  it('fe80::/10 全段（fe80–febf）link-local → BLOCK', () => {
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fe9a::1')).toBe(true);
    expect(isPrivateIp('fea0::1')).toBe(true);
    expect(isPrivateIp('feb0::1')).toBe(true);
    expect(isPrivateIp('febf::1')).toBe(true);
  });

  it('fec0:: 起（site-local，超出 fe80–febf）→ 不被 fe80 规则误命中', () => {
    // fec0::/10 非 link-local（且已废弃）；本规则不应把它算 link-local。
    expect(isPrivateIp('fec0::1')).toBe(false);
  });

  it('回环 / ULA → BLOCK', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('::')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12:3456::1')).toBe(true);
  });

  it('公网 IPv6 → ALLOW', () => {
    expect(isPrivateIp('2001:db8::1')).toBe(false);
    expect(isPrivateIp('2606:4700::1')).toBe(false);
  });
});

describe('H2 重定向绕过', () => {
  it('30x 跳到内网域名 → 拒绝（重定向目标过 guard）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    // 首跳：公网；Location 指向内网域名 → 第二次 lookup 返回内网。
    mockLookup.mockImplementation(async (host: string) => {
      if (host === 'inner.example.com') return [{ address: '10.0.0.9', family: 4 }];
      return [{ address: '93.184.216.34', family: 4 }];
    });
    mockFetch.mockResolvedValueOnce(
      makeResponse({ status: 302, headers: { location: 'https://inner.example.com/c' } })
    );
    await expect(svc.fetchSubscription('https://entry.example.com/c', SUB_ID)).rejects.toThrow(
      /本机\/内网/
    );
  });

  it('30x 跳到公网 → 续跳并返回最终内容', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const body = JSON.stringify({
      proxies: [{ name: 'final', type: 'vless', server: '1.2.3.4', port: 443, uuid: 'u' }],
    });
    mockFetch
      .mockResolvedValueOnce(
        makeResponse({ status: 301, headers: { location: 'https://cdn.example.com/real' } })
      )
      .mockResolvedValueOnce(makeResponse({ body }));
    const r = await svc.fetchSubscription('https://entry.example.com/c', SUB_ID);
    expect(r.servers.map((s) => s.name)).toEqual(['final']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('重定向次数超过上限 → 拒绝', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    // 始终 302 自跳 → 触发 MAX_REDIRECTS。
    mockFetch.mockResolvedValue(
      makeResponse({ status: 302, headers: { location: 'https://loop.example.com/next' } })
    );
    await expect(svc.fetchSubscription('https://loop.example.com/c', SUB_ID)).rejects.toThrow(
      /重定向次数超过上限/
    );
  });
});

describe('M2 体积上限', () => {
  it('content-length 预检超限 → 拒绝', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockFetch.mockResolvedValue(
      makeResponse({ headers: { 'content-length': String(20 * 1024 * 1024) }, body: 'x' })
    );
    await expect(svc.fetchSubscription('https://big.example.com/c', SUB_ID)).rejects.toThrow(
      /体积.*超过上限/
    );
  });

  it('读取后字节超限（content-length 缺失）→ 拒绝', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    // 11MB body，无 content-length → readBodyCapped 累计超限 abort。
    const huge = 'a'.repeat(11 * 1024 * 1024);
    mockFetch.mockResolvedValue(makeResponse({ body: huge }));
    await expect(svc.fetchSubscription('https://big.example.com/c', SUB_ID)).rejects.toThrow(
      /体积.*超过上限/
    );
  });
});

describe('M6 日志 url 脱敏', () => {
  it('正在拉取/失败日志去 query（不落 token）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockFetch.mockResolvedValue(makeResponse({ body: 'notaurl://x' })); // 触发 0 节点 throw
    await expect(
      svc.fetchSubscription('https://sub.example.com/c?token=SECRET123', SUB_ID)
    ).rejects.toThrow();
    const joined = log.entries.map((e) => e.message).join('\n');
    expect(joined).not.toContain('SECRET123');
    expect(joined).toContain('正在拉取订阅');
    expect(joined).toContain('<redacted>');
  });
});

describe('vmess 指纹 parity（Clash vs ProtocolParser）', () => {
  it('vmess 四元组全等（经 fetchSubscription 走 Clash 解析）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const body = JSON.stringify({
      proxies: [{ name: 'vm', type: 'vmess', server: '5.5.5.5', port: 443, uuid: 'VM-UUID' }],
    });
    mockFetch.mockResolvedValue(makeResponse({ body }));
    const r = await svc.fetchSubscription('https://sub.example.com/c', SUB_ID);
    const clash = r.servers[0];
    const url = new ProtocolParser().parseUrl(
      'vmess://' +
        Buffer.from(
          JSON.stringify({
            v: '2',
            add: '5.5.5.5',
            port: '443',
            id: 'VM-UUID',
            aid: '0',
            net: 'tcp',
            ps: 'vm',
          })
        ).toString('base64')
    );
    const four = (s: ServerConfig) => [
      (s.protocol || '').toLowerCase(),
      s.address,
      s.port,
      s.uuid || s.password || '',
    ];
    expect(four(clash)).toEqual(four(url));
  });
});

describe('LOW-1 provider 复用主解析 — 嵌套 proxy-providers 不递归 + warn', () => {
  it('provider 内容再含 proxy-providers → 只取内联 + warn（不递归）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const main = JSON.stringify({
      'proxy-providers': { p1: { type: 'http', url: 'https://prov.example.com/p1' } },
    });
    // provider 响应：内联 1 节点 + 嵌套 proxy-providers（应被 allowProviders:false 拦下，仅 warn）。
    const provBody = JSON.stringify({
      proxies: [{ name: 'prov-node', type: 'vless', server: '3.3.3.3', port: 443, uuid: 'c' }],
      'proxy-providers': { nested: { type: 'http', url: 'https://prov.example.com/nested' } },
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/p1')) return makeResponse({ body: provBody });
      if (url.includes('/nested')) throw new Error('不应被请求（嵌套不递归）');
      return makeResponse({ body: main });
    });
    const r = await svc.fetchSubscription('https://sub.example.com/c', SUB_ID);
    expect(r.servers.map((s) => s.name)).toEqual(['prov-node']);
    const joined = log.entries.map((e) => e.message).join('\n');
    expect(joined).toMatch(/再嵌套 proxy-providers|不递归/);
  });
});
