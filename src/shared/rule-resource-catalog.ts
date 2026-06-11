/**
 * 规则资源库（catalog）：内置精选清单（srs-only，离线回退）+ 动态刷新解析 + 自动命名。
 * 数据源 MetaCubeX/meta-rules-dat 的 sing 分支（geo/geo-lite 下的 .srs）。主进程与渲染端共用。
 */
import type { RuleResourceCatalogItem, RuleResourceCategory } from './types';

export const MRD_RAW_BASE = 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/';

/** 仓库内路径（如 'geo/geosite/youtube.srs'）→ raw 下载 URL。 */
export const mrdRawUrl = (p: string): string => MRD_RAW_BASE + p;

const geosite = (name: string): RuleResourceCatalogItem => ({
  id: `geosite-${name}`,
  category: 'geosite',
  name,
  path: `geo/geosite/${name}.srs`,
});
const geoip = (name: string): RuleResourceCatalogItem => ({
  id: `geoip-${name}`,
  category: 'geoip',
  name,
  path: `geo/geoip/${name}.srs`,
});
const geositeLite = (name: string): RuleResourceCatalogItem => ({
  id: `geosite-lite-${name}`,
  category: 'geosite-lite',
  name,
  path: `geo-lite/geosite/${name}.srs`,
});
const geoipLite = (name: string): RuleResourceCatalogItem => ({
  id: `geoip-lite-${name}`,
  category: 'geoip-lite',
  name,
  path: `geo-lite/geoip/${name}.srs`,
});

/** 内置精选清单（推荐常用项；全量清单由「刷新」动态拉取）。落地前宜抽查 URL，404 由下载层兜底。 */
export const RULE_RESOURCE_CATALOG: RuleResourceCatalogItem[] = [
  // geosite（标准）
  geosite('cn'),
  geosite('geolocation-!cn'),
  geosite('category-ads-all'),
  geosite('google'),
  geosite('youtube'),
  geosite('netflix'),
  geosite('telegram'),
  geosite('twitter'),
  geosite('openai'),
  geosite('anthropic'),
  geosite('apple'),
  geosite('microsoft'),
  geosite('github'),
  geosite('steam'),
  geosite('spotify'),
  geosite('tiktok'),
  geosite('bilibili'),
  geosite('disney'),
  geosite('private'),
  // geoip（标准）
  geoip('cn'),
  geoip('us'),
  geoip('jp'),
  geoip('hk'),
  geoip('tw'),
  geoip('sg'),
  geoip('telegram'),
  geoip('netflix'),
  geoip('google'),
  geoip('cloudflare'),
  geoip('private'),
  // 精简版（推荐常驻）
  geositeLite('cn'),
  geositeLite('geolocation-!cn'),
  geoipLite('cn'),
];

export const findCatalogItem = (id: string): RuleResourceCatalogItem | undefined =>
  RULE_RESOURCE_CATALOG.find((i) => i.id === id);

/** 从下载 URL 推导资源 category 与默认 name（手动 URL 自动命名；主进程兜底与渲染端预填共用）。 */
export function deriveResourceMeta(url: string): { category: RuleResourceCategory; name: string } {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split('?')[0].split('#')[0];
  }
  const segs = pathname.split('/').filter(Boolean);
  let base = segs.length ? segs[segs.length - 1] : 'rule';
  try {
    base = decodeURIComponent(base);
  } catch {
    /* keep */
  }
  base = base.replace(/\.srs$/i, '').replace(/\.json$/i, '') || 'rule';

  // meta-rules-dat 路径 → 对应分类（含 -lite），name 复用 basename（id 与内置同 ⇒ 自然去重）
  const m = pathname.match(/\/(geo|geo-lite)\/(geosite|geoip)\//i);
  if (m) {
    const lite = m[1].toLowerCase() === 'geo-lite';
    const kind = m[2].toLowerCase(); // geosite | geoip
    const category = (lite ? `${kind}-lite` : kind) as RuleResourceCategory;
    return { category, name: base };
  }

  // asn → AS<number>
  const asn = pathname.match(/\/asn\/(AS\d+)\.srs$/i);
  if (asn) return { category: 'custom', name: asn[1].toUpperCase() };

  return { category: 'custom', name: base.replace(/[^\w.-]+/g, '_') };
}
