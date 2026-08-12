/**
 * #347 出口一致性门：**FakeIP 旁路/影子域名的解析器必须与该域名的实际出口一致**。
 *
 * 判据来源是语义不是夹具：一条 DNS server 是否「经隧道解析」≡ 它有没有 `detour`
 * （dns-remote 带 detour=选中节点；dns-bootstrap / dns-domestic / dns-node-race 都没有）。
 * 不锁 tag 名 → 对「改 tag 名」「删 server」「把 dns-remote 的 detour 摘掉」全部有牙，并顺带覆盖
 * `sing-box check` 无牙的悬空 server 引用（find 返回 undefined 时先炸）。
 *
 * 违反该不变量的后果就是 issue #347 那一类：境内递归解析出的 decoy 地址被原样送进隧道，
 * 或反过来隧道视角的地址走直连。本文件的红/绿分布在改前代码上验证过（bypass/filter/resolve 三组为红）。
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-exit-consistency-'));
jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import type { ServerConfig, UserConfig } from '../../../shared/types';
import { BUILTIN_GEO_RULESETS, getRuleSetRuntimeDir } from '../builtin-geo-rulesets';

// 与生产一致：先 seed .srs 再生成 config（fail-closed 只在文件真缺失时触发）。
// smart 模式三件套与 dns-resolver.test.ts 同口径，避免引入无关的 geosite-private 直连规则；
// telegram 两件套只为 INV-EXIT-5 的 geosite 腿供料——baseConfig 的 appRoutingEnabled=false 使
// effectiveAppRules 返回 []，这两个 tag 不被任何规则引用，对其余用例惰性。
{
  const SMART_GEO_TAGS = new Set([
    'geosite-cn',
    'geosite-geolocation-!cn',
    'geoip-cn',
    'geosite-telegram',
    'geoip-telegram',
  ]);
  const geoDir = getRuleSetRuntimeDir();
  fs.mkdirSync(geoDir, { recursive: true });
  for (const b of BUILTIN_GEO_RULESETS) {
    if (SMART_GEO_TAGS.has(b.tag))
      fs.writeFileSync(path.join(geoDir, b.fileName), Buffer.from('SRS'));
  }
}

type AnyCfg = any;

const NODE: ServerConfig = {
  id: 'n1',
  name: '出口A',
  protocol: 'vless' as ServerConfig['protocol'],
  address: 'a.example.com',
  port: 443,
  uuid: '00000000-0000-0000-0000-00000000000a',
} as ServerConfig;

function baseConfig(over: Partial<UserConfig> = {}): UserConfig {
  return {
    subscriptions: [],
    servers: [NODE],
    selectedServerId: 'n1',
    proxyMode: 'smart',
    proxyModeType: 'tun',
    tunConfig: { mtu: 1350, stack: 'system', autoRoute: true, strictRoute: true },
    customRules: [],
    customRuleSets: [],
    appRules: [],
    appRoutingEnabled: false,
    enableIPv6: false,
    dnsConfig: {
      domesticDns: 'https://doh.pub/dns-query',
      foreignDns: 'https://dns.google/dns-query',
      enableFakeIp: true,
    },
    mixedPort: 7890,
    controlPort: 9090,
    logLevel: 'info',
    disableLogFile: false,
    clashApiSecret: 'fixedsecret0000000000000000000000',
    uiTheme: 'system',
    ...over,
  } as unknown as UserConfig;
}

/**
 * #347 默认关之后：凡是验证 resolve 及其配套影子规则的用例，夹具必须**显式打开**开关。
 * 默认档（未设）由 INV-EXIT-3 的 3a 单独钉住 = 不注入。
 */
function resolveOn(over: Partial<UserConfig> = {}): UserConfig {
  return baseConfig({ resolveDestination: true, ...over } as Partial<UserConfig>);
}

/** FakeIP 关档：存量 systemProxy 用户的默认态（ConfigManager 迁移把 enableFakeIp 冻结为 false）。 */
const FAKEIP_OFF = {
  domesticDns: 'https://doh.pub/dns-query',
  foreignDns: 'https://dns.google/dns-query',
  enableFakeIp: false,
} as unknown as UserConfig['dnsConfig'];

/**
 * 出口一致性不变量必须在 FakeIP 开/关**两档**都成立。
 * 谓词撤掉 usesFakeIp 前置门后，「FakeIP 关 + 开关开」从不可达变为可达，且恰是存量 systemProxy 用户的默认态；
 * 夹具只覆盖 FakeIP 开档 = 新格零判据，把「影子规则漏发、直连域名改由隧道解析」整类缺陷放过去。
 */
