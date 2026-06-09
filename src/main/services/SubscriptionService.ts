import { randomUUID } from 'crypto';
import { net } from 'electron';
import type { ServerConfig, SubscriptionConfig } from '../../shared/types';
import { ProtocolParser } from './ProtocolParser';
import { LogManager } from './LogManager';

export interface SubscriptionUpdateResult {
  success: boolean;
  addedServers: number;
  updatedServers: number;
  deletedServers: number;
  error?: string;
  userInfo?: SubscriptionConfig['userInfo'];
}

// ── Sing-box outbound types we support ──────────────────────────────────────
type SingboxTls = {
  enabled?: boolean;
  server_name?: string;
  insecure?: boolean;
  alpn?: string[];
  utls?: { enabled?: boolean; fingerprint?: string };
  reality?: { enabled?: boolean; public_key?: string; short_id?: string };
  ech?: { enabled?: boolean };
  fragment?: boolean;
};
type SingboxTransport = {
  type?: string;
  path?: string;
  host?: string;
  headers?: Record<string, string>;
  service_name?: string;
};
type SingboxMultiplex = {
  enabled?: boolean;
  protocol?: string;
  max_connections?: number;
  min_streams?: number;
  padding?: boolean;
};
type SingboxOutbound = {
  type: string;
  tag: string;
  server?: string;
  server_port?: number;
  server_ports?: string[];
  hop_interval?: string;
  uuid?: string;
  flow?: string;
  packet_encoding?: string;
  username?: string;
  password?: string;
  method?: string;
  plugin?: string;
  plugin_opts?: string;
  obfs?: { type?: string; password?: string };
  // naive：是否启用 HTTP/3 (QUIC) 传输
  quic?: boolean;
  tls?: SingboxTls;
  transport?: SingboxTransport;
  multiplex?: SingboxMultiplex;
};

export class SubscriptionService {
  private protocolParser: ProtocolParser;
  private logManager: LogManager;

  constructor(protocolParser: ProtocolParser, logManager: LogManager) {
    this.protocolParser = protocolParser;
    this.logManager = logManager;
  }

