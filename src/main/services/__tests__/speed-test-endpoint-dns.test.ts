/**
 * 测速临时 config 的「端点目标解析」单测（纯 config 生成，无网络）。
 * 端点(WG/WARP)是 L3、目标域名必被本地解析：默认 dns-direct 从本机解析 → 本机 geo IP、端点出口够不着 → 超时/失真。
 * 修复(单形态):端点目标解析经 inbound 键控 dns.rule 定向到「穿本节点隧道」的 223.5.5.5(AliDNS 有大陆节点 + ECS,
 * 按出口地理返 IP → 境外/国内出口都对；1.1.1.1 因 anycast 无大陆 PoP、国内出口反挂,故用 223.5.5.5)。
 * 验:端点单入站、穿隧道 dns server(223.5.5.5/detour)、inbound 键控 dns.rule(disable_cache)、纯代理零变化。
 *
 * 2026-07 迁移(sing-box 1.14.0):rule-action 的 legacy `strategy` 已废弃(run 时 WARN、1.16.0 移除),且与同一份
 * dns 配置内任何 query_type/ip_version 规则**互斥**(共存 → run 与 check 双双 FATAL)。改用 query_type 规则项表达:
 *   · 旧 prefer_ipv4 → 不下发任何东西(本配置无顶层 dns.strategy,内核默认并发 A/AAAA 且 v4 排前,实测同序)
 *   · 旧 ipv4_only  → 该 inbound 的 AAAA 前置一条 predefined 空 NOERROR(AAAA 就地返空不出网,实测逐字节等价)
 * 本文件用 toEqual 锁精确形状 + 显式锁顺序/顶层无 strategy —— 顺序反了抑制静默失效(实测反证),
 * 顶层加了 strategy 则「省略 == prefer_ipv4」的等价前提被破坏。
 */
import { SpeedTestService } from '../SpeedTestService';

const mockLog = { addLog: () => {} } as unknown as ConstructorParameters<
  typeof SpeedTestService
>[0];

type Usable = { server: Record<string, unknown>; tag: string; outbound: Record<string, unknown> };
function gen(usable: Usable[], exitPorts: number[]) {
  const svc = new SpeedTestService(mockLog) as unknown as {
    generateProxyTestConfig: (u: Usable[], exit: Map<string, number>) => Record<string, any>;
  };
  const serverPortMap = new Map(usable.map((u, i) => [u.server.id as string, exitPorts[i]]));
  return svc.generateProxyTestConfig(usable, serverPortMap);
}
const wg = (id: string, localAddress: string[]): Usable => ({
  server: { id, name: 'WARP', protocol: 'wireguard', wireguardSettings: { localAddress } },
  tag: `out-${id.slice(0, 8)}`,
  outbound: { type: 'wireguard', tag: `out-${id.slice(0, 8)}` },
});
const vless = (id: string): Usable => ({
  server: { id, name: 'HK', protocol: 'vless' },
  tag: `out-${id.slice(0, 8)}`,
  outbound: { type: 'vless', tag: `out-${id.slice(0, 8)}`, uuid: 'x' },
});