const FAKEIP_ARMS: Array<[string, Partial<UserConfig>]> = [
  ['FakeIP 开', {}],
  ['FakeIP 关', { dnsConfig: FAKEIP_OFF } as Partial<UserConfig>],
];

const pm = new ProxyManager();
const gen = (c: UserConfig): AnyCfg => pm.generateSingBoxConfig(c) as AnyCfg;
const dnsRules = (cfg: AnyCfg): AnyCfg[] => (cfg.dns.rules || []) as AnyCfg[];
const routeRules = (cfg: AnyCfg): AnyCfg[] => (cfg.route?.rules || []) as AnyCfg[];

/** 该 tag 的 DNS server 是否经隧道解析（有 detour）。tag 必须存在——悬空引用 sing-box check 无牙。 */
function isTunnelResolver(cfg: AnyCfg, tag: string): boolean {
  const s = (cfg.dns.servers as AnyCfg[]).find((x) => x.tag === tag);
  expect(s).toBeDefined();
  return !!s.detour;
}
/** 一条 DNS 规则是否覆盖 token（exact / 后缀 / 关键字三种承载形态）。 */
function covers(r: AnyCfg, token: string): boolean {
  const d: string[] = r.domain ?? [];
  const s: string[] = r.domain_suffix ?? [];
  const k: string[] = r.domain_keyword ?? [];
  return d.includes(token) || s.some((x) => x === token || x === `.${token}`) || k.includes(token);
}
const rulesCovering = (cfg: AnyCfg, token: string): AnyCfg[] =>
  dnsRules(cfg).filter((r) => covers(r, token));

const proxyRule = (id: string, values: string[]) => ({
  id,
  type: 'domainSuffix',
  values,
  action: 'proxy',
  enabled: true,
  bypassFakeIP: true,
});
const directRule = (id: string, values: string[]) => ({
  id,
  type: 'domainSuffix',
  values,
  action: 'direct',
  enabled: true,
  bypassFakeIP: true,
});

describe('#347 出口一致性 — 门自检（判据非平凡）', () => {
  const cfg = gen(baseConfig());

  it('dns-remote 有 detour（隧道解析）、dns-domestic 无（境内解析）', () => {
    expect(isTunnelResolver(cfg, 'dns-remote')).toBe(true);
    expect(isTunnelResolver(cfg, 'dns-domestic')).toBe(false);
    expect(isTunnelResolver(cfg, 'dns-bootstrap')).toBe(false);
  });

  it('引用闭合：dns.rules[].server 全部存在于 dns.servers[].tag（check 对悬空引用无牙）', () => {
    const tags = new Set((cfg.dns.servers as AnyCfg[]).map((s) => s.tag));
    for (const r of dnsRules(cfg)) {
      if (typeof r.server === 'string') expect(tags).toContain(r.server);
    }
  });
});

describe('#347 INV-EXIT-1 — bypassFakeIP 按规则去向选解析器', () => {
  const cfg = gen(
    baseConfig({
      customRules: [
        proxyRule('r-proxy', ['epochtimes.com']),
        directRule('r-direct', ['intranet.example.com']),
      ] as unknown as UserConfig['customRules'],
    })
  );

  it('1a 去向=代理 → 覆盖它的每条 DNS 规则都必须经隧道解析', () => {
    const hits = rulesCovering(cfg, 'epochtimes.com');
    expect(hits.length).toBeGreaterThan(0);
    for (const r of hits) expect(isTunnelResolver(cfg, r.server)).toBe(true);
  });

  it('1b 去向=直连 → 覆盖它的每条 DNS 规则都必须非隧道解析（负向对照）', () => {
    const hits = rulesCovering(cfg, 'intranet.example.com');
    expect(hits.length).toBeGreaterThan(0);
    for (const r of hits) expect(isTunnelResolver(cfg, r.server)).toBe(false);
  });
});

