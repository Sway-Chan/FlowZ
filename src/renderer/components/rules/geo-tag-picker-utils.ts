import type { RuleResourceCatalogItem } from '../../../shared/types';

/**
 * 从规则资源 catalog 提取某类（geosite / geoip）的可选 tag 名（去重 + 排序）。
 *
 * 仅取**标准类**（category === kind，排除 '-lite'）：应用分流的 geo tag 在运行时恒被
 * ProxyManager.generateRouteConfig 解析为标准路径 `geo/<kind>/<tag>.srs` 的 remote rule_set，
 * 故 -lite 名无独立意义、且其裸名可能在标准路径下 404（→ sing-box `initialize rule-set` FATAL）。
 * 把可选项约束到标准 catalog 名，即从源头杜绝「手打无效分类崩整个代理」的 footgun。
 */
export function geoCategoryOptions(
  items: RuleResourceCatalogItem[],
  kind: 'geosite' | 'geoip'
): string[] {
  const names = new Set<string>();
  for (const it of items) {
    if (it.category === kind && it.name.trim()) names.add(it.name);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * 从「规则资源」列表项算出某类（geosite/geoip）已在本地的裸 tag 集合（内置随包 + 已下载，且文件存在）。
 * 用于选择器标注「本地/未下载」，以及「添加自定义应用」时判断哪些 tag 还需下载进规则资源（联动单一真值）。
 * id 形如 `builtin:geosite-youtube` / `geosite-amazon` → 去前缀得裸 tag `youtube` / `amazon`。
 */
export function localGeoTagSet(
  items: { id: string; category: string; fileExists: boolean }[],
  kind: 'geosite' | 'geoip'
): Set<string> {
  const s = new Set<string>();
  for (const it of items) {
    if (it.category !== kind || !it.fileExists) continue;
    s.add(it.id.replace(/^builtin:/, '').replace(new RegExp(`^${kind}-`), ''));
  }
  return s;
}
