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