describe('#347 INV-EXIT-2 — FakeIP 排除清单按出口选解析器', () => {
  const list = ['wise.com', 'cn.bing.com'];

  it('2a global 模式（出口恒代理）→ 清单域名恒经隧道解析', () => {
    const cfg = gen(baseConfig({ proxyMode: 'global', fakeIpFilterList: list }));
    const hits = rulesCovering(cfg, 'wise.com');
    expect(hits.length).toBeGreaterThan(0);
    for (const r of hits) expect(isTunnelResolver(cfg, r.server)).toBe(true);
  });

  it('2b smart 模式 → 非隧道腿只允许出现在带 rule_set 的那条上，且必须真有一条隧道腿（反平凡）', () => {
    const cfg = gen(baseConfig({ proxyMode: 'smart', fakeIpFilterList: list }));
    const hits = rulesCovering(cfg, 'wise.com');
    expect(hits.length).toBeGreaterThan(0);
    for (const r of hits) {
      if (!isTunnelResolver(cfg, r.server)) expect(r.rule_set).toBeDefined();
    }
    expect(hits.some((r) => isTunnelResolver(cfg, r.server))).toBe(true);
  });

  it('2c captive 桶恒非隧道解析（要的是本地网络视角，负向对照）', () => {
    const cfg = gen(baseConfig({ fakeIpFilterList: [...list, 'captive.apple.com'] }));
    const hits = rulesCovering(cfg, 'captive.apple.com');
    expect(hits.length).toBeGreaterThan(0);
    for (const r of hits) expect(isTunnelResolver(cfg, r.server)).toBe(false);
  });
});

describe('#347 INV-EXIT-3 — resolve 规则的注入条件', () => {
  const countResolve = (cfg: AnyCfg): number =>
    routeRules(cfg).filter((r) => r.action === 'resolve').length;

  it('3a FakeIP 开 + 开关默认（未设）→ 不注入（默认关）', () => {
    expect(countResolve(gen(baseConfig()))).toBe(0);
  });

  it('3a2 开关显式开 → 注入恰好一条 resolve（正向对照）', () => {
    expect(countResolve(gen(resolveOn()))).toBe(1);
  });

  it('3b 开关显式关 → 不注入', () => {
    expect(countResolve(gen(baseConfig({ resolveDestination: false })))).toBe(0);
  });

  it('3c FakeIP 关 + 开关显式开 → 仍注入（mixed-in 入站无条件发射，其目的地恒为域名）', () => {
    expect(countResolve(gen(resolveOn({ dnsConfig: FAKEIP_OFF })))).toBe(1);
  });

  it('3c2 FakeIP 关 + 开关默认（未设）→ 不注入（默认关仍是唯一总闸）', () => {
    expect(countResolve(gen(baseConfig({ dnsConfig: FAKEIP_OFF })))).toBe(0);
  });

  it('3d direct 模式 → 不注入（出口恒直连）', () => {
    expect(countResolve(gen(resolveOn({ proxyMode: 'direct' })))).toBe(0);
  });

  it('3e resolve 带的 server（若有）必须闭合到已定义的 dns server', () => {
    const cfg = gen(resolveOn());
    const tags = new Set((cfg.dns.servers as AnyCfg[]).map((s) => s.tag));
    for (const r of routeRules(cfg).filter((x) => x.action === 'resolve')) {
      if (typeof r.server === 'string') expect(tags).toContain(r.server);
    }
  });
});