  /**
   * 解析 Subscription-UserInfo header
   * 格式: upload=xxx; download=xxx; total=xxx; expire=xxx
   */
  private parseUserInfo(header: string | null): SubscriptionConfig['userInfo'] | undefined {
    if (!header) return undefined;
    const result: SubscriptionConfig['userInfo'] = {};
    const parts = header.split(';').map((s) => s.trim());
    for (const part of parts) {
      const [key, value] = part.split('=').map((s) => s.trim());
      const num = parseInt(value, 10);
      if (isNaN(num)) continue;
      if (key === 'upload') result.upload = num;
      else if (key === 'download') result.download = num;
      else if (key === 'total') result.total = num;
      else if (key === 'expire') result.expire = num;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  /**
   * 将 sing-box outbounds 数组转换为 ServerConfig 列表
   * 支持: shadowsocks, vless, trojan, hysteria2
   */
  private parseSingboxOutbounds(
    outbounds: SingboxOutbound[],
    subscriptionId: string
  ): ServerConfig[] {
    const SUPPORTED = new Set(['shadowsocks', 'vless', 'trojan', 'hysteria2', 'naive']);
    const servers: ServerConfig[] = [];
    const now = new Date().toISOString();

    for (const ob of outbounds) {
      if (!SUPPORTED.has(ob.type)) continue;
      // 支持仅含 server_ports（端口跳跃、无 server_port）的 Hy2 节点：从首个范围的低位端口推导 port
      const effectivePort =
        ob.server_port ??
        (ob.server_ports?.[0] ? parseInt(ob.server_ports[0].split(':')[0], 10) : undefined);
      if (!ob.server || !effectivePort) continue;

      try {
        const base: Partial<ServerConfig> = {
          id: randomUUID(),
          name: ob.tag || `${ob.server}:${effectivePort}`,
          address: ob.server,
          port: effectivePort,
          subscriptionId,
          createdAt: now,
          updatedAt: now,
        };

        // vless/vmess UDP 封装：JSON 订阅显式携带时透传（缺省时不写，由 ProxyManager 默认 xudp）
        if (ob.packet_encoding !== undefined) {
          base.packetEncoding = ob.packet_encoding;
        }

        // TLS / Reality
        if (ob.tls && ob.tls.enabled !== false) {
          const hasReality = ob.tls.reality?.enabled && ob.tls.reality.public_key;
          base.security = hasReality ? 'reality' : 'tls';
          base.tlsSettings = {
            serverName: ob.tls.server_name,
            allowInsecure: ob.tls.insecure ?? false,
            alpn: ob.tls.alpn,
            fingerprint: ob.tls.utls?.fingerprint,
            ech: ob.tls.ech?.enabled === true ? true : undefined,
            fragment: ob.tls.fragment === true ? true : undefined,
          };
          if (hasReality && ob.tls.reality) {
            base.realitySettings = {
              publicKey: ob.tls.reality.public_key!,
              shortId: ob.tls.reality.short_id,
            };
          }
        }

        // Transport
        if (ob.transport?.type) {
          const t = ob.transport;
          const netType = t.type as 'ws' | 'grpc' | 'http' | 'httpupgrade' | 'tcp';
          base.network = netType;
          if (netType === 'ws') {
            // 与 httpupgrade 对齐：transport.host 折叠进 Host header（部分配置把 ws Host 放在 t.host），
            // 避免同一节点经 JSON 订阅 vs 分享链解析出不一致的 wsSettings（丢 Host）。
            base.wsSettings = { path: t.path, headers: t.host ? { Host: t.host } : t.headers };
          } else if (netType === 'grpc') {
            base.grpcSettings = { serviceName: t.service_name };
          } else if (netType === 'http') {
            base.httpSettings = { path: t.path };
          } else if (netType === 'httpupgrade') {
            // httpupgrade 复用 ws 设置承载 path/Host
            base.wsSettings = { path: t.path, headers: t.host ? { Host: t.host } : t.headers };
          }
        }

        // Multiplex（vless/trojan/vmess/ss）
        if (ob.multiplex?.enabled) {
          base.multiplexSettings = {
            enabled: true,
            protocol: (ob.multiplex.protocol as 'smux' | 'yamux' | 'h2mux') || 'h2mux',
            maxConnections: ob.multiplex.max_connections,
            minStreams: ob.multiplex.min_streams,
            padding: ob.multiplex.padding,
          };
        }

        // Protocol-specific
        if (ob.type === 'shadowsocks') {
          servers.push({
            ...(base as ServerConfig),
            protocol: 'shadowsocks',
            shadowsocksSettings: {
              method: ob.method ?? 'aes-256-gcm',
              password: ob.password ?? '',
              plugin: ob.plugin,
              pluginOptions: ob.plugin_opts,
            },
          });
        } else if (ob.type === 'vless') {
          servers.push({
            ...(base as ServerConfig),
            protocol: 'vless',
            uuid: ob.uuid ?? '',
            flow: ob.flow,
          });
        } else if (ob.type === 'trojan') {
          servers.push({
            ...(base as ServerConfig),
            protocol: 'trojan',
            password: ob.password ?? '',
          });
        } else if (ob.type === 'hysteria2') {
          const hy2: ServerConfig = {
            ...(base as ServerConfig),
            protocol: 'hysteria2',
            password: ob.password ?? '',
            security: 'tls',
          };
          const hy2Settings: NonNullable<ServerConfig['hysteria2Settings']> = {};
          if (ob.obfs?.type === 'salamander' && ob.obfs.password) {
            hy2Settings.obfs = { type: 'salamander', password: ob.obfs.password };
          }
          // 端口跳跃：server_ports 形如 ["20000:30000"]，存为逗号分隔字符串
          if (ob.server_ports && ob.server_ports.length > 0) {
            hy2Settings.serverPorts = ob.server_ports.join(',');
            if (ob.hop_interval) hy2Settings.hopInterval = ob.hop_interval;
          }
          if (Object.keys(hy2Settings).length > 0) {
            hy2.hysteria2Settings = hy2Settings;
          }
          servers.push(hy2);
        } else if (ob.type === 'naive') {
          // sing-box naive 的 quic:true 表示走 HTTP/3 (QUIC) 传输（h3 节点）
          servers.push({
            ...(base as ServerConfig),
            protocol: 'naive',
            username: ob.username ?? '',
            password: ob.password ?? '',
            naiveSettings: ob.quic ? { useHttp3: true } : undefined,
          });
        }
      } catch (e: any) {
        this.logManager.addLog(
          'warn',
          `解析 sing-box outbound "${ob.tag}" 失败: ${e.message}`,
          'Subscription'
        );
      }
    }
    return servers;
  }

  /** 订阅地址主机是否指向本机/内网/link-local（字面 IP 兜底，拦云元数据/回环/内网）。 */
  private isBlockedSubscriptionHost(hostname: string): boolean {
    const h = hostname.replace(/^\[|\]$/g, '').toLowerCase(); // 去 IPv6 方括号
    if (h === 'localhost') return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (a === 0 || a === 127) return true; // 本机/通配
      if (a === 10) return true; // 私网
      if (a === 192 && b === 168) return true; // 私网
      if (a === 172 && b >= 16 && b <= 31) return true; // 私网
      if (a === 169 && b === 254) return true; // link-local / 云元数据 169.254.169.254
      if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    }
    // IPv6 字面量必含冒号——用它把主机名（如 fcm.googleapis.com / fd-cdn.net）排除在 fc/fd ULA 判断外
    if (h.includes(':')) {
      if (h === '::1' || h === '::') return true; // 回环 / 通配
      if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local / ULA
    }
    return false;
  }

  /**
   * 拉取并解析订阅 URL，返回 ServerConfig 列表。
   * 支持三种格式:
   *   1. Sing-box JSON (带 outbounds 数组) — GlaDOS /singbox/ 等
   *   2. 明文 URL 列表 (每行一个 vless:// / ss:// / trojan:// ...)
   *   3. Base64 编码的 URL 列表
   */
  async fetchSubscription(
    url: string,
    subscriptionId: string
  ): Promise<{ servers: ServerConfig[]; userInfo?: SubscriptionConfig['userInfo'] }> {
    try {
      this.logManager.addLog('info', `正在拉取订阅: ${url}`, 'Subscription');

      // SSRF 防护：订阅地址来自用户/分享，限 http(s)、拒指向本机/内网/link-local 的字面 IP
      // （拦 file://、http://169.254.169.254 云元数据、内网回环等）。基于主机名的 DNS 旁路仍存在，
      // 此处仅做字面 IP 兜底。
      const urlObj = (() => {
        try {
          return new URL(url);
        } catch {
          return null;
        }
      })();
      if (!urlObj || (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:')) {
        throw new Error(`订阅地址协议不支持（仅允许 http/https）: ${url}`);
      }
      if (this.isBlockedSubscriptionHost(urlObj.hostname)) {
        throw new Error(`订阅地址指向本机/内网/link-local，已拒绝: ${urlObj.hostname}`);
      }

      const response = await net.fetch(url, {
        headers: { 'User-Agent': 'FlowZ-Client' },
      });

      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
      }

      const userInfo = this.parseUserInfo(response.headers.get('subscription-userinfo'));
      if (userInfo) {
        this.logManager.addLog('info', '订阅流量信息已获取', 'Subscription');
      }

      const text = await response.text();
      const trimmed = text.trim();

      // ── 1. Sing-box JSON format ──────────────────────────────────────
      try {
        const json = JSON.parse(trimmed);
        if (json && Array.isArray(json.outbounds)) {
          this.logManager.addLog(
            'info',
            '检测到 sing-box JSON 格式，解析 outbounds...',
            'Subscription'
          );
          const servers = this.parseSingboxOutbounds(json.outbounds, subscriptionId);
          this.logManager.addLog(
            'info',
            `成功从 sing-box 订阅解析了 ${servers.length} 个节点`,
            'Subscription'
          );
          return { servers, userInfo };
        }
      } catch {
        // Not JSON — fall through to URL list parsing
      }

      // ── 2. URL list (plain or Base64-encoded) ───────────────────────
      let decodedContent = trimmed;
      if (!decodedContent.includes('://')) {
        try {
          decodedContent = Buffer.from(decodedContent, 'base64').toString('utf-8');
        } catch {
          this.logManager.addLog('warn', '尝试 Base64 解码失败，可能原本就是明文', 'Subscription');
        }
      }

      const lines = decodedContent.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const servers: ServerConfig[] = [];

      for (const line of lines) {
        if (this.protocolParser.isSupported(line)) {
          try {
            const server = this.protocolParser.parseUrl(line);
            server.subscriptionId = subscriptionId;
            const now = new Date().toISOString();
            server.createdAt = now;
            server.updatedAt = now;
            servers.push(server);
          } catch (e: any) {
            this.logManager.addLog('warn', `解析订阅中的节点失败: ${e.message}`, 'Subscription');
          }
        }
      }

      if (servers.length === 0) {
        // 区分「格式不识别」与「节点都解析失败」，避免 0 节点静默冒充成功（含 Base64 解码失败的情况）
        const hadUrlLines = lines.some((l) => l.includes('://'));
        this.logManager.addLog(
          'warn',
          hadUrlLines
            ? '订阅中的节点 URL 均无法解析（协议不支持或格式错误）'
            : '无法识别订阅格式：既非 sing-box JSON，也未发现可解析的节点 URL（可能 Base64 解码失败或格式不受支持）',
          'Subscription'
        );
      } else {
        this.logManager.addLog('info', `成功从订阅解析了 ${servers.length} 个节点`, 'Subscription');
      }
      return { servers, userInfo };
    } catch (error: any) {
      this.logManager.addLog('error', `拉取订阅失败 (${url}): ${error.message}`, 'Subscription');
      throw error;
    }
  }
}
