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
  username?: string;
  password?: string;
  method?: string;
  plugin?: string;
  plugin_opts?: string;
  obfs?: { type?: string; password?: string };
  // naive：是否启用 HTTP/3 (QUIC) 传输
  quic?: boolean;
  // vmess：security=加密方式(auto/none/aes-128-gcm/...)，alter_id=0 走 AEAD
  alter_id?: number;
  security?: string;
  // tuic
  congestion_control?: string;
  udp_relay_mode?: string;
  zero_rtt_handshake?: boolean;
  heartbeat?: string;
  // anytls
  idle_session_check_interval?: string;
  idle_session_timeout?: string;
  min_idle_session?: number;
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
   * 支持: shadowsocks, vless, trojan, hysteria2, naive, vmess, tuic, anytls, socks
   */
  private parseSingboxOutbounds(
    outbounds: SingboxOutbound[],
    subscriptionId: string
  ): ServerConfig[] {
    const SUPPORTED = new Set([
      'shadowsocks',
      'vless',
      'trojan',
      'hysteria2',
      'naive',
      'vmess',
      'tuic',
      'anytls',
      'socks',
    ]);
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
            base.wsSettings = { path: t.path, headers: t.headers };
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
        } else if (ob.type === 'vmess') {
          servers.push({
            ...(base as ServerConfig),
            protocol: 'vmess',
            uuid: ob.uuid ?? '',
            alterId: ob.alter_id ?? 0,
            vmessSecurity: ob.security || 'auto',
          });
        } else if (ob.type === 'tuic') {
          const tuicSettings: NonNullable<ServerConfig['tuicSettings']> = {};
          if (
            ob.congestion_control === 'bbr' ||
            ob.congestion_control === 'cubic' ||
            ob.congestion_control === 'new_reno'
          ) {
            tuicSettings.congestionControl = ob.congestion_control;
          }
          if (ob.udp_relay_mode === 'native' || ob.udp_relay_mode === 'quic') {
            tuicSettings.udpRelayMode = ob.udp_relay_mode;
          }
          if (ob.zero_rtt_handshake !== undefined) {
            tuicSettings.zeroRttHandshake = ob.zero_rtt_handshake;
          }
          if (ob.heartbeat) tuicSettings.heartbeat = ob.heartbeat;
          servers.push({
            ...(base as ServerConfig),
            protocol: 'tuic',
            uuid: ob.uuid ?? '',
            password: ob.password ?? '',
            security: 'tls',
            tuicSettings: Object.keys(tuicSettings).length > 0 ? tuicSettings : undefined,
          });
        } else if (ob.type === 'anytls') {
          const anyTlsSettings: NonNullable<ServerConfig['anyTlsSettings']> = {};
          if (ob.idle_session_check_interval) {
            anyTlsSettings.idleSessionCheckInterval = ob.idle_session_check_interval;
          }
          if (ob.idle_session_timeout) {
            anyTlsSettings.idleSessionTimeout = ob.idle_session_timeout;
          }
          if (ob.min_idle_session !== undefined) {
            anyTlsSettings.minIdleSession = ob.min_idle_session;
          }
          servers.push({
            ...(base as ServerConfig),
            protocol: 'anytls',
            password: ob.password ?? '',
            security: 'tls',
            anyTlsSettings: Object.keys(anyTlsSettings).length > 0 ? anyTlsSettings : undefined,
          });
        } else if (ob.type === 'socks') {
          // socks 无 TLS：覆盖 base 可能因 transport 推断的 network，固定为 tcp/none
          servers.push({
            ...(base as ServerConfig),
            protocol: 'socks',
            username: ob.username,
            password: ob.password,
            network: 'tcp',
            security: 'none',
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

      this.logManager.addLog('info', `成功从订阅解析了 ${servers.length} 个节点`, 'Subscription');
      return { servers, userInfo };
    } catch (error: any) {
      this.logManager.addLog('error', `拉取订阅失败 (${url}): ${error.message}`, 'Subscription');
      throw error;
    }
  }
}
