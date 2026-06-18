/**
 * sing-box 内核「官方 vs 第三方 fork」判定（纯函数，可单测；main/renderer 共用单一真值）。
 *
 * 唯一可靠强信号 = `sing-box version` 第一行的版本字符串后缀：fork 刻意在 git tag 打标识
 * （-reF1nd / -nekolsd / -nekolsd-test）。Tags 行不可靠（reF1nd 的 Tags 与官方同构、snell 无条件
 * 编入不产生 with_snell tag），Revision 离线无法比对。判定细节与边界见
 * docs/design/nonofficial-core-update-guard.md §1。
 */

export type CoreBuildKind = 'official' | 'fork' | 'unknown';

// 官方所有合法 version 形态（read_tag 产出：release 剥 v 的纯 semver；dev = base + '-' + 短 commit hex）。
const OFFICIAL_RELEASE = /^\d+\.\d+\.\d+$/;
const OFFICIAL_PRERELEASE = /^\d+\.\d+\.\d+-(alpha|beta|rc)\.\d+$/;
// 短 commit hex 大小写不敏感（个别构建工具链会大写 hash）：避免官方 dev 构建被误判 fork。
const OFFICIAL_DEV = /^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?-[0-9a-fA-F]{7,}$/;

/** 从 `sing-box version` 第一行（或裸 token）提取版本 token（剥前缀 v，到空白为止）。 */
export function extractVersionToken(versionLine: string): string {
  if (!versionLine || typeof versionLine !== 'string') return '';
  const s = versionLine.trim();
  if (!s) return '';
  // "sing-box version <token>" → token；否则取首个空白分隔 token。
  const m = s.match(/version\s+(\S+)/i);
  const tok = m ? m[1] : s.split(/\s+/)[0];
  return (tok || '').replace(/^v/i, '').trim();
}

/**
 * 判定内核构建来源。
 *  - official：纯 semver / 官方预发布(-alpha|beta|rc.N) / 官方 dev(base + '-' + 7+hex 短 commit)。
 *    手动上传的官方跨版本（任意 X.Y.Z）零误报——规则不依赖具体版本号。
 *  - unknown：token 为 'unknown' 或无法解析为 X.Y.Z 开头（go install / 源码自建——官方也会 unknown，不硬判 fork）。
 *  - fork：以 X.Y.Z 开头但带非官方后缀（含非 hex 字母词，如 -reF1nd / -nekolsd）。
 */
export function classifyCoreBuild(versionLine: string): CoreBuildKind {
  const tok = extractVersionToken(versionLine);
  if (!tok || tok.toLowerCase() === 'unknown') return 'unknown';
  if (OFFICIAL_RELEASE.test(tok) || OFFICIAL_PRERELEASE.test(tok) || OFFICIAL_DEV.test(tok)) {
    return 'official';
  }
  // 非 X.Y.Z 开头 = 脏输入/无法解析 → unknown（不误判 fork）。
  if (!/^\d+\.\d+\.\d+/.test(tok)) return 'unknown';
  return 'fork';
}