describe('#347 INV-ORDER — resolve 的位置不变量', () => {
  const cfg = gen(
    resolveOn({
      customRules: [
        proxyRule('r-proxy', ['epochtimes.com']),
      ] as unknown as UserConfig['customRules'],
    })
  );
  const rules = routeRules(cfg);
  const idxResolve = rules.findIndex((r) => r.action === 'resolve');

  it('resolve 存在', () => {
    expect(idxResolve).toBeGreaterThanOrEqual(0);
  });

  it('必须在探测/更新入站的终止规则之后（它们绝不能被 resolve 影响）', () => {
    // 探测/测速/更新的 inbound 端口是运行期分配的私有状态，默认 null → 那批 inbound 与其 route 规则根本不发射。
    // 直接置入端口才能让这条断言有牙；否则它是恒真的空检查（门在但没牙）。
    const probePm = new ProxyManager() as unknown as Record<string, unknown>;
    probePm.probeDirectPort = 34101;
    probePm.probeProxyPort = 34102;
    probePm.probePoolPorts = [34111, 34112];
    probePm.updateInPort = 34121;
    const probeCfg = (probePm as unknown as ProxyManager).generateSingBoxConfig(
      resolveOn({
        customRules: [
          proxyRule('r-proxy', ['epochtimes.com']),
        ] as unknown as UserConfig['customRules'],
      })
    ) as AnyCfg;
    const probeRules = routeRules(probeCfg);
    const idxProbeResolve = probeRules.findIndex((r) => r.action === 'resolve');
    expect(idxProbeResolve).toBeGreaterThanOrEqual(0);
    const inboundKeyed = probeRules
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => Array.isArray(r.inbound) || typeof r.inbound === 'string');
    // 正向对照：端口置入后这批规则必须真的出现，否则断言退化为空检查
    expect(inboundKeyed.length).toBeGreaterThan(0);
    for (const { i } of inboundKeyed) expect(i).toBeLessThan(idxProbeResolve);
  });

  it('必须在节点域名排除规则之后（节点域名不该再经隧道解析）', () => {
    const idxNode = rules.findIndex(
      (r) => Array.isArray(r.domain) && r.domain.includes(NODE.address)
    );
    expect(idxNode).toBeGreaterThanOrEqual(0);
    expect(idxNode).toBeLessThan(idxResolve);
  });

  it('必须在网银/U盾强制直连之后（这些域名公网不存在，resolve 失败会硬断连接）', () => {
    const idxBank = rules.findIndex(
      (r) =>
        Array.isArray(r.domain_suffix) &&
        r.domain_suffix.some((d: string) => d.includes('microdone'))
    );
    expect(idxBank).toBeGreaterThanOrEqual(0);
    expect(idxBank).toBeLessThan(idxResolve);
  });

  it('必须在 bootstrap DNS 直连之后（否则解析到这些 IP 的域名会被反向吸成直连）', () => {
    const idxBootstrap = rules.findIndex(
      (r) => Array.isArray(r.ip_cidr) && r.outbound === 'direct' && Array.isArray(r.port)
    );
    expect(idxBootstrap).toBeGreaterThanOrEqual(0);
    expect(idxBootstrap).toBeLessThan(idxResolve);
  });

  it('必须在自定义规则之前（那些是终止规则，排其后则 smart 模式永远走不到 resolve）', () => {
    const idxCustom = rules.findIndex(
      (r) =>
        Array.isArray(r.domain_suffix) &&
        r.domain_suffix.some((d: string) => d.includes('epochtimes.com'))
    );
    expect(idxCustom).toBeGreaterThanOrEqual(0);
    // 必须显式要求 resolve 存在：否则 idxResolve=-1 时 `-1 < idxCustom` 恒真，这条退化成空检查。
    expect(idxResolve).toBeGreaterThanOrEqual(0);
    expect(idxResolve).toBeLessThan(idxCustom);
  });
});

describe('#347 INV-TTL — fakeip 合成应答下发 TTL', () => {
  const cfg = gen(baseConfig());

  it('fakeip catch-all 带 rewrite_ttl=60，且其余 dns.rules 一条都不带（全量对账）', () => {
    const withTtl = dnsRules(cfg).filter((r) => r.rewrite_ttl !== undefined);
    expect(withTtl).toHaveLength(1);
    expect(withTtl[0].server).toBe('fakeip');
    expect(withTtl[0].rewrite_ttl).toBe(60);
  });
});

describe('#347 INV-S0 — 影子规则的 geo 二分必须与 route 侧同门控', () => {
  it('global 模式不得出现「带 region-local geo rule_set 且解析器非隧道」的 DNS 规则', () => {
    const cfg = gen(baseConfig({ proxyMode: 'global' }));
    const bad = dnsRules(cfg).filter((r) => {
      const rs = Array.isArray(r.rule_set) ? r.rule_set : r.rule_set ? [r.rule_set] : [];
      if (!rs.some((t: string) => t === 'geosite-cn')) return false;
      return typeof r.server === 'string' && !isTunnelResolver(cfg, r.server);
    });
    expect(bad).toHaveLength(0);
  });

  it('smart 模式仍保留该腿（正向对照，防把门写成恒真）', () => {
    const cfg = gen(baseConfig({ proxyMode: 'smart' }));
    const good = dnsRules(cfg).filter((r) => {
      const rs = Array.isArray(r.rule_set) ? r.rule_set : r.rule_set ? [r.rule_set] : [];
      return rs.some((t: string) => t === 'geosite-cn');
    });
    expect(good.length).toBeGreaterThan(0);
  });
});

