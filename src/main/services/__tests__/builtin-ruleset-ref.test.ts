/**
 * resolveBuiltinRuleSetRefMeta 单测（纯函数、无 FS/无网络）：
 * 验证 res:builtin:<tag> 引用 → rule_set 元数据（tag 复用 b.tag、fileName 取运行时名）。
 * 覆盖：geosite/geoip 常规、category-ai 文件名特例（-!cn 后缀）、非内置 id、未知 tag、空串。
 *
 * 这是 D（路由规则可选内置资源）的后端核心：generateCustomRules 的 res: 分支据此把用户自定义规则对内置
 * 随包 .srs 的引用解析为本地 rule_set。FS 守卫（isValidSrsFile）由调用方施加，不在此测（属集成层，真机验证）。
 */
import {
  resolveBuiltinRuleSetRefMeta,
  BUILTIN_GEO_RULESETS,
  builtinIdFor,
} from '../builtin-geo-rulesets';

describe('resolveBuiltinRuleSetRefMeta（res:builtin:<tag> 引用解析）', () => {
  it('geosite 内置 id → 复用 b.tag + 运行时文件名', () => {
    const r = resolveBuiltinRuleSetRefMeta(builtinIdFor('geosite-netflix'));
    expect(r).toEqual({ tag: 'geosite-netflix', fileName: 'geosite-netflix.srs' });
  });

  it('geoip 内置 id → 复用 b.tag + 运行时文件名', () => {
    const r = resolveBuiltinRuleSetRefMeta(builtinIdFor('geoip-netflix'));
    expect(r).toEqual({ tag: 'geoip-netflix', fileName: 'geoip-netflix.srs' });
  });

  it('category-ai 特例：tag=geosite-category-ai，文件名带 -!cn 后缀', () => {
    // MetaCubeX 裸 category-ai 不单独成 .srs，用 category-ai-!cn；tag 仍对齐 app-rule 生成（geosite-category-ai）。
    const r = resolveBuiltinRuleSetRefMeta(builtinIdFor('geosite-category-ai'));
    expect(r).toEqual({ tag: 'geosite-category-ai', fileName: 'geosite-category-ai-!cn.srs' });
  });

  it('tag 与 BUILTIN_GEO_RULESETS 单一真值一致（防漂移）', () => {
    // 每个内置项经 builtin: 前缀解析后，tag/fileName 必须与其定义一致（generateCustomRules 与 getLocalGeoRuleSets 共享）。
    for (const b of BUILTIN_GEO_RULESETS) {
      const r = resolveBuiltinRuleSetRefMeta(builtinIdFor(b.tag));
      expect(r).toEqual({ tag: b.tag, fileName: b.fileName });
    }
  });

  it('非内置 id（无 builtin: 前缀，如外置 res id）→ null', () => {
    expect(resolveBuiltinRuleSetRefMeta('geosite-google')).toBeNull();
    expect(resolveBuiltinRuleSetRefMeta('geoip-us')).toBeNull();
  });

  it('未知内置 tag（builtin: 前缀但不在 BUILTIN_GEO_RULESETS）→ null', () => {
    expect(resolveBuiltinRuleSetRefMeta('builtin:nonexistent-tag')).toBeNull();
  });

  it('空串 / 仅前缀 → null', () => {
    expect(resolveBuiltinRuleSetRefMeta('')).toBeNull();
    expect(resolveBuiltinRuleSetRefMeta('builtin:')).toBeNull();
  });
});
