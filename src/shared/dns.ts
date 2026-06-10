/**
 * 用户自定义 DNS 地址解析（供主进程生成 sing-box dns server + 渲染端校验共用）。
 * 支持 https:// (DoH) / tls:// (DoT) / udp:// / 裸 IP 字面量；裸域名（无 scheme）语义歧义，判非法。
 */
export interface ParsedDnsServer {
  type: 'https' | 'tls' | 'udp';
  /** 主机名或 IP（IPv6 去方括号） */
  server: string;
  port: number;
  /** 仅 https，默认 /dns-query */
  path?: string;
  /** server 是否为域名（决定 sing-box 是否需要 domain_resolver 引导解析） */
  isDomain: boolean;
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function isIpLiteral(host: string): boolean {
  return IPV4_RE.test(host) || host.includes(':');
}

function stripBrackets(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * 解析用户 DNS 地址字符串。无法识别（含裸域名、空串、非法）返回 null，调用方据此回退默认 + 提示。
 */
export function parseDnsServerSpec(spec: string | undefined | null): ParsedDnsServer | null {
  if (!spec) return null;
  const s = spec.trim();
  if (!s) return null;

  const fromUrl = (
    type: ParsedDnsServer['type'],
    defaultPort: number,
    withPath: boolean
  ): ParsedDnsServer | null => {
    try {
      const u = new URL(s);
      const host = stripBrackets(u.hostname);
      if (!host) return null;
      const port = u.port ? parseInt(u.port, 10) : defaultPort;
      if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
      const result: ParsedDnsServer = { type, server: host, port, isDomain: !isIpLiteral(host) };
      if (withPath) {
        result.path = u.pathname && u.pathname !== '/' ? u.pathname : '/dns-query';
      }
      return result;
    } catch {
      return null;
    }
  };

  if (s.startsWith('https://')) return fromUrl('https', 443, true);
  if (s.startsWith('tls://')) return fromUrl('tls', 853, false);
  if (s.startsWith('udp://')) return fromUrl('udp', 53, false);

  // 裸 IP 字面量 → UDP:53
  if (isIpLiteral(s)) {
    return { type: 'udp', server: s, port: 53, isDomain: false };
  }

  // 裸域名无 scheme：无法判定 DoH/DoT/UDP，判非法（避免猜错）
  return null;
}