describe.each(FAKEIP_ARMS)(
  '#347 INV-EXIT-4 — 出口影子规则：route 强制直连的自定义域名不得落到隧道解析器（%s）',
  (_arm, arm) => {
    // bypassFakeIP=false（默认值）：不进 bypass 桶 → 只能靠出口影子规则兜底。
    // 用 bypassFakeIP=true 的夹具在原理上测不出它：bypass 桶那条（无 query_type、排在 fakeip catch-all
    // 之前）先命中，影子规则那条对该域名不可达 —— 判据会被夹具喂饱而恒绿。
    const cfg = gen(
      resolveOn({
        customRules: [
          {
            id: 'r-fd',
            type: 'domainSuffix',
            values: ['forcedirect.example'],
            action: 'direct',
            enabled: true,
            bypassFakeIP: false,
          },
        ] as unknown as UserConfig['customRules'],
        ...arm,
      })
    );

    it('4a 正向对照：route 侧确实把它强制直连（否则下面两条是空检查）', () => {
      const idx = routeRules(cfg).findIndex(
        (r) =>
          Array.isArray(r.domain_suffix) &&
          (r.domain_suffix as string[]).some((d: string) => d.includes('forcedirect.example')) &&
          r.outbound === 'direct'
      );
      expect(idx).toBeGreaterThanOrEqual(0);
    });

    it('4b 内核 dial-time lookup（allowFakeIP=false）首命中的非 fakeip 规则必须是非隧道解析器', () => {
      const first = dnsRules(cfg).find(
        (r) => r.server !== 'fakeip' && covers(r, 'forcedirect.example')
      );
      expect(first).toBeDefined();
      expect(isTunnelResolver(cfg, first.server)).toBe(false);
    });

    it('4c 必须排在无域名判据的隧道 catch-all 之前（否则该腿永远走不到）', () => {
      const rs = dnsRules(cfg);
      const idxShadow = rs.findIndex(
        (r) => r.server !== 'fakeip' && covers(r, 'forcedirect.example')
      );
      const idxCatchAll = rs.findIndex(
        (r) =>
          typeof r.server === 'string' &&
          isTunnelResolver(cfg, r.server) &&
          !r.domain &&
          !r.domain_suffix &&
          !r.domain_keyword &&
          !r.rule_set &&
          !r.process_name
      );
      expect(idxShadow).toBeGreaterThanOrEqual(0);
      expect(idxCatchAll).toBeGreaterThanOrEqual(0);
      expect(idxShadow).toBeLessThan(idxCatchAll);
    });
  }
);

describe.each(FAKEIP_ARMS)(
  '#347 INV-EXIT-5 — 应用分流强制直连 → 两条腿都必须非隧道解析（%s）',
  (_arm, arm) => {
    // 判据用差分（开/关应用分流的同配置之差），零夹具依赖：防环/DNS-客户端那批 process_name→direct
    // 在两侧都有、自动抵消。直接取「所有 process_name→direct」会过采集，在未变异代码上就红。
    const cfg = gen(
      resolveOn({
        appRoutingEnabled: true,
        appRules: [{ appId: 'telegram', action: 'direct', enabled: true }],
        ...arm,
      } as unknown as Partial<UserConfig>)
    );
    const off = gen(resolveOn({ ...arm }));

    it('5a process_name 腿', () => {
      const procsOf = (c: AnyCfg): Set<string> => {
        const out = new Set<string>();
        for (const r of routeRules(c))
          if (r.outbound === 'direct' && Array.isArray(r.process_name))
            for (const p of r.process_name as string[]) out.add(p);
        return out;
      };
      const baseProcs = procsOf(off);
      const added = [...procsOf(cfg)].filter((p) => !baseProcs.has(p));
      expect(added.length).toBeGreaterThan(0); // 正向对照
      for (const p of added) {
        const leg = dnsRules(cfg).find(
          (r) => Array.isArray(r.process_name) && (r.process_name as string[]).includes(p)
        );
        expect(leg).toBeDefined();
        expect(isTunnelResolver(cfg, leg.server)).toBe(false);
      }
    });

    it('5b geosite 腿', () => {
      const geoOf = (c: AnyCfg): Set<string> => {
        const out = new Set<string>();
        for (const r of routeRules(c)) {
          if (r.outbound !== 'direct') continue;
          const rs = Array.isArray(r.rule_set) ? r.rule_set : r.rule_set ? [r.rule_set] : [];
          for (const t of rs) if (String(t).startsWith('geosite-')) out.add(String(t));
        }
        return out;
      };
      const baseGeo = geoOf(off);
      const added = [...geoOf(cfg)].filter((t) => !baseGeo.has(t));
      expect(added.length).toBeGreaterThan(0); // 正向对照
      for (const tag of added) {
        const leg = dnsRules(cfg).find((r) => {
          const rs = Array.isArray(r.rule_set) ? r.rule_set : r.rule_set ? [r.rule_set] : [];
          return rs.includes(tag);
        });
        expect(leg).toBeDefined();
        expect(isTunnelResolver(cfg, leg.server)).toBe(false);
      }
    });
  }
);

