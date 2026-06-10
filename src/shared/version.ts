/**
 * sing-box 版本解析的单一权威。
 *
 * 历史问题：配置生成层（ProxyManager）曾用 `parseFloat("1." + minor)` 判断版本带，
 * 这会把 minor 当小数 —— "1.9" → 1.9 被误判为 > 1.13，"1.20" → 1.2 被误判为 < 1.13。
 * 核心更新层（CoreUpdateService）则早已用整数编码避开该坑。此模块把两边统一到整数编码。
 */

/**
 * 把版本字符串编码为可比较整数 major*1000+minor。
 *   "1.20.3" → 1020、"v1.13.13" → 1013、"1.9.0" → 1009
 * 无法解析返回 NaN。容忍前导 `v` 与任意后缀（"-beta"/"+naive" 等）。
 */
export function encodeMajorMinor(version: string): number {
  const m = version.match(/^v?(\d+)\.(\d+)/);
  return m ? parseInt(m[1], 10) * 1000 + parseInt(m[2], 10) : NaN;
}

/**
 * 判断核心版本是否 ≥ major.minor。
 * @param fallback 无法解析时的返回值。默认 true —— 打包核心恒 ≥1.13.13、
 *   且 getCoreVersion 解析失败也兜底返回 "1.13.0"，故"未知"按现代版本处理最安全。
 */
export function coreVersionAtLeast(
  version: string,
  major: number,
  minor: number,
  fallback = true
): boolean {
  const v = encodeMajorMinor(version);
  if (isNaN(v)) return fallback;
  return v >= major * 1000 + minor;
}