describe('测速临时 config:端点目标解析穿隧道 223.5.5.5（单形态）', () => {
  it('WG 端点:单入站 + 穿隧道 223.5.5.5 dns server(detour) + inbound 键控 dns.rule(AAAA 抑制 + 禁缓存)', () => {
    const cfg = gen([wg('wgnode01', ['172.16.0.2/32'])], [21001]);
    expect(cfg.inbounds.map((i: any) => i.tag)).toEqual(['http-in-wgnode01']); // 单入站(无 local 兜底)
    expect(cfg.endpoints).toHaveLength(1); // WG 进 endpoints[]
    expect(cfg.route.rules.filter((r: any) => r.outbound === 'out-wgnode01')).toHaveLength(1);
    // 穿隧道 DNS server(223.5.5.5，detour 指向本端点 tag)
    expect(cfg.dns.servers.find((s: any) => s.tag === 'dns-exit-wgnode01')).toMatchObject({
      server: '223.5.5.5',
      detour: 'out-wgnode01',
    });
    // 纯 v4 localAddress(旧 ipv4_only):AAAA 抑制规则必须**在前**,route catch-all 在后
    expect(cfg.dns.rules).toEqual([
      {
        inbound: ['http-in-wgnode01'],
        query_type: ['AAAA'],
        action: 'predefined',
        rcode: 'NOERROR',
      },
      {
        inbound: ['http-in-wgnode01'],
        action: 'route',
        server: 'dns-exit-wgnode01',
        disable_cache: true,
      },
    ]);
  });

  it('WG localAddress 含 v6(旧 prefer_ipv4)→ 只有 route 规则、无 AAAA 抑制、无 strategy', () => {
    const cfg = gen([wg('wgnodv61', ['172.16.0.2/32', '2606:4700::1/128'])], [21001]);
    expect(cfg.dns.rules).toEqual([
      {
        inbound: ['http-in-wgnodv61'],
        action: 'route',
        server: 'dns-exit-wgnodv61',
        disable_cache: true,
      },
    ]);
  });

  it('全仓禁 legacy rule-action strategy:与 query_type 共存即 sing-box 启动/check FATAL', () => {
    const cfg = gen(
      [wg('wgnode01', ['172.16.0.2/32']), wg('wgnodv61', ['172.16.0.2/32', 'fd00::2/128'])],
      [21001, 21003]
    );
    // 1.14 硬不兼容:同一份 dns 配置里 query_type/ip_version 与 legacy strategy 不能共存。
    // 本配置确实带 query_type(下条断言防空集平凡通过)→ 任何 strategy 复活都会炸核。
    expect(cfg.dns.rules.some((r: any) => 'query_type' in r)).toBe(true);
    expect(cfg.dns.rules.filter((r: any) => 'strategy' in r)).toEqual([]);
    // 顶层 dns.strategy 恒不下发:它是「省略 prefer_ipv4 == prefer_ipv4」等价性的前提
    expect('strategy' in cfg.dns).toBe(false);
  });

  it('多端点混合(纯v4 + 含v6):按节点各自成组,抑制规则恒排在同 inbound 的 route 规则之前', () => {
    const cfg = gen(
      [wg('wgnode01', ['172.16.0.2/32']), wg('wgnodv61', ['172.16.0.2/32', 'fd00::2/128'])],
      [21001, 21003]
    );
    expect(cfg.dns.rules).toEqual([
      {
        inbound: ['http-in-wgnode01'],
        query_type: ['AAAA'],
        action: 'predefined',
        rcode: 'NOERROR',
      },
      {
        inbound: ['http-in-wgnode01'],
        action: 'route',
        server: 'dns-exit-wgnode01',
        disable_cache: true,
      },
      {
        inbound: ['http-in-wgnodv61'],
        action: 'route',
        server: 'dns-exit-wgnodv61',
        disable_cache: true,
      },
    ]);
    // 顺序不变量显式化:抑制规则若排到本 inbound 的 route(catch-all)之后,AAAA 会先被 route 吃掉、抑制静默失效
    const idx = (p: (r: any) => boolean) => cfg.dns.rules.findIndex(p);
    const sup = idx((r: any) => r.inbound?.[0] === 'http-in-wgnode01' && r.action === 'predefined');
    const route = idx((r: any) => r.inbound?.[0] === 'http-in-wgnode01' && r.action === 'route');
    expect(sup).toBeGreaterThanOrEqual(0);
    expect(sup).toBeLessThan(route);
  });

  it('纯代理配置:无 dns.rules、单入站、无 endpoints、进 outbounds', () => {
    const cfg = gen([vless('vlessn01')], [21001]);
    expect(cfg.dns.rules).toBeUndefined();
    expect(cfg.inbounds).toHaveLength(1);
    expect(cfg.inbounds[0].tag).toBe('http-in-vlessn01');
    expect(cfg.endpoints).toBeUndefined();
    expect(cfg.outbounds.some((o: any) => o.tag === 'out-vlessn01')).toBe(true);
  });

  it('混合:代理条目零变化(单入站/无 dns.rule),仅端点有 dns.rule', () => {
    const cfg = gen([vless('vlessn01'), wg('wgnode01', ['172.16.0.2/32'])], [21001, 21003]);
    // 只端点有 dns.rule(代理入站一条不发);端点两条=AAAA 抑制 + route
    expect(cfg.dns.rules.map((r: any) => r.inbound[0])).toEqual([
      'http-in-wgnode01',
      'http-in-wgnode01',
    ]);
    expect(cfg.inbounds.find((i: any) => i.tag === 'http-in-vlessn01').listen_port).toBe(21001);
    expect(cfg.inbounds.map((i: any) => i.tag).sort()).toEqual([
      'http-in-vlessn01',
      'http-in-wgnode01',
    ]);
  });

  it('DNS A 响应解析：压缩 answer name + A 记录 → resolved IP', () => {
    const qname = Buffer.from([
      3, 119, 119, 119, 7, 103, 115, 116, 97, 116, 105, 99, 3, 99, 111, 109, 0,
    ]); // www.gstatic.com
    const question = Buffer.concat([qname, Buffer.from([0, 1, 0, 1])]);
    const answer = Buffer.from([
      0xc0,
      0x0c, // name pointer to question
      0x00,
      0x01, // A
      0x00,
      0x01, // IN
      0x00,
      0x00,
      0x00,
      0x3c, // TTL
      0x00,
      0x04, // rdlength
      203,
      0,
      113,
      7,
    ]);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x1234, 0);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(1, 6);
    const response = Buffer.concat([header, question, answer]);

    expect((SpeedTestService as any).parseDnsAResponse(response)).toEqual(['203.0.113.7']);
  });
});
