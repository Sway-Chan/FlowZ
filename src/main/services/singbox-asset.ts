/**
 * 从 GitHub release assets 中挑选适配 (platform, arch) 的 sing-box 构建。
 * 纯函数：平台/架构由参数注入（不读 process），无 electron 依赖 → 可独立单测。
 * 从 CoreUpdateService.findSuitableAsset 抽出，行为逐字保留。
 */

/**
 * 挑选逻辑：
 *  1. 先按平台关键词(windows/darwin/linux) + 架构关键词(amd64/arm64) + 后缀(平台默认 ext 或 .zip) 过滤；
 *  2. 在命中集合内按优先级取：① 含 with-naive/full（带 naive 出站）② 非 legacy ③ 首个命中。
 * 无任何命中返回 undefined。
 */
export function findSuitableSingboxAsset(
  assets: any[],
  platform: NodeJS.Platform,
  arch: string
): any {
  let keyword = '';
  let ext = '';

  if (platform === 'win32') {
    keyword = 'windows';
    ext = '.zip';
  } else if (platform === 'darwin') {
    keyword = 'darwin';
    ext = '.tar.gz'; // 通常是 tar.gz 或者 zip
  } else if (platform === 'linux') {
    keyword = 'linux';
    ext = '.tar.gz';
  }

  let archKeyword = '';
  if (arch === 'x64') {
    archKeyword = 'amd64';
  } else if (arch === 'arm64') {
    archKeyword = 'arm64';
  }

  // 优先查找包含特定架构的
  const filteredAssets = assets.filter(
    (a: any) =>
      a.name.toLowerCase().includes(keyword) &&
      a.name.toLowerCase().includes(archKeyword) &&
      (a.name.endsWith(ext) || a.name.endsWith('.zip'))
  );

  if (filteredAssets.length === 0) return undefined;

  // 优先顺序：
  // 1. 包含 with-naive 或 full 的版本 (针对 Windows)
  // 2. 不含 legacy 的版本
  // 3. 其他匹配项
  const preferred = filteredAssets.find(
    (a: any) => a.name.toLowerCase().includes('with-naive') || a.name.toLowerCase().includes('full')
  );
  if (preferred) return preferred;

  const nonLegacy = filteredAssets.find((a: any) => !a.name.toLowerCase().includes('legacy'));
  if (nonLegacy) return nonLegacy;

  return filteredAssets[0];
}