describe.each(FAKEIP_ARMS)(
  '#347 INV-EXIT-7 — 出口影子规则与 route 侧用户分流同门控：global 一条都不得发（%s）',
  (_arm, arm) => {
    // 与 INV-S0 同根因。global 是真·全局、route 侧 buildCustomRules 与应用分流都在 `proxyMode === 'smart'`
    // 块内不执行，出口恒是代理；此时 DNS 侧若还为「用户标了直连」的域名拐向境内解析器，就是把境内视角地址
    // 送进隧道 —— route 侧根本没有对应的 direct 去向。
    const cfgOf = (proxyMode: string) =>
      gen(
        resolveOn({
          proxyMode,
          customRules: [
            {
              id: 'r-g',
              type: 'domainSuffix',
              values: ['forcedirect.example'],
              action: 'direct',
              enabled: true,
              bypassFakeIP: false,
            },
          ] as unknown as UserConfig['customRules'],
          ...arm,
        } as unknown as Partial<UserConfig>)
      );

    it('7a global：route 侧确实没有该域名的直连规则（正向对照，否则 7b 是空检查）', () => {
      const cfg = cfgOf('global');
      const hit = routeRules(cfg).find(
        (r) =>
          Array.isArray(r.domain_suffix) &&
          (r.domain_suffix as string[]).some((d: string) => d.includes('forcedirect.example'))
      );
      expect(hit).toBeUndefined();
    });

    it('7b global：DNS 侧不得出现覆盖该域名的非隧道解析规则', () => {
      const cfg = cfgOf('global');
      for (const r of rulesCovering(cfg, 'forcedirect.example')) {
        if (r.server === 'fakeip') continue;
        expect(isTunnelResolver(cfg, r.server)).toBe(true);
      }
    });

    it('7c smart 仍必须发（负向对照，防把门写成恒假）', () => {
      const cfg = cfgOf('smart');
      const first = dnsRules(cfg).find(
        (r) => r.server !== 'fakeip' && covers(r, 'forcedirect.example')
      );
      expect(first).toBeDefined();
      expect(isTunnelResolver(cfg, first.server)).toBe(false);
    });
  }
);

describe('#347 INV-EXIT-6 — 出口已整体回退 direct 时不得注入 resolve', () => {
  // dns-remote 的 detour 恒 'proxy-selector'（buildDnsConfig 的 selectedServerTag 由 ProxyManager 硬编码
  // 传入，不跟随 route 侧的 exitFallback）。此时注入 resolve = 把每条连接的目的解析打进被 cryptokey
  // routing 丢弃的组网节点 → 超时 fatalErr → 全量断网。没有这条门，打不打 B1 补丁全量测试都是绿。
  const meshNode = {
    id: 'm1',
    name: 'MeshWG',
    protocol: 'wireguard',
    address: 'wg.example.com',
    port: 51820,
    wireguardSettings: {
      privateKey: 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk=',
      peerPublicKey: 'ppppppppppppppppppppppppppppppppppppppppppp=',
      localAddress: ['10.8.0.2/32'],
      allowedIPs: ['10.8.0.0/24'],
      allowInternet: false,
    },
  } as unknown as ServerConfig;

  for (const mode of ['smart', 'global'] as const) {
    it(`${mode}：exitFallback 已把出口整体回退直连，resolve 必须缺席`, () => {
      const cfg = gen(
        resolveOn({ servers: [NODE, meshNode], selectedServerId: 'm1', proxyMode: mode })
      );
      expect(cfg.route.final).toBe('direct'); // 正向对照：夹具确实触发了 exitFallback
      expect(routeRules(cfg).filter((r) => r.action === 'resolve')).toHaveLength(0);
    });
  }

  it('正向对照：同配置换成承载全隧道的节点时 resolve 照常注入', () => {
    const full = {
      ...(meshNode as AnyCfg),
      id: 'm2',
      wireguardSettings: {
        ...(meshNode as AnyCfg).wireguardSettings,
        allowedIPs: ['0.0.0.0/0'],
        allowInternet: true,
      },
    } as unknown as ServerConfig;
    const cfg = gen(resolveOn({ servers: [NODE, full], selectedServerId: 'm2' }));
    expect(cfg.route.final).not.toBe('direct');
    expect(routeRules(cfg).filter((r) => r.action === 'resolve')).toHaveLength(1);
  });
});
