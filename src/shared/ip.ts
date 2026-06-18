/**
 * IPv4 字面量判定（严格：每段 0-255）。
 *
 * 收敛 dns.ts 与 ProxyManager 的 host 分类为单一真值，杜绝「同 host 在 DNS 分类 vs route 生成
 * 判定不一致」——原 ProxyManager.isIpv4Host 用宽松正则 `[0-9]{1,3}`，会把 999.1.1.1 误判为 IPv4，
 * 与 dns.ts 的严格判定冲突。合法 IP(≤255)两者一致，仅非法>255 段输入分类被纠正。
 *
 * 刻意不收纳（语义各异、各自单一消费者，按「适度独立优于错误抽象」保留原处）：
 * - rules.isStrictIpv4：sing-box netip 校验（禁前导零，更严）
 * - system-dns.isPrivateIpv4：私网 range 判定（非形状）
 * - system-proxy-bypass.isIpv4Cidr：CIDR 形状
 * - ssrf-guard.isPrivateIp：SSRF 防护（含回环/link-local/IPv4-mapped）
 */
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** 主机字符串是否为严格 IPv4 字面量（每段 0-255）。 */
export function isIpv4(host: string): boolean {
  return IPV4_RE.test(host);
}

/** IPv4 CIDR "a.b.c.d[/n]" → [网络地址(uint32), 前缀]；非法/IPv6 → null。无 /n 视为 /32。 */
function parseIpv4Cidr(cidr: string): [number, number] | null {
  const [ipPart, prefixPart] = cidr.trim().split('/');
  const prefix = prefixPart === undefined ? 32 : Number(prefixPart);
  if (!isIpv4(ipPart) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const o = ipPart.split('.').map(Number);
  const ipInt = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [(ipInt & mask) >>> 0, prefix];
}

/** 两个 IPv4 CIDR 是否有交集（按较短前缀比对网络地址）。任一非 IPv4 CIDR → false。 */
export function ipv4CidrsOverlap(a: string, b: string): boolean {
  const pa = parseIpv4Cidr(a);
  const pb = parseIpv4Cidr(b);
  if (!pa || !pb) return false;
  const minPrefix = Math.min(pa[1], pb[1]);
  if (minPrefix === 0) return true; // 0.0.0.0/0 覆盖一切
  const mask = (0xffffffff << (32 - minPrefix)) >>> 0;
  const na = (pa[0] & mask) >>> 0;
  const nb = (pb[0] & mask) >>> 0;
  return na === nb;
}

/**
 * target CIDR 是否与候选集任一 CIDR 有交集。供路由规则与组网(WG/Tailscale)force-route 段的重叠提醒共用
 * （main 的 config-gen warn + renderer 的内联 hint/列表角标）。仅 IPv4；IPv6 段（Tailscale v6）先跳过（best-effort，TODO）。
 */
export function cidrOverlapsAny(target: string, candidates: string[]): boolean {
  return candidates.some((c) => ipv4CidrsOverlap(target, c));
}
