import { geoCategoryOptions, localGeoTagSet } from '../geo-tag-picker-utils';
import type { RuleResourceCatalogItem } from '../../../../shared/types';

const item = (
  category: RuleResourceCatalogItem['category'],
  name: string
): RuleResourceCatalogItem => ({
  id: `${category}-${name}`,
  category,
  name,
  path: `geo/${name}.srs`,
});

describe('geoCategoryOptions', () => {
  const catalog: RuleResourceCatalogItem[] = [
    item('geosite', 'youtube'),
    item('geosite', 'apple'),
    item('geoip', 'cn'),
    item('geoip', 'us'),
    item('geosite-lite', 'cn'), // -lite 应被排除
    item('geoip-lite', 'cn'), // -lite 应被排除
    item('custom', 'whatever'), // 非 geo 应被排除
  ];

  it('按 kind 过滤（geosite 只回 geosite 标准类）', () => {
    expect(geoCategoryOptions(catalog, 'geosite')).toEqual(['apple', 'youtube']);
  });

  it('按 kind 过滤（geoip 只回 geoip 标准类）', () => {
    expect(geoCategoryOptions(catalog, 'geoip')).toEqual(['cn', 'us']);
  });

  it('排除 -lite 与非 geo 类（防无效/404 分类）', () => {
    const names = geoCategoryOptions(catalog, 'geosite');
    expect(names).not.toContain('whatever');
    // geosite-lite 的 'cn' 不应混入 geosite 选项
    expect(geoCategoryOptions(catalog, 'geosite')).not.toContain('cn');
  });

  it('去重同名并按字母排序', () => {
    const dup = [item('geosite', 'youtube'), item('geosite', 'apple'), item('geosite', 'youtube')];
    expect(geoCategoryOptions(dup, 'geosite')).toEqual(['apple', 'youtube']);
  });

  it('空 catalog → 空数组', () => {
    expect(geoCategoryOptions([], 'geosite')).toEqual([]);
  });
});

describe('localGeoTagSet', () => {
  const list = [
    { id: 'builtin:geosite-youtube', category: 'geosite', fileExists: true }, // 内置随包
    { id: 'geosite-amazon', category: 'geosite', fileExists: true }, // 已下载
    { id: 'geosite-pending', category: 'geosite', fileExists: false }, // 记录在但文件缺失 → 不算本地
    { id: 'builtin:geoip-netflix', category: 'geoip', fileExists: true },
    { id: 'res_123', category: 'custom', fileExists: true }, // 非 geo → 忽略
  ];

  it('内置 + 已下载（文件存在）的 geosite 裸 tag', () => {
    expect(localGeoTagSet(list, 'geosite')).toEqual(new Set(['youtube', 'amazon']));
  });

  it('按 kind 取 geoip', () => {
    expect(localGeoTagSet(list, 'geoip')).toEqual(new Set(['netflix']));
  });

  it('文件缺失项不计入（与路由生成 isValidSrsFile 对齐：缺失回落远程）', () => {
    expect(localGeoTagSet(list, 'geosite').has('pending')).toBe(false);
  });

  it('空列表 → 空集', () => {
    expect(localGeoTagSet([], 'geosite').size).toBe(0);
  });
});
