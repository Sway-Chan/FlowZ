/**
 * buildCustomRules 单测（自定义路由规则生成）—— 原 ProxyManager.generateCustomRules 无单测覆盖（仅 config-snapshot
 * 集成锁字节）；抽到 singbox-custom-rules 后补纯逻辑分支：出站映射(applyRuleAction)/OR 合并/logical AND·OR/
 * fail-closed/onDegraded/legacy 告警。geosite/geoip 条件走 inline 分支（非 EXT、不触 ext 文件），避开 fs/电子路径噪声。
 */
jest.mock('electron', () => ({
  app: { getPath: () => '/fake/userData', getAppPath: () => '/fake/app', isPackaged: false },
  net: {},
}));

import { buildCustomRules, type CustomRulesDeps } from '../singbox-custom-rules';
import type { Rule } from '../../../shared/types';

function mkDeps(): CustomRulesDeps & { logs: string[]; degraded: boolean } {
  const logs: string[] = [];
  const o = {
    logs,
    degraded: false,
    log: (_l: any, m: string) => {
      logs.push(m);
    },
    onDegraded: () => {
      o.degraded = true;
    },
  };
  return o;
}

/** geosite/geoip 条件（inline，不外化）→ 干净测出站映射与 logical 结构。 */
const rule = (over: Partial<Rule>): Rule =>
  ({
    id: 'r1',
    type: 'geosite',
    values: ['youtube'],
    action: 'proxy',
    enabled: true,
    ...over,
  }) as Rule;

const idMap = new Map([['srv-2', '日本节点']]);

describe('buildCustomRules — 出站映射（applyRuleAction）', () => {
  it('proxy + 指定 ruleId → rule-sel-<id>（anti-drift，绝不直绑节点）', () => {
    const deps = mkDeps();
    const { rules } = buildCustomRules(
      [rule({ id: 'rx', action: 'proxy', targetServerId: 'srv-2' })],
      [],
      's1',
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].outbound).toBe('rule-sel-rx'); // ruleId 优先于 targetServerId（铁律）
    expect(rules[0].rule_set).toEqual(['geosite-youtube']);
  });

  it('direct → outbound=direct；block → outbound=block', () => {
    const deps = mkDeps();
    const { rules } = buildCustomRules(
      [
        rule({ id: 'd', action: 'direct', type: 'geoip', values: ['cn'] }),
        rule({ id: 'b', action: 'block' }),
      ],
      [],
      undefined,
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules.find((r) => r.rule_set?.includes('geoip-cn'))?.outbound).toBe('direct');
    expect(rules.find((r) => r.rule_set?.includes('geosite-youtube'))?.outbound).toBe('block');
  });
});

describe('buildCustomRules — 条件合并 / logical', () => {
  it('单 geosite 条件 → 单 default rule（rule_set 合并值）', () => {
    const deps = mkDeps();
    const { rules } = buildCustomRules(
      [rule({ values: ['youtube', 'netflix'] })],
      [],
      undefined,
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules[0].rule_set).toEqual(['geosite-youtube', 'geosite-netflix']);
    expect(rules[0].type).toBeUndefined(); // 单条件不走 logical
  });

  it('多条件 + combineMode=and（geosite+geoip 跨维度）→ logical AND 子规则', () => {
    const deps = mkDeps();
    const r: Rule = {
      id: 'm',
      action: 'proxy',
      enabled: true,
      combineMode: 'and',
      conditions: [
        { type: 'geosite', values: ['youtube'] },
        { type: 'geoip', values: ['us'] },
      ],
    } as unknown as Rule;
    const { rules } = buildCustomRules(
      [r],
      [],
      undefined,
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules[0].type).toBe('logical');
    expect(rules[0].mode).toBe('and');
    expect(rules[0].rules).toHaveLength(2);
    expect(rules[0].outbound).toBe('rule-sel-m');
  });

  it('禁用规则跳过', () => {
    const deps = mkDeps();
    const { rules } = buildCustomRules(
      [rule({ enabled: false })],
      [],
      undefined,
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules).toHaveLength(0);
  });
});

describe('buildCustomRules — legacy customRuleSets 告警', () => {
  it('legacy remote ruleSet（含 url）→ 仅告警、不产 rules', () => {
    const deps = mkDeps();
    const { rules, ruleSets } = buildCustomRules(
      [],
      [{ id: 'ls', enabled: true, url: 'https://x/legacy.srs' } as any],
      undefined,
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules).toHaveLength(0);
    expect(ruleSets).toHaveLength(0);
    expect(deps.logs.some((m) => m.includes('legacy 远程规则集已不再支持'))).toBe(true);
  });
});
