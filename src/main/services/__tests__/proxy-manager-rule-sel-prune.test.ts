/**
 * MED-1 单测：启动前配置校验剔除节点时，selector default 命中被剔节点的回落语义。
 *
 * 根因：rule-sel 的 default=固定目标节点；该节点被 gate（detour 死引用/校验失败）剔除时，原实现一律落
 * `outbounds[0]`=剩余**首个节点** → 固定规则被静默绑到「碰巧排第一的节点」，违背 generateRuleSelectors
 * 「目标无效→proxy-selector(跟全局)」的 anti-drift 设计意图。
 *
 * 修法：`prunedSelectorDefault` 单一真值——rule-sel-* 回 'proxy-selector'，proxy-selector/urltest 仍落首成员。
 * 两个剔除点（内联 detour 剔除循环 + pruneTagsClosure）共用此 helper。
 *
 * 私有方法经 `(svc as any).method()` 直调（跟随既有 proxy-manager 测试风格），构造仅注入 configPath/singboxPath，
 * 不启动 sing-box。
 */
import { ProxyManager } from '../ProxyManager';
import type { UserConfig } from '../../../shared/types';

function makeSvc(): any {
  return new ProxyManager(undefined as any, undefined as any, '/tmp/flowz-test-cfg.json', '/fake/sing-box');
}

/** 最小 UserConfig（pruneTagsClosure 仅读 selectedServerId；其余字段不参与本路径）。 */
function makeConfig(): UserConfig {
  return { selectedServerId: null, servers: [], customRules: [] } as unknown as UserConfig;
}

describe('ProxyManager.prunedSelectorDefault（MED-1 回落语义）', () => {
  const svc = makeSvc();

  it('rule-sel-* 回落 proxy-selector，而非剩余首节点', () => {
    expect(svc.prunedSelectorDefault('rule-sel-r1', ['jp', 'sg', 'proxy-selector'])).toBe(
      'proxy-selector'
    );
    expect(svc.prunedSelectorDefault('rule-sel-app-com.foo', ['jp', 'proxy-selector'])).toBe(
      'proxy-selector'
    );
  });

  it('proxy-selector 自身仍落剩余首节点（首存活节点是正确兜底）', () => {
    expect(svc.prunedSelectorDefault('proxy-selector', ['jp', 'sg'])).toBe('jp');
  });

  it('非 rule-sel selector（如 urltest）仍落剩余首成员', () => {
    expect(svc.prunedSelectorDefault('auto-urltest', ['jp', 'sg'])).toBe('jp');
    expect(svc.prunedSelectorDefault(undefined, ['jp'])).toBe('jp');
  });
});

describe('ProxyManager.pruneTagsClosure（MED-1 集成：剔节点后 default 回落）', () => {
  it('剔除被 rule-sel 与 proxy-selector 同时引用的目标节点 → rule-sel.default=proxy-selector / proxy-selector.default=剩余首节点', () => {
    const svc = makeSvc();
    const singboxConfig: any = {
      log: {},
      inbounds: [],
      outbounds: [
        { type: 'selector', tag: 'proxy-selector', outbounds: ['hk', 'jp'], default: 'hk' },
        {
          type: 'selector',
          tag: 'rule-sel-r1',
          outbounds: ['hk', 'jp', 'proxy-selector'],
          default: 'hk', // 固定目标=hk
        },
        { type: 'vless', tag: 'hk' },
        { type: 'vless', tag: 'jp' },
      ],
      route: { rules: [] },
    };

    // 剔除节点 hk（模拟其配置未通过启动前校验）
    (svc as any).pruneTagsClosure(singboxConfig, makeConfig(), new Set(['hk']), 'check');

    const proxySel = singboxConfig.outbounds.find((o: any) => o.tag === 'proxy-selector');
    const ruleSel = singboxConfig.outbounds.find((o: any) => o.tag === 'rule-sel-r1');

    // hk 已从 outbounds 与所有 selector 成员中剔除
    expect(singboxConfig.outbounds.some((o: any) => o.tag === 'hk')).toBe(false);
    expect(proxySel.outbounds).toEqual(['jp']);
    expect(ruleSel.outbounds).toEqual(['jp', 'proxy-selector']);

    // 核心断言：rule-sel 回 proxy-selector（跟全局），proxy-selector 落剩余首节点 jp（不漂到任意节点）
    expect(ruleSel.default).toBe('proxy-selector');
    expect(proxySel.default).toBe('jp');
  });
});
