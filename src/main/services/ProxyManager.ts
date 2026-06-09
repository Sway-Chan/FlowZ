/**
 * 代理管理服务
 * 负责 sing-box 进程的生命周期管理和配置生成
 */

import { BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { UserConfig, ServerConfig, ProxyStatus } from '../../shared/types';
import type { ILogManager } from './LogManager';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { resourceManager } from './ResourceManager';
import { retry } from '../utils/retry';
import { coreVersionAtLeast } from '../utils/version';
import {
  getUserDataPath,
  getSingBoxConfigPath,
  getSingBoxLogPath,
  getSingBoxPidPath,
  getCachePath,
} from '../utils/paths';
import { getAppPreset } from '../../shared/app-rules-preset';

/**
 * 私有 IP 地址段（CIDR 格式）
 * 用于路由规则中的直连配置
 */
const PRIVATE_IP_CIDRS = [
  // IPv4 私有地址
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
  // IPv6 私有地址
  '::1/128', // loopback
  'fc00::/7', // unique local address (ULA)
  'fe80::/10', // link-local
  'ff00::/8', // multicast
];

/**
 * 私有 IP 地址正则表达式
 * 用于日志过滤中识别内网请求
 */
const PRIVATE_IP_PATTERNS = [
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /\b172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}/,
  /\b192\.168\.\d{1,3}\.\d{1,3}/,
  /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /\b169\.254\.\d{1,3}\.\d{1,3}/,
];

/**
 * 国内常见网银 U盾插件及本地证券/炒股软件的专属域名
 * 用于绕过代理，防止被 FakeIP 劫持或因协议不兼容（如二进制协议通过 HTTP 代理）被阻断
 */
const DOMESTIC_BANK_AND_STOCK_DOMAINS = [
  // U盾及网银相关（通常指向 127.0.0.1）
  '.microdone.cn', // 微动（杭州银行、中信银行等地方和股份制网银插件常用）
  '.icbc.com.cn', // 工商银行
  '.boc.cn', // 中国银行
  '.ccb.com', // 建设银行
  '.abchina.com',
  '.abchina.com.cn', // 农业银行
  '.bankcomm.com', // 交通银行
  '.cmbchina.com', // 招商银行
  '.psbc.com', // 邮储银行
  '.spdb.com.cn', // 浦发银行
  '.cebbank.com', // 光大银行
  '.citicbank.com', // 中信银行
  '.pingan.com', // 平安银行
  '.cib.com.cn', // 兴业银行
  '.hxb.com.cn', // 华夏银行
  '.cmbc.com.cn', // 民生银行
  '.hzbank.com.cn', // 杭州银行

  // 证券炒股软件相关（经常使用定制化的 TCP 二进制协议通信，在 SOCKS/HTTP 系统代理模式下会导致握手失败并被代理核心主动断开）
  '.10jqka.com.cn',
  '.thsi.cn', // 同花顺
  '.eastmoney.com',
  '.1234567.com.cn', // 东方财富
  '.gw.com.cn', // 大智慧
  '.tdx.com.cn', // 通达信
];

/**
 * sing-box 1.12.x / 1.13.x 配置类型定义
 */

interface SingBoxLogConfig {
  level: string;
  timestamp: boolean;
  output?: string;
}

interface SingBoxDnsServer {
  tag: string;
  type?: string;
  server?: string;
  server_port?: number;
  /** DoH path, e.g. "/dns-query" */
  path?: string;
  /** Bootstrap resolver tag: required when server is a domain name (sing-box 1.12+ new format) */
  domain_resolver?: string;
  detour?: string;
  // Legacy / compat fields (not emitted in new format)
  address?: string;
  address_resolver?: string;
  // FakeIP specific
  inet4_range?: string;
  inet6_range?: string;
}

interface SingBoxDnsRule {
  rule_set?: string;
  query_type?: string[];
  domain?: string[];
  domain_suffix?: string[];
  domain_keyword?: string[];
  server: string;
}

interface SingBoxFakeIPConfig {
  enabled: boolean;
  inet4_range?: string;
  inet6_range?: string;
}

interface SingBoxDnsConfig {
  servers: SingBoxDnsServer[];
  rules?: SingBoxDnsRule[];
  final?: string;
  strategy?: string;
  fakeip?: SingBoxFakeIPConfig;
}

interface SingBoxInbound {
  type: string;
  tag: string;
  listen?: string;
  listen_port?: number;
  // TUN 模式
  interface_name?: string;
  address?: string[];
  mtu?: number;
  auto_route?: boolean;
  strict_route?: boolean;
  stack?: string;
  sniff?: boolean;
  sniff_override_destination?: boolean; // Keep for interface compatibility if needed by types, but won't be used for 1.13+
  route_exclude_address?: string[];
  platform?: {
    http_proxy?: {
      enabled: boolean;
      server: string;
      server_port: number;
    };
  };
}

interface SingBoxOutbound {
  type: string;
  tag: string;
  detour?: string; // 代理链
  server?: string;
  server_port?: number;
  override_address?: string;
  // Shadowsocks
  method?: string;
  password?: string;
  username?: string;
  plugin?: string;
  plugin_opts?: string;
  // VLESS / VMess
  uuid?: string;
  security?: string; // vmess specific
  alter_id?: number; // vmess specific
  flow?: string;
  packet_encoding?: string;
  // Trojan and Hysteria2
  // password?: string; // Shared with SS
  // Hysteria2 specific
  up_mbps?: number;
  down_mbps?: number;
  obfs?: {
    type: string;
    password: string;
  };
  network?: string;
  // naive specific: 走 HTTP/3 (QUIC) 传输
  quic?: boolean;
  // TUIC specific
  congestion_control?: string;
  udp_relay_mode?: string;
  zero_rtt_handshake?: boolean;
  heartbeat?: string;
  // ShadowTLS specific
  version?: number;
  // AnyTLS specific
  idle_session_check_interval?: string;
  idle_session_timeout?: string;
  min_idle_session?: number;
  // TLS
  tls?: {
    enabled: boolean;
    server_name?: string;
    insecure?: boolean;
    alpn?: string[];
    utls?: {
      enabled: boolean;
      fingerprint: string;
    };
    reality?: {
      enabled: boolean;
      public_key: string;
      short_id: string;
    };
    ech?: { enabled: boolean };
    fragment?: boolean;
  };
  // Transport
  transport?: {
    type: string;
    path?: string;
    host?: string;
    headers?: Record<string, string | string[]>;
    service_name?: string;
    max_early_data?: number;
    early_data_header_name?: string;
  };
  // Multiplex 多路复用
  multiplex?: {
    enabled: boolean;
    protocol?: string;
    max_connections?: number;
    min_streams?: number;
    padding?: boolean;
  };
  // Hysteria2 端口跳跃
  server_ports?: string[];
  hop_interval?: string;
  // DNS resolver for outbound server domain
  domain_resolver?: string;
  // UDP over TCP (UoT)
  udp_over_tcp?: {
    enabled: boolean;
    version: number;
  };
  // Direct outbound: UDP fragmentation (also used to mark outbound as "non-empty" for sing-box 1.13+ validation)
  udp_fragment?: boolean;
  // SSH specific
  user?: string;
  private_key?: string;
  private_key_path?: string;
  private_key_passphrase?: string;
  host_key?: string[];
  host_key_algorithms?: string[];
  client_version?: string;
  // selector specific（用于 clash_api 热切换节点：default=当前选中，interrupt_exist_connections=切换时是否中断现有连接）
  outbounds?: string[];
  default?: string;
  interrupt_exist_connections?: boolean;
}

interface SingBoxRouteRule {
  protocol?: string;
  network?: string[];
  rule_set?: string | string[];
  domain?: string[];
  domain_suffix?: string[];
  domain_keyword?: string[];
  geosite?: string[];
  ip_cidr?: string[];
  port?: number | number[];
  process_name?: string | string[];
  process_name_not?: string | string[]; // sing-box 1.13+
  inbound?: string | string[]; // sing-box 1.13+
  action: string;
  outbound?: string;
  sniffer?: string[];
  rewrite_target?: boolean; // sing-box 1.12+
  timeout?: string;
  domain_resolver?: string; // sing-box 1.13+: 指定该规则使用的 DNS 解析器
  override_address?: string; // sing-box 1.13+: 在规则层强制修改目标地址
}

interface SingBoxRuleSet {
  tag: string;
  type: string;
  format: string;
  path?: string;
  url?: string;
  download_detour?: string;
}

interface SingBoxRouteConfig {
  rule_set?: SingBoxRuleSet[];
  rules: SingBoxRouteRule[];
  default_domain_resolver?: string;
  auto_detect_interface?: boolean;
  final?: string;
}

interface SingBoxExperimental {
  cache_file?: {
    enabled: boolean;
    path: string;
    store_fakeip?: boolean;
    store_rdrc?: boolean;
  };
}

interface SingBoxConfig {
  log: SingBoxLogConfig;
  dns?: SingBoxDnsConfig;
  inbounds: SingBoxInbound[];
  outbounds: SingBoxOutbound[];
  route?: SingBoxRouteConfig;
  experimental?: SingBoxExperimental & {
    clash_api?: {
      external_controller: string;
      external_ui?: string;
      secret?: string;
      external_ui_download_url?: string;
      external_ui_download_detour?: string;
      default_mode?: string;
      cache_file?: string;
    };
  };
}

export interface IProxyManager {
  start(config: UserConfig): Promise<void>;
  stop(): Promise<void>;
  restart(config: UserConfig): Promise<void>;
  switchMode(config: UserConfig): Promise<void>;
  getStatus(): ProxyStatus;
  generateSingBoxConfig(config: UserConfig, resolvedIps?: Record<string, string>): SingBoxConfig;
  on(event: 'started' | 'stopped' | 'error', listener: (...args: any[]) => void): void;
  off(event: 'started' | 'stopped' | 'error', listener: (...args: any[]) => void): void;
  getCoreVersion(): Promise<string>;
  buildPreflightConfigJson(targetVersion: string): string | null;
}

export class ProxyManager extends EventEmitter implements IProxyManager {
  private singboxProcess: ChildProcess | null = null;
  private startTime: Date | null = null;
  private pid: number | null = null;
  private singboxPid: number | null = null; // macOS TUN 模式下实际的 sing-box PID
  private currentConfig: UserConfig | null = null;
  // 启动时生成的「节点 id → selector 成员 tag」映射，用于 clash_api 热切换时定位目标 tag
  private currentIdToTagMap: Map<string, string> | null = null;
  private configPath: string;
  private singboxPath: string;
  private logManager: ILogManager | null = null;
  private lastLogMessage: string = '';
  private lastLogCount: number = 0;
  private lastLogTime: number = 0;
  private mainWindow: BrowserWindow | null = null;
  private lastErrorOutput: string = '';
  private logFileWatcher: ReturnType<typeof setInterval> | null = null;
  private lastLogFileSize: number = 0;
  // 长会话 debug 日志无限增长会撑满磁盘，超过此上限即截断 singbox.log
  // （sing-box 以 O_APPEND 模式写，截断后从 offset 0 续写，不产生 sparse 空洞）
  private static readonly MAX_LOG_FILE_SIZE = 20 * 1024 * 1024; // 20MB
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly HEALTH_CHECK_INTERVAL = 10000; // 10秒检查一次

  // 自动重启相关
  private autoRestartEnabled: boolean = true;
  // 核心更新"待验证窗口"内由 CoreUpdateService 置 true：抑制自动重启，让新核心首次异常退出立即
  // 上报 'error' 触发回滚（而非在已知有问题的新核心上空转 MAX_RESTART_COUNT 次后才上报）。
  private autoRestartSuppressed: boolean = false;
  private restartCount: number = 0;
  private lastRestartTime: number = 0;
  private static readonly MAX_RESTART_COUNT = 3; // 最大重启次数
  private static readonly RESTART_COOLDOWN = 60000; // 重启冷却时间（1分钟内最多重启3次）
  private isRestarting: boolean = false;
  private coreVersion: string = 'unknown';

  constructor(
    logManager?: ILogManager,
    mainWindow?: BrowserWindow,
    configPath?: string,
    singboxPath?: string
  ) {
    super();
    this.logManager = logManager || null;
    this.mainWindow = mainWindow || null;

    // 配置文件路径
    if (configPath) {
      this.configPath = configPath;
    } else {
      this.configPath = getSingBoxConfigPath();
    }

    // sing-box 可执行文件路径
    if (singboxPath) {
      this.singboxPath = singboxPath;
    } else {
      this.singboxPath = this.getSingBoxPath();
    }
  }

  /**
   * 启动代理
   */
  async start(config: UserConfig): Promise<void> {
    // 如果已经在运行，先停止
    if (this.singboxProcess || this.singboxPid) {
      await this.stop();
    }

    // 用户手动启动时重置重启计数
    if (!this.isRestarting) {
      this.resetRestartCount();
    }

    // 先保存当前配置（needsRootPrivilege 等方法需要用到）
    this.currentConfig = config;

    // Linux 下确保核心在用户目录且可执行，以便支持 setcap 和规避 AppImage EROFS
    if (process.platform === 'linux') {
      try {
        this.singboxPath = await resourceManager.ensureWritableCore();
      } catch (err) {
        this.logToManager('error', `Linux 核心准备失败: ${(err as Error).message}`);
      }
    }

    // 仅在 TUN 模式下清理可能残留的 sing-box 进程
    // 系统代理模式不需要管理员权限，也不会有残留的 TUN 进程问题
    const isTunMode = config.proxyModeType === 'tun';
    if (isTunMode) {
      await this.killOrphanedSingBoxProcesses();
    }

    // 0. 获取核心版本（用于后续生成兼容的配置文件）
    this.coreVersion = await this.getCoreVersion();
    this.logToManager('info', `检测到 sing-box 核心版本: ${this.coreVersion}`);

    // 修复可能被 root 创建的文件权限（从 TUN 模式切换到系统代理模式时）
    await this.fixFilePermissions();

    // 检查是否选择了服务器
    if (!config.selectedServerId) {
      throw new Error('No server selected');
    }

    // 查找选中的服务器
    const selectedServer = config.servers.find((s) => s.id === config.selectedServerId);
    if (!selectedServer) {
      throw new Error('Selected server not found');
    }

    // 3. 准备规则文件（必须在生成配置前完成）
    await this.copyRuleSetsToUserData();

    // 3.5. 预解析所有节点的域名为 IP（仅针对 TUN 模式），防止 Windows 下回流死循环
    // 【待真机验证 / CDN 风险】：对"域名节点"预解析得到的 IP 会进 route_exclude_address，若节点在
    //   共享 CDN(如 Cloudflare) 后，等于把共享 IP 加直连 → 误伤同 IP 的被墙站点、且抗不住 IP 轮换。
    //   现已在 generateRouteConfig 用"全节点域名 → direct"的纯域名规则(sniff SNI)做 CDN 安全豁免；
    //   此处 Windows IP 预解析是否仍为断环所必需，需 Wintun 真机验证：若域名规则+sniff 足够 → 删除本块；
    //   若 Windows 确需 IP 级兜底 → 应仅对 IP-literal 节点保留、域名节点不预解析。无 Windows 环境暂不擅改。
    const resolvedServerIps: Record<string, string> = {};
    if (isTunMode && process.platform === 'win32') {
      this.logToManager('info', '正在预解析节点域名以防止 TUN 回流...');
      const dns = require('dns').promises;
      const allServerIds = new Set([
        config.selectedServerId as string,
        ...(config.appRules || []).map((r) => r.targetServerId),
      ]);

      const resolvePromises = Array.from(allServerIds).map(async (serverId) => {
        if (!serverId) return;
        const server = config.servers.find((s) => s.id === serverId);
        if (
          server?.address &&
          !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(server.address) &&
          !server.address.includes(':')
        ) {
          try {
            const { address } = await dns.lookup(server.address);
            if (address) {
              resolvedServerIps[serverId] = address;
            }
          } catch {
            /* ignore */
          }
        }
      });
      await Promise.all(resolvePromises);
    }

    // 4. 生成 sing-box 配置文件
    const singboxConfig = this.generateSingBoxConfig(config, resolvedServerIps);

    // 写入配置文件
    await this.writeSingBoxConfig(singboxConfig);
    this.logToManager('info', 'sing-box 配置文件已生成');

    // TUN 模式下，删除旧的 PID 文件，确保不会读到旧的 PID
    if (this.needsOsascript() || this.needsWindowsUAC()) {
      await this.deletePidFile();
    }

    // 5. 启动 sing-box 进程
    await retry(() => this.startSingBoxProcess(), {
      maxRetries: 2,
      delay: 2000,
      exponentialBackoff: true,
      shouldRetry: (error) => {
        // 只对特定错误进行重试
        const message = error.message.toLowerCase();

        // 不重试的错误类型
        const nonRetryableErrors = [
          '找不到',
          '权限',
          'permission',
          'enoent',
          'eacces',
          'eperm',
          '配置文件格式错误',
          'invalid config',
        ];

        // 如果是不可重试的错误，直接失败
        if (nonRetryableErrors.some((pattern) => message.includes(pattern))) {
          return false;
        }

        // 其他错误可以重试
        return true;
      },
      onRetry: (error, attempt) => {
        this.logToManager('warn', `启动失败，正在进行第 ${attempt} 次重试: ${error.message}`);
      },
    });

    // 如果是系统代理模式，设置系统代理
    if (config.proxyModeType === 'systemProxy') {
      await this.setSystemProxy(config);
    }

    // H3 修复：sing-box 的 cache_file 会持久化 selector 的 clash_api 选择，重启后缓存会覆盖 config
    // 的 default。故启动后用 clash_api 把 selector 校正回 config.selectedServerId，让 FlowZ 配置成为
    // 单一真值、压过缓存。best-effort（不阻塞启动成功）。
    void this.reassertSelectorSelection(config);
  }

  /**
   * 启动后把 selector 选择校正回 config.selectedServerId（压过 cache_file 持久化的旧选择，修 H3）。
   * best-effort + 短重试，clash_api 刚起可能未就绪；失败不影响启动（cache/default 仍是有效节点）。
   */
  private async reassertSelectorSelection(config: UserConfig): Promise<void> {
    for (let i = 0; i < 10; i++) {
      if (!this.singboxProcess && !this.singboxPid) return; // 已停止则放弃
      // 每轮读最新 currentConfig.selectedServerId：若启动窗口内用户已热切到别的节点，则用新节点、
      // 不要把它 revert 回启动时的旧节点。
      const targetId = this.currentConfig?.selectedServerId ?? config.selectedServerId;
      const tag = this.currentIdToTagMap?.get(targetId as string);
      if (!tag) return;
      try {
        const res = await fetch('http://127.0.0.1:9090/proxies/proxy-selector', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: tag }),
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return;
      } catch {
        // clash_api 未就绪/瞬时失败 → 短延迟后重试
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /**
   * 停止代理
   */
  async stop(): Promise<void> {
    // macOS TUN 模式：即使 singboxProcess 为 null，也可能有后台进程在运行
    if (!this.singboxProcess && !this.singboxPid) {
      return;
    }

    // 如果当前是系统代理模式，取消系统代理
    if (this.currentConfig && this.currentConfig.proxyModeType === 'systemProxy') {
      await this.unsetSystemProxy();
    }

    await this.stopSingBoxProcess();
    // 进程已停 → 清掉旧的 id→tag 映射，防止对一个已不存在的 selector 误发 clash_api 切换
    this.currentIdToTagMap = null;
  }

  /**
   * 重启代理
   */
  async restart(config: UserConfig): Promise<void> {
    await this.stop();
    await this.start(config);
  }

  /**
   * 切换代理模式
   * 检测模式变化，如果代理正在运行则重启
   */
  async switchMode(newConfig: UserConfig): Promise<void> {
    // 代理未运行：只更新配置（下次 start 时按新配置生成）
    if (!this.singboxProcess && !this.singboxPid) {
      this.currentConfig = newConfig;
      return;
    }

    // 唯一变化是「切节点」→ clash_api 热切换 selector，不重启 sing-box（优雅切换，连接保留与否由
    // selector.interrupt_exist_connections 开关决定）。失败则退回重启式切换，保证一定能应用。
    if (this.canHotSwitch(newConfig)) {
      if (await this.hotSwitchNode(newConfig)) {
        this.currentConfig = newConfig;
        return;
      }
      this.logToManager('warn', '热切换失败，退回重启式切换');
    }

    // 其余变化（模式/端口/TUN/规则/节点集合/interrupt 开关 等需重生成配置的项）→ 重启应用。
    this.logToManager('info', '配置已更改，正在重启代理以应用...');
    await this.restart(newConfig);
  }

  /**
   * 是否可走 clash_api 热切换：当且仅当唯一变化是「切到一个已在运行中 selector 里的节点」，
   * 其余影响配置生成的项（模式/端口/TUN/customRules/servers 集合/appRules/interrupt 开关）都未变。
   */
  private canHotSwitch(newConfig: UserConfig): boolean {
    const old = this.currentConfig;
    if (!old) return false;
    // 必须确实是切节点
    if (old.selectedServerId === newConfig.selectedServerId) return false;
    if (!newConfig.selectedServerId) return false;
    // 目标节点必须已存在于运行中的 selector（= 启动时的 servers），否则 PUT 指向不存在的成员
    if (!old.servers.some((s) => s.id === newConfig.selectedServerId)) return false;
    // Windows TUN：route_exclude_address 在 start 时仅按「选中 + appRules」节点构建；热切到其它
    // IP-literal 节点时其 server IP 不在排除集 → Wintun 会把 sing-box 自身出向包回捕进 TUN 成环。
    // 配置不重生成无法补排除集，故 Windows TUN 一律退回重启（由重启重生成排除集）。
    if (process.platform === 'win32' && newConfig.proxyModeType === 'tun') return false;
    // 唯一允许变化的就是 selectedServerId：对齐它、servers 按 id 归一化后整体深比较——任何其它影响
    // 配置生成的字段（blockQuic/tlsFragment/dnsConfig/各 TUN 子字段/appRules/customRules/端口/interrupt
    // 开关 等）有差异都退回重启，避免「切节点 + 改某设置」同时发生时把那个设置静默丢掉。
    const norm = (c: UserConfig) =>
      this.stableStringify({
        ...c,
        selectedServerId: null,
        servers: [...c.servers].sort((a, b) => a.id.localeCompare(b.id)),
      });
    return norm(old) === norm(newConfig);
  }

  /**
   * 递归按 key 排序后序列化——使深比较对对象属性插入顺序不敏感。
   * 渲染层重建配置对象时键序常与原对象不同，普通 JSON.stringify 会因此误判"配置已变"而退回重启、
   * 废掉热切换。数组顺序保留（customRules/appRules 顺序具语义，顺序变化应视为真变更触发重启）。
   */
  private stableStringify(v: any): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return '[' + v.map((x) => this.stableStringify(x)).join(',') + ']';
    return (
      '{' +
      Object.keys(v)
        .sort()
        .filter((k) => v[k] !== undefined) // 与 JSON.stringify 一致：丢弃 undefined 键，避免 undefined↔null 误判相等
        .map((k) => JSON.stringify(k) + ':' + this.stableStringify(v[k]))
        .join(',') +
      '}'
    );
  }

  /**
   * 通过 clash_api `PUT /proxies/proxy-selector` 把 selector 切到目标节点（无需重启）。
   * 成功返回 true；任何异常/非 2xx 返回 false（调用方退回重启）。
   */
  private async hotSwitchNode(newConfig: UserConfig): Promise<boolean> {
    const targetTag = this.currentIdToTagMap?.get(newConfig.selectedServerId as string);
    if (!targetTag) return false;
    try {
      const res = await fetch('http://127.0.0.1:9090/proxies/proxy-selector', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: targetTag }),
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) {
        this.logToManager('warn', `clash_api 热切换返回 HTTP ${res.status}`);
        return false;
      }
      this.logToManager('info', `已热切换节点 → ${targetTag}（clash_api，无重启）`);
      return true;
    } catch (e: any) {
      this.logToManager('warn', `clash_api 热切换异常: ${e?.message ?? e}`);
      return false;
    }
  }

  /**
   * 获取代理状态
   */
  getStatus(): ProxyStatus {
    // TUN 模式下只检查 singboxPid（sing-box 的实际 PID）
    // 系统代理模式下检查 pid（直接启动的进程 PID）
    // 注意：TUN 模式下 this.pid 是 osascript/PowerShell 的 PID，不是 sing-box 的
    const isTunMode = this.currentConfig?.proxyModeType === 'tun';
    const activePid = isTunMode ? this.singboxPid : this.singboxPid || this.pid;

    // 验证进程是否真正存活
    const isRunning = activePid !== null && this.isProcessAlive(activePid);

    if (!isRunning || !activePid) {
      return {
        running: false,
      };
    }

    // 计算运行时间
    let uptime: number | undefined;
    if (this.startTime) {
      uptime = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
    }

    return {
      running: true,
      pid: activePid,
      startTime: this.startTime || undefined,
      uptime,
      currentServer: this.currentConfig?.servers.find(
        (s) => s.id === this.currentConfig?.selectedServerId
      ),
    };
  }

  /**
   * 获取核心版本
   */
  async getCoreVersion(): Promise<string> {
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      const { stdout } = await execAsync(`"${this.singboxPath}" version`);
      // 输出示例: sing-box version 1.13.0 ... 或 v1.13.0 ...
      const match = stdout.match(/(?:version\s+|v)(\d+\.\d+(\.\d+)?)/i);
      if (match) {
        return match[1];
      }

      // 备选方案：尝试直接取第一组连续的数字版本号
      const secondMatch = stdout.match(/(\d+\.\d+\.\d+)/);
      return secondMatch ? secondMatch[1] : '1.13.0';
    } catch (error) {
      this.logToManager('error', `获取核心版本失败: ${(error as any).message}`);
      return '1.13.0';
    }
  }

  /**
   * 为「核心更新预检」生成针对目标版本的配置 JSON：用当前活动配置 + 目标核心版本的生成风格
   * （<1.13 走 inbound sniff，≥1.13 走 route action），供 sing-box check 校验新核心能否解析。
   * 无活动配置（代理从未启动）时返回 null —— 调用方仅校验二进制可执行即可。
   */
  buildPreflightConfigJson(targetVersion: string): string | null {
    if (!this.currentConfig) return null;
    const savedVersion = this.coreVersion;
    try {
      this.coreVersion = targetVersion;
      const cfg = this.generateSingBoxConfig(this.currentConfig);
      return JSON.stringify(cfg, null, 2);
    } catch (e) {
      this.logToManager('warn', `预检配置生成失败: ${(e as any)?.message ?? e}`);
      return null;
    } finally {
      this.coreVersion = savedVersion;
    }
  }

  /**
   * 生成 sing-box 配置（sing-box 1.12.x / 1.13.x 兼容格式）
   */
  generateSingBoxConfig(config: UserConfig, resolvedIps?: Record<string, string>): SingBoxConfig {
    const selectedServer = config.servers.find((s) => s.id === config.selectedServerId);
    if (!selectedServer) {
      throw new Error('Selected server not found');
    }
    // 选中节点不可用（naive 缺 libcronet）→ 明确报错，不静默切到别的节点（修 review M1）
    if (!this.isNodeUsable(selectedServer)) {
      throw new Error(
        `选中的节点「${selectedServer.name}」是 NaiveProxy，但未找到 libcronet 核心库（macOS 暂无官方预编译库）。请选择其它协议的节点。`
      );
    }

    // 调试日志
    console.log('[ProxyManager] Generating config with:', {
      proxyMode: config.proxyMode,
      proxyModeType: config.proxyModeType,
      selectedServerId: config.selectedServerId,
      serverProtocol: selectedServer.protocol,
    });

    // 获取用户数据目录用于缓存文件
    const userDataPath = getUserDataPath();
    const cachePath = getCachePath();

    // 关键优化：预先生成 ID 到 Tag 的唯一映射，使用服务器名称作为 Tag，确保拓扑和日志显示友好名称
    // 这样做之后内容拓扑（Clash API）和日志中显示的将是“香港 01”而不是“proxy-uuid”
    const idToTagMap = new Map<string, string>();
    // 预占内置出站 tag，防止用户把节点命名为 proxy-selector/direct/block 等导致 tag 撞车启动 FATAL
    const usedTags = new Set<string>(['proxy-selector', 'direct', 'block', 'direct-loopback']);

    const getUniqueTag = (server: ServerConfig) => {
      let baseTag = server.name.trim() || '未命名节点';
      let tag = baseTag;
      let count = 1;
      while (usedTags.has(tag)) {
        tag = `${baseTag} (${count})`;
        count++;
      }
      usedTags.add(tag);
      return tag;
    };

    // 为所有服务器预生成 Tag
    for (const s of config.servers) {
      idToTagMap.set(s.id, getUniqueTag(s));
    }
    // 记录本次生成的 id→tag 映射，供 clash_api 热切换定位 selector 成员 tag（见 hotSwitchNode）
    this.currentIdToTagMap = idToTagMap;

    const singboxConfig: SingBoxConfig = {
      log: this.generateLogConfig(config),
      dns: this.generateDnsConfig(config, 'proxy-selector'),
      inbounds: this.generateInbounds(config, resolvedIps),
      outbounds: this.generateOutbounds(selectedServer, config, idToTagMap),
      route: this.generateRouteConfig(config, idToTagMap),
      experimental: {
        cache_file: {
          enabled: true,
          path: cachePath,
          store_fakeip: true,
          store_rdrc: true,
        },
        clash_api: {
          external_controller: '127.0.0.1:9090',
          external_ui: path.join(userDataPath, 'ui'),
          secret: '', // 为空以保持与现有渲染进程 fetch 逻辑兼容
          default_mode: 'rule',
        },
      },
    };

    // 路由规则若指向「已被跳过/不存在的出站」（如缺 libcronet 被跳过的 naive 节点），sing-box 会以
    // "outbound not found" 启动失败。统一把这类死引用修正为 selector（修 review H2：app/custom 分流
    // 指向被跳过 naive 节点的情况）。
    const validTags = new Set(
      singboxConfig.outbounds.map((o) => o.tag).filter((t): t is string => !!t)
    );
    for (const rule of singboxConfig.route?.rules ?? []) {
      const r = rule as { action?: string; outbound?: string };
      if (r.action === 'route' && r.outbound && !validTags.has(r.outbound)) {
        r.outbound = 'proxy-selector';
      }
    }

    // 调试日志
    console.log('[ProxyManager] Generated inbounds count:', singboxConfig.inbounds.length);
    console.log('[ProxyManager] Generated outbounds count:', singboxConfig.outbounds.length);
    console.log('[ProxyManager] Route rule_set count:', singboxConfig.route?.rule_set?.length || 0);

    return singboxConfig;
  }

  /**
   * 生成日志配置
   */
  private generateLogConfig(config: UserConfig): SingBoxLogConfig {
    // 默认使用 debug 级别以显示路由决策（哪些请求走代理/直连）
    // 应用层会过滤掉不重要的日志，只保留有价值的信息
    const logConfig: SingBoxLogConfig = {
      level: config.logLevel || 'debug',
      timestamp: true,
    };

    // 在 TUN 模式下（macOS 和 Windows），使用权限提升运行时无法捕获 stdout
    // 需要将日志输出到文件，然后通过文件监控读取
    // 注意：这里直接根据 config 参数判断，而不是 this.currentConfig
    const isTunMode = config.proxyModeType?.toLowerCase() !== 'systemproxy';
    const isMacTunMode = process.platform === 'darwin' && isTunMode;
    const isWindowsTunMode = process.platform === 'win32' && isTunMode;

    if (isMacTunMode || isWindowsTunMode) {
      logConfig.output = this.getLogFilePath();
    }

    return logConfig;
  }

  /**
   * 获取 sing-box 日志文件路径
   */
  private getLogFilePath(): string {
    return getSingBoxLogPath();
  }

  /**
   * 清空 sing-box 日志文件
   * 在 Windows 和 macOS 上都能工作
   */
  async clearSingBoxLogFile(): Promise<void> {
    const logFilePath = this.getLogFilePath();
    try {
      // 清空日志文件（截断为空）
      await fs.writeFile(logFilePath, '', 'utf-8');
      this.logToManager('info', 'sing-box 日志文件已清空');
    } catch (error: any) {
      // 文件不存在，忽略
      if (error.code !== 'ENOENT') {
        this.logToManager('error', `清空 sing-box 日志文件失败: ${error.message}`);
      }
    }
  }

  private generateDnsConfig(config: UserConfig, selectedServerTag: string): SingBoxDnsConfig {
    const proxyMode = (config.proxyMode || 'smart').toLowerCase();

    // 获取用户 DNS 配置，不存在则使用默认值
    const userDnsConfig = config.dnsConfig || {
      domesticDns: 'https://doh.pub/dns-query',
      foreignDns: 'https://dns.google/dns-query',
      enableFakeIp: false,
    };

    // 决定是否开启 FakeIP。
    // 在 TUN 模式下强制开启 FakeIP。
    // 原因：很多第三方机场的节点防滥用严格，如果收到纯 IP 地址而非域名，会直接拒绝连接并抛出无效证书或拦截页面。
    // 配合我们刚刚修复的 macOS gvisor strict_route DHCP DNS 劫持逻辑，
    // FakeIP 现在能够 100% 完美的用内部 cache 把假 IP 还原成真域名丢给代理节点。
    // 从而完美避开机场对纯 IP 请求的无情封杀！
    const enableFakeIp =
      config.proxyModeType?.toLowerCase() !== 'systemproxy' ? true : userDnsConfig.enableFakeIp;

    // sing-box 1.13+ 新格式：每个 server 必须有显式 type 字段
    //
    // 关键架构说明：
    // - 在 TUN 下，Windows 的系统 DNS (svchost) 发出的解析请求会被 TUN 劫持。如果该系统 DNS 配置为公共 IP，
    //   此时 type: 'local' (调用系统 getaddrinfo) 就会进入死循环。
    // - 为了彻底解决这个问题，同时避免 UDP 53 屏蔽（之前使用 223.5.5.5 UDP 的缺陷），
    //   我们引入一个坚不可摧的 DoH IP Bootstrap (dns-bootstrap)：向 223.5.5.5:443 直接发 DoH 包。
    //   它绕过 TUN 不是靠 DNS detour，而是靠 route 规则把 223.5.5.5:443 直连放行（见 generateRouteConfig）。
    //   关键路径（节点域名 / doh.pub / default_domain_resolver）均以它为 resolver，免疫 UDP 53 限速/劫持/投毒。
    const dnsServers: SingBoxDnsServer[] = [
      {
        // 引导解析：专门用于解析代理节点的 IP 解析器（UDP，最稳健）
        tag: 'dns-bootstrap-udp',
        type: 'udp',
        server: '223.5.5.5',
        server_port: 53,
      },
      {
        // 引导解析（DoH over IP）：关键路径的解析器。server 已是 IP，无需 domain_resolver。
        // 相比 UDP 53，对运营商的 UDP 53 限速/劫持/投毒免疫，避免节点域名解析失败导致断流。
        tag: 'dns-bootstrap',
        type: 'https',
        server: '223.5.5.5',
        server_port: 443,
        path: '/dns-query',
      },
      {
        // 兼容性和兜底的系统 DNS
        tag: 'dns-local',
        type: 'local',
      },
      {
        // 国内直连 DNS (推荐 DoH)
        tag: 'dns-domestic',
        type: 'https',
        server: 'doh.pub',
        server_port: 443,
        path: '/dns-query',
        domain_resolver: 'dns-bootstrap',
      },
      {
        // 远程代理 DNS (推荐 DoH)
        tag: 'dns-remote',
        type: 'https',
        server: 'dns.google',
        server_port: 443,
        path: '/dns-query',
        domain_resolver: 'dns-bootstrap',
        // 关键核心：远程解析必须走代理，否则在境内直接发起会因 GFW 拦截/污染导致 FakeIP 映射失败或由于 TTL 极短产生大量无效解析。
        detour: selectedServerTag,
      },
    ];

    if (enableFakeIp) {
      dnsServers.push({
        // FakeIP 服务器：返回虚假 IP，由 sniff 识别真实域名
        tag: 'fakeip',
        type: 'fakeip',
        inet4_range: '198.18.0.0/15',
        inet6_range: 'fc00::/18',
      });
    }

    const dnsConfig: SingBoxDnsConfig = {
      servers: dnsServers,
      rules: [],
      // 默认使用国内 DNS 解析
      final: 'dns-domestic',
      // macOS 使用 RealIP 模式（嗅探），Windows 依然使用高效的 FakeIP
      strategy: process.platform === 'darwin' || config.enableIPv6 ? 'prefer_ipv4' : 'ipv4_only',
    };
    const dnsRules: SingBoxDnsRule[] = [];

    // 代理服务器域名必须使用真实 DNS 解析（避免 FakeIP 劫持产生死循环）
    const selectedServer = config.servers.find((s) => s.id === config.selectedServerId);
    if (selectedServer?.address) {
      const proxyDomains = [selectedServer.address];
      if (selectedServer.tlsSettings?.serverName) {
        proxyDomains.push(selectedServer.tlsSettings.serverName);
      }
      const uniqueDomains = Array.from(new Set(proxyDomains));

      dnsRules.push({
        domain: uniqueDomains,
        domain_suffix: uniqueDomains.flatMap((d) => [d, `.${d}`]),
        domain_keyword: uniqueDomains,
        server: 'dns-domestic', // 强制使用 DoH 解析节点域名，防止 UDP 53 被运营商劫持/丢包导致 TTL 过期后断网
      } as SingBoxDnsRule);
    }

    // 处理基础 DNS 服务的地址解析，确保它们走引导解析器
    dnsRules.push({
      domain: ['doh.pub', 'dns.google', 'cloudflare-dns.com', 'one.one.one.one'],
      server: 'dns-bootstrap-udp',
    } as SingBoxDnsRule);

    // 解决 mDNS 和本地反向解析导致的 context deadline exceeded 超时问题
    // 拦截 .arpa 等反向解析请求交由本地系统 DNS 快速返回，防止泄漏到公网 DNS 而引起解析超时
    // 拦截国内常见网银 U盾 驱动的本地环回解析，防止 FakeIP 拦截产生 NXDOMAIN
    dnsRules.push({
      domain_suffix: ['.local', '.arpa', '.lan', '.home.arpa', ...DOMESTIC_BANK_AND_STOCK_DOMAINS],
      server: 'dns-local',
    } as SingBoxDnsRule);

    // 处理自定义规则中的 bypassFakeIP
    if (config.customRules && enableFakeIp) {
      const bypassDomains: string[] = [];
      for (const rule of config.customRules) {
        if (rule.enabled && rule.bypassFakeIP && rule.domains.length > 0) {
          for (const d of rule.domains) {
            if (!d.startsWith('geosite:')) {
              bypassDomains.push(d.startsWith('*.') ? d.slice(2) : d);
            }
          }
        }
      }

      if (bypassDomains.length > 0) {
        dnsRules.push({
          domain: bypassDomains,
          domain_suffix: bypassDomains.flatMap((d) => [d, `.${d}`]),
          server: 'dns-bootstrap', // 使用真实 DNS 绕过 FakeIP
        } as SingBoxDnsRule);
      }
    }

    // 智能分流/全局代理模式下的 DNS 规则
    if (proxyMode === 'smart' || proxyMode === 'global') {
      if (enableFakeIp) {
        // [原版 Fork 核心精髓：Clash-style 全局 FakeIP]
        // 让所有的 A/AAAA（IPv4/IPv6）解析无脑走 FakeIP 返回 198.18 的伪装 IP。
        // 等浏览器连过来以后，Sing-box 靠伪装 IP 查缓存恢复域名，然后交给下面的 Route 引擎。
        // Route 引擎看到域名，如果命中 geosite-cn，就走 direct 出口，走 direct 时再真正发起本地 DNS 查询拿到淘宝的真实 IP。
        // 如果查不到 cn 规则，自然落入 proxy，连同域名一起完好无损发给代理节点！极其稳如泰山！
        dnsRules.push({
          query_type: ['A', 'AAAA'],
          server: 'fakeip',
        } as SingBoxDnsRule);
      } else {
        // 如果实在没开 FakeIP（比如系统代理模式），那就用 geosite 规则让它各自拿正确的 IP 吧（但也容易被墙污染）
        if (proxyMode === 'smart') {
          dnsRules.push({
            rule_set: 'geosite-cn',
            server: 'dns-domestic',
          } as SingBoxDnsRule);

          // 此处移除了 rule_set: 'geosite-geolocation-!cn'，因为 1.12 的 singbox 在
          // dns block 里跑规则集会导致某些内置不支持的匹配失效或报错，一律 fallthrough 给 dns-remote
          dnsRules.push({
            server: 'dns-remote',
          } as SingBoxDnsRule);
        } else {
          dnsRules.push({
            query_type: ['A', 'AAAA'],
            server: 'dns-remote',
          } as SingBoxDnsRule);
        }
      }
    }

    dnsConfig.rules = dnsRules;
    return dnsConfig;
  }

  /**
   * 生成 AppRule 路由规则
   */

  /**
   * 生成 Inbound 配置（sing-box 1.12.x / 1.13.x 兼容格式）
   */
  private generateInbounds(
    config: UserConfig,
    resolvedIps?: Record<string, string>
  ): SingBoxInbound[] {
    const inbounds: SingBoxInbound[] = [];

    // 使用小写比较，兼容 SystemProxy/systemProxy 和 Tun/tun
    const modeType = (config.proxyModeType || 'systemProxy').toLowerCase();

    const listenAddr = config.allowLan ? '::' : '127.0.0.1';

    // 无论哪种模式，都添加 HTTP + SOCKS inbound
    // 这样用户在终端配置的代理环境变量在切换模式后仍然可用
    //
    // 关键修复：必须启用流量嗅探（sniff），否则 sing-box 无法从 TLS ClientHello 中
    // 提取域名（SNI），导致路由引擎只看到 IP 地址，无法匹配 geosite 规则正确分流。
    // 症状：Instagram 消息中心无网络、WhatsApp 二维码无法扫码等 WebSocket 类应用异常。
    // NekoBox 等 sing-box 客户端默认开启 sniff，FlowZ 之前遗漏了。
    //
    // 版本兼容：
    //   1.12.x → sniff/sniff_override_destination 是 inbound 级别字段
    //   1.13.x → 这些字段已移除，改由路由层 action: 'sniff' + override_destination: true 实现
    const useLegacySniff = !coreVersionAtLeast(this.coreVersion, 1, 13);

    const httpInbound: SingBoxInbound = {
      type: 'http',
      tag: 'http-in',
      listen: listenAddr,
      listen_port: config.httpPort || 2080,
    };
    const socksInbound: SingBoxInbound = {
      type: 'socks',
      tag: 'socks-in',
      listen: listenAddr,
      listen_port: config.socksPort || 2081,
    };

    if (useLegacySniff) {
      httpInbound.sniff = true;
      httpInbound.sniff_override_destination = true;
      socksInbound.sniff = true;
      socksInbound.sniff_override_destination = true;
    }

    inbounds.push(httpInbound, socksInbound);

    // Mixed 端口（可选）：同时接受 HTTP 和 SOCKS5 请求
    if (config.mixedPort && config.mixedPort > 0) {
      const mixedInbound: SingBoxInbound = {
        type: 'mixed',
        tag: 'mixed-in',
        listen: listenAddr,
        listen_port: config.mixedPort,
      };
      if (useLegacySniff) {
        mixedInbound.sniff = true;
        mixedInbound.sniff_override_destination = true;
      }
      inbounds.push(mixedInbound);
    }

    // TUN 模式额外添加 TUN inbound
    if (modeType === 'tun') {
      const isIpv4 = (host: string) => /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host);
      const isIpv6 = (host: string) => /^[0-9a-fA-F:]+$/.test(host) && host.includes(':');

      const shouldBypassLAN = config.bypassLAN !== false; // 默认为 true
      // 恢复 3.3.18 能完美工作的排除列表。
      // 注意：macOS 下绝对不能在底层排除物理局域网段，否则 macOS NetworkExtension 的路由逆向拦截机制会导致从 TUN (172.19.0.1) 发回 192.168.x.x 的 TCP 回执包被当作非法源 IP 丢弃，导致网页无限 HANG。
      // 但是在 Windows 下，Wintun 如果不排除局域网物理网关，发往本地路由器的 DHCP/网关查询会被死循环拦截，导致全局断网。
      const excludeAddr =
        process.platform === 'win32' && shouldBypassLAN
          ? [...PRIVATE_IP_CIDRS]
          : ['127.0.0.0/8', '::1/128'];

      // Windows 下额外排除核心 DNS IP，防止 WFP 进程匹配失效时产生回流死循环
      if (process.platform === 'win32') {
        excludeAddr.push(
          '223.5.5.5/32',
          '223.6.6.6/32',
          '119.29.29.29/32',
          '119.28.28.28/32',
          '114.114.114.114/32',
          '8.8.8.8/32',
          '1.1.1.1/32'
        );
      }

      // 绝杀级修复（多服务器版本）：如果在 应用分流 (App Policy) 中选择了其他节点，那么这些节点的 IP 也必须被排除。
      // 否则，FlowZ 去连接这些次选节点的流量也会回流进入 TUN 产生死循环。
      const allServerIds = new Set([
        config.selectedServerId as string,
        ...(config.appRules || []).map((r) => r.targetServerId),
      ]);

      // 去除会导致 macOS 崩溃的 shouldBypassLAN 全局排除逻辑，回到 3.3.18 时代的精简状态
      for (const serverId of allServerIds) {
        if (!serverId) continue;
        const server = config.servers.find((s) => s.id === serverId);
        if (server?.address) {
          if (isIpv4(server.address)) {
            excludeAddr.push(`${server.address}/32`);
          } else if (isIpv6(server.address)) {
            excludeAddr.push(`${server.address}/128`);
          } else if (resolvedIps && resolvedIps[serverId]) {
            // 使用预解析的 IP
            const addr = resolvedIps[serverId];
            excludeAddr.push(isIpv6(addr) ? `${addr}/128` : `${addr}/32`);
          }
        }
      }

      // 恢复至对应平台最稳定的网段。Windows 在 v3.4.0 使用 /16 时非常完美；Mac 在 v3.3.18 使用 /30 时最完美。
      const tunAddress = [
        config.tunConfig?.inet4Address ||
          (process.platform === 'darwin' ? '172.19.0.1/30' : '172.19.0.1/16'),
      ];
      // macOS 默认分配 IPv6 以提高与本地网络服务的兼容性，与 3.3.18 保持一致
      // （此前 darwin / 非 darwin 两分支逻辑完全相同，已合并消重）
      if (config.enableIPv6) {
        tunAddress.push(config.tunConfig?.inet6Address || 'fdfe:dcba:9876::1/126');
      }

      // macOS (3.3.18) 最稳定 MTU 为 1400。Windows (3.4.0) 下 MTU=1350 最完美。
      // 9000 为历史默认值（UI 不暴露 MTU 设置项），等同"未自定义"，必须回退到平台最优值，
      // 否则巨型 MTU 会让上面精心调优的平台值成为永不生效的死代码。
      const platformDefaultMtu = process.platform === 'darwin' ? 1400 : 1350;
      const userMtu = config.tunConfig?.mtu;
      const effectiveMtu = !userMtu || userMtu === 9000 ? platformDefaultMtu : userMtu;

      // macOS 必须 gvisor 栈(3.3.18)；'system' 是历史默认值（UI 不暴露 stack 设置项），在 macOS 上
      // 等同"未自定义"，必须回退到 gvisor，否则同 MTU 一样平台判定成永不生效的死代码。Win/Linux 保持 system。
      const platformDefaultStack = process.platform === 'darwin' ? 'gvisor' : 'system';
      const userStack = config.tunConfig?.stack;
      const effectiveStack =
        !userStack || (process.platform === 'darwin' && userStack === 'system')
          ? platformDefaultStack
          : userStack;

      const tunInbound: SingBoxInbound = {
        type: 'tun',
        tag: 'tun-in',
        address: tunAddress,
        mtu: effectiveMtu,
        auto_route: config.tunConfig?.autoRoute ?? true,
        strict_route: config.tunConfig?.strictRoute ?? true,
        // macOS 必须使用 gvisor 栈(3.3.18)。Windows 下 system 栈配合 Wintun 性能最强且稳定(3.4.0)。
        stack: effectiveStack,
        route_exclude_address: excludeAddr,
      };

      // 兼容 sing-box 1.12.x 版本（打包核心现已全部 ≥1.13.13，此分支仅为向后兼容旧 userData 核心保留），必须在 inbound 定义 sniff 否则无法域名分流。
      // 对于 1.13.0+，嗅探逻辑已经统一由后方 route.rules 承担，但在入站开启会报错，因此需精准版本判断。
      if (!coreVersionAtLeast(this.coreVersion, 1, 13)) {
        (tunInbound as any).sniff = true;
      }

      // macOS 平台特定配置
      if (process.platform === 'darwin') {
        tunInbound.platform = {
          http_proxy: {
            enabled: true,
            server: '127.0.0.1',
            server_port: config.httpPort || 2080,
          },
        };
      }

      inbounds.push(tunInbound);
    }

    return inbounds;
  }

  /** 节点是否可用：naive 需要 libcronet 核心库，缺库时不可用（会被跳过、分流/选中回退到 selector）。 */
  private isNodeUsable(server: ServerConfig): boolean {
    if (server.protocol.toLowerCase() === 'naive' && !resourceManager.hasCronetLib()) {
      return false;
    }
    return true;
  }

  private generateOutbounds(
    selectedServer: ServerConfig,
    config: UserConfig,
    idToTagMap: Map<string, string>
  ): SingBoxOutbound[] {
    const outbounds: SingBoxOutbound[] = [];

    if (config) {
      // 生成【全部】节点的 Outbound：selector 需要列出所有可切换节点；detour 前置节点亦在 config.servers
      // 中，一并生成、通过 detour 字段链接。单个节点配置异常不应拖垮整体配置，逐节点 try/catch 跳过。
      // （app/custom 分流规则指向的固定节点 tag 不变，仍直接命中其节点出站，不经 selector。）
      for (const server of config.servers) {
        const tag = idToTagMap.get(server.id) || `proxy-${server.id}`;
        if (outbounds.some((o) => o.tag === tag)) continue; // 去重
        // 不可用节点跳过：naive 缺 libcronet 时，sing-box 启动会预初始化全部出站、缺库的 naive 会让
        // 整个代理启动 FATAL（连非 naive 节点也用不了）。跳过后，路由层对该节点 tag 的死引用会在
        // generateSingBoxConfig 末尾被统一修正为 selector（见 H2 修复）。
        if (!this.isNodeUsable(server)) {
          this.logToManager(
            'warn',
            `跳过不可用节点「${server.name}」：NaiveProxy 缺少 libcronet 核心库`
          );
          continue;
        }
        try {
          const ob = this.generateProxyOutbound(server, idToTagMap);
          ob.tag = tag;
          if (server.detour && config.servers.some((s) => s.id === server.detour)) {
            // 环检测：沿 detour 链行进，若回到本节点即成环 → 不设 detour，避免 sing-box 报循环引用启动失败
            const seen = new Set<string>([server.id]);
            let cur: string | undefined = server.detour;
            let looped = false;
            while (cur) {
              if (seen.has(cur)) {
                looped = true;
                break;
              }
              seen.add(cur);
              cur = config.servers.find((s) => s.id === cur)?.detour;
            }
            if (looped) {
              this.logToManager('warn', `检测到代理链成环，已跳过 detour: ${server.name}`);
            } else {
              ob.detour = idToTagMap.get(server.detour);
            }
          }
          outbounds.push(ob);
        } catch (e: any) {
          this.logToManager(
            'warn',
            `生成节点出站失败，已跳过: ${server.name} (${e?.message ?? e})`
          );
        }
      }

      // 全局 TLS 分片（PR-6）：开启后对所有已生成的 TCP-TLS 节点出站切分 ClientHello，抗 SNI-DPI。
      // 跳过 hy2/tuic（QUIC 内 TLS、无 TCP ClientHello，死配置）与 naive（Cronet 自管 TLS，拒绝
      // fragment 字段 → 启动 FATAL）。
      if (config.tlsFragment) {
        for (const ob of outbounds) {
          if (ob.tls && ob.type !== 'hysteria2' && ob.type !== 'tuic' && ob.type !== 'naive') {
            ob.tls.fragment = true;
          }
        }
      }

      // selector：列出已生成的全部节点 tag，default 指向当前选中节点；interrupt_exist_connections 由用户
      // 开关决定（默认 false=优雅切换，现有连接保留至自然关闭）。clash_api `PUT /proxies/proxy-selector`
      // 据此热切换、无需重启 sing-box（详见 switchMode）。路由的 final 与「→代理」规则统一指向本 selector。
      const nodeTags = outbounds.map((o) => o.tag).filter((t): t is string => !!t);
      // 所有节点生成失败 → 空 selector 会让 sing-box 启动报含糊错误；这里提前给出清晰原因
      if (nodeTags.length === 0) {
        throw new Error('没有可用的代理节点出站（所有节点配置生成失败）');
      }
      const selectedServerTag = idToTagMap.get(selectedServer.id) || 'proxy';
      outbounds.push({
        type: 'selector',
        tag: 'proxy-selector',
        outbounds: nodeTags,
        default: nodeTags.includes(selectedServerTag) ? selectedServerTag : nodeTags[0],
        interrupt_exist_connections: config.interruptConnectionsOnSwitch === true,
      });
    } else {
      // Fallback if config is missing (shouldn't happen)
      outbounds.push(this.generateProxyOutbound(selectedServer, idToTagMap));
    }

    // 直连出站
    outbounds.push({
      type: 'direct',
      tag: 'direct',
    });

    // 版本条件：sing-box 1.12.x 需要在 outbound 层面做 override_address
    // 因为 1.12 的路由规则不支持 override_address 字段（会被静默忽略）。
    // 1.13+ 已将此功能迁移到路由规则，不需要额外的 outbound。
    if (!coreVersionAtLeast(this.coreVersion, 1, 13)) {
      outbounds.push({
        type: 'direct',
        tag: 'direct-loopback',
        override_address: '127.0.0.1',
      });
    }

    // 阻断出站
    outbounds.push({
      type: 'block',
      tag: 'block',
    });

    // Shadow-TLS 后处理：如果主节点或任意辅助节点使用了 Shadow-TLS，
    // 为每个使用 Shadow-TLS 的节点插入内层 SS outbound
    const stlsOutbounds: SingBoxOutbound[] = [];
    for (const ob of outbounds) {
      // 根据 tag（节点名称）反查对应的 ServerConfig；selector/direct/block 等非节点出站匹配不到 → 跳过
      const srv = config?.servers.find((s) => idToTagMap.get(s.id) === ob.tag);
      if (srv?.shadowTlsSettings) {
        // 创建独立的外层 ShadowTLS outbound
        const stlsTag = `stls-out-${srv.id}`;
        const stlsOutbound: SingBoxOutbound = {
          type: 'shadowtls',
          tag: stlsTag,
          server: srv.address,
          server_port: srv.shadowTlsSettings.port || srv.port,
          version: 3,
          password: srv.shadowTlsSettings.password,
          tls: {
            enabled: true,
            server_name: srv.shadowTlsSettings.sni || undefined,
            utls: {
              enabled: true,
              fingerprint: srv.shadowTlsSettings.fingerprint || 'chrome',
            },
          },
        };
        stlsOutbounds.push(stlsOutbound);

        // 主 outbound (原本的 shadowsocks) 必须作为应用的路由目标
        // 所以我们保留它为 proxy (shadowsocks)，但将其 detour 指向新增的 shadowtls outbound
        ob.detour = stlsTag;

        // 当配置了 detour 后，sing-box 通常期望主 outbound 的 server/port 被忽略
        // 但为了规范，我们可以保留 shadowsocks 的原参数或统一指向实际伪装的地址
        // 在 ShadowTLS 架构中，外层负责 TLS 握手连接真实服务器地址，内层 SS 则是被保护的流量
      }
    }
    outbounds.push(...stlsOutbounds);

    return outbounds;
  }

  /**
   * 生成代理 Outbound 配置（sing-box 1.12.x / 1.13.x 兼容格式）
   */
  private generateProxyOutbound(
    server: ServerConfig,
    idToTagMap: Map<string, string>
  ): SingBoxOutbound {
    // sing-box 要求协议类型必须是小写
    const protocol = server.protocol.toLowerCase();
    const protocolLower = protocol;
    const tlsProtocols = ['trojan', 'anytls', 'hysteria2', 'tuic'];

    const outbound: SingBoxOutbound = {
      type: protocol,
      tag: idToTagMap.get(server.id) || `proxy-${server.id}`,
      server: server.address,
      server_port: server.port,
      // 代理节点域名经 DoH-over-IP 引导解析（dns-bootstrap），免疫 UDP 53 限速/劫持，
      // 避免节点解析失败导致全断流；同时防止 dns-local 死循环导致的连接挂起。
      domain_resolver: 'dns-bootstrap',
    };

    // VLESS 特定配置
    if (protocol === 'vless') {
      outbound.uuid = server.uuid;
      if (server.flow) {
        outbound.flow = server.flow;
      }
      outbound.packet_encoding = 'xudp';
    }

    // VMess 特定配置
    if (protocol === 'vmess') {
      outbound.uuid = server.uuid;
      outbound.security = server.vmessSecurity || 'auto';
      outbound.alter_id = server.alterId || 0;
      outbound.packet_encoding = 'xudp';
    }

    // Trojan 特定配置
    if (protocol === 'trojan') {
      outbound.password = server.password;
    }

    // Hysteria2 特定配置
    if (protocol === 'hysteria2') {
      outbound.password = server.password;

      // 带宽限制
      if (server.hysteria2Settings?.upMbps) {
        outbound.up_mbps = server.hysteria2Settings.upMbps;
      }
      if (server.hysteria2Settings?.downMbps) {
        outbound.down_mbps = server.hysteria2Settings.downMbps;
      }

      // 混淆配置
      if (server.hysteria2Settings?.obfs?.type && server.hysteria2Settings?.obfs?.password) {
        outbound.obfs = {
          type: server.hysteria2Settings.obfs.type,
          password: server.hysteria2Settings.obfs.password,
        };
      }

      // 网络类型 (tcp/udp)
      if (server.hysteria2Settings?.network) {
        outbound.network = server.hysteria2Settings.network;
      }
    }

    // AnyTLS 特定配置
    if (protocol === 'anytls') {
      outbound.password = server.password;
      // AnyTLS 的 TLS 永远开启，这里不需要额外处理，类型检查结尾部分统一生成
      // AnyTLS 会话参数
      if (server.anyTlsSettings?.idleSessionCheckInterval) {
        outbound.idle_session_check_interval = server.anyTlsSettings.idleSessionCheckInterval;
      }
      if (server.anyTlsSettings?.idleSessionTimeout) {
        outbound.idle_session_timeout = server.anyTlsSettings.idleSessionTimeout;
      }
      if (server.anyTlsSettings?.minIdleSession !== undefined) {
        outbound.min_idle_session = server.anyTlsSettings.minIdleSession;
      }
    }

    // Shadowsocks 特定配置
    if (protocol === 'shadowsocks') {
      if (!server.shadowsocksSettings) {
        throw new Error(`Shadowsocks server ${server.name} missing settings`);
      }
      outbound.method = server.shadowsocksSettings.method;
      outbound.password = server.shadowsocksSettings.password;
      if (server.shadowsocksSettings.plugin) {
        outbound.plugin = server.shadowsocksSettings.plugin;
        outbound.plugin_opts = server.shadowsocksSettings.pluginOptions;
      }
    }

    // TUIC 特定配置
    if (server.protocol === 'tuic') {
      outbound.uuid = server.uuid;
      outbound.password = server.password;

      if (server.tuicSettings) {
        if (server.tuicSettings.congestionControl) {
          outbound.congestion_control = server.tuicSettings.congestionControl;
        }
        if (server.tuicSettings.udpRelayMode) {
          outbound.udp_relay_mode = server.tuicSettings.udpRelayMode;
        }
        if (server.tuicSettings.zeroRttHandshake !== undefined) {
          outbound.zero_rtt_handshake = server.tuicSettings.zeroRttHandshake;
        }
        if (server.tuicSettings.heartbeat) {
          outbound.heartbeat = server.tuicSettings.heartbeat;
        }
      }
    }

    // NaiveProxy 特定配置
    if (server.protocol === 'naive') {
      outbound.username = server.username;
      outbound.password = server.password;

      // NaiveProxy specific configuration
      // sing-box 的 naive outbound 由 Cronet 自管 TLS，仅支持 server_name / certificate /
      // certificate_path / ech。下发 alpn 或 insecure:true 会让 sing-box 拒启：
      //   FATAL: initialize outbound: alpn is not supported on naive outbound
      //   FATAL: initialize outbound: insecure is not supported on naive outbound
      // 故这里只下发 server_name（用户在节点上设置的 alpn / allowInsecure 对 naive 无效，忽略）。
      // 参考：https://sing-box.sagernet.org/configuration/outbound/naive/ （TLS 字段限制）
      //       SagerNet/sing-box protocol/naive/outbound.go (v1.13.x) ~L47 的 ALPN/insecure 校验
      outbound.tls = {
        enabled: true,
        server_name: server.tlsSettings?.serverName || server.address,
      };

      // HTTP/3：naive 经 quic:true 走 h3(QUIC/UDP) 拨号传输，对应服务端 `--listen=quic://`。
      // 注意这只改变"拨号传输"：naive 仍只过 TCP（HTTP CONNECT）、不能中继客户端 UDP（除非
      // udp_over_tcp，FlowZ 不下发）。客户端 QUIC 若走到 naive，由 blockQuic（udp443 reject 逼回退 TCP）
      // 或 sing-box 出站层（"UDP is not supported by outbound"）处理；该拨号本身受 fwmark 保护、
      // 绕过 route 规则，不被 reject 误杀（已实测）。
      if (server.naiveSettings?.useHttp3) {
        outbound.quic = true;
      }
    }

    // SOCKS 特定配置
    if (server.protocol === 'socks') {
      if (server.username) outbound.username = server.username;
      if (server.password) outbound.password = server.password;
      // 默认 SOCKS 版本
      (outbound as any).version = '5';
    }

    // HTTP 特定配置
    if (server.protocol === 'http') {
      if (server.username) outbound.username = server.username;
      if (server.password) outbound.password = server.password;

      // HTTP outbound headers mapping can be added if needed via server.httpSettings.headers
      if (server.httpSettings?.headers) {
        if (!outbound.transport) outbound.transport = { type: 'http' };
        outbound.transport.headers = server.httpSettings.headers;
      }
      if (server.httpSettings?.path) {
        if (!outbound.transport) outbound.transport = { type: 'http' };
        outbound.transport.path = server.httpSettings.path;
      }
    }

    // SSH 特定配置
    if (server.protocol === 'ssh') {
      const ssh = server.sshSettings || {};
      if (ssh.user) outbound.user = ssh.user;
      if (ssh.password) outbound.password = ssh.password;
      if (ssh.privateKey) outbound.private_key = ssh.privateKey;
      if (ssh.privateKeyPath) outbound.private_key_path = ssh.privateKeyPath;
      if (ssh.privateKeyPassphrase) outbound.private_key_passphrase = ssh.privateKeyPassphrase;
      if (ssh.hostKey && ssh.hostKey.length > 0) outbound.host_key = ssh.hostKey;
      if (ssh.hostKeyAlgorithms && ssh.hostKeyAlgorithms.length > 0)
        outbound.host_key_algorithms = ssh.hostKeyAlgorithms;
      if (ssh.clientVersion) outbound.client_version = ssh.clientVersion;

      // SSH outbound 不需要 TLS 和传输层配置，直接返回
      return outbound;
    }

    // TLS 配置 (非 Naive 协议，因为 Naive 已在前一段处理了 tls 结构)
    if (
      server.protocol !== 'naive' &&
      (server.security === 'tls' || server.tlsSettings || tlsProtocols.includes(protocol))
    ) {
      // 为 Trojan 设置默认 ALPN ["http/1.1"] 以提高兼容性
      let finalAlpn = server.tlsSettings?.alpn;
      if (!finalAlpn && protocolLower === 'trojan') {
        finalAlpn = ['http/1.1'];
      }

      outbound.tls = {
        enabled: true,
        server_name: server.tlsSettings?.serverName || server.address,
        insecure: server.tlsSettings?.allowInsecure || false,
        alpn: finalAlpn,
      };

      // uTLS 仅适用于基于 TCP 的协议，Hysteria2 和 TUIC 使用 QUIC (UDP) 不支持 uTLS
      const fingerprint = server.tlsSettings?.fingerprint;

      // 默认行为：VLESS 等协议默认开启 chrome 指纹，Trojan 默认不开启（none）以通过标准 TLS 握手
      let finalFingerprint = fingerprint;
      if (!finalFingerprint) {
        if (protocolLower === 'vless' || protocolLower === 'anytls') {
          finalFingerprint = 'chrome';
        } else {
          finalFingerprint = 'none';
        }
      }

      if (
        server.protocol !== 'hysteria2' &&
        server.protocol !== 'tuic' &&
        finalFingerprint !== 'none'
      ) {
        outbound.tls.utls = {
          enabled: true,
          fingerprint: finalFingerprint,
        };
      }

      // ALPN 仅在支持的协议上设置
      if (server.tlsSettings?.alpn) {
        outbound.tls.alpn = server.tlsSettings.alpn;
      }
    }

    // Reality 配置
    if (server.security === 'reality' && server.realitySettings) {
      outbound.tls = {
        enabled: true,
        server_name: server.tlsSettings?.serverName || undefined,
        utls: {
          enabled: true,
          fingerprint: server.tlsSettings?.fingerprint || 'chrome',
        },
        reality: {
          enabled: true,
          public_key: server.realitySettings.publicKey,
          short_id: server.realitySettings.shortId || '',
        },
      };
    }

    // 传输层配置（不适用于 hysteria2、anytls、naive）
    if (
      server.protocol !== 'hysteria2' &&
      server.protocol !== 'anytls' &&
      server.protocol !== 'naive' &&
      server.network &&
      server.network !== 'tcp'
    ) {
      outbound.transport = this.generateTransportConfig(server);
    }

    // PR-6 抗封增强（ECH / TLS 分片 / Multiplex / Hy2 端口跳跃）统一后处理
    this.applyAntiCensorshipOptions(outbound, server);

    return outbound;
  }

  /**
   * PR-6 抗封增强统一后处理：ECH、每节点 TLS 分片、Multiplex(reality+vision 跳过)、Hy2 端口跳跃。
   * 放在 outbound 构建完成后统一处理，避免散落到各协议的 tls/transport 构建点。
   */
  private applyAntiCensorshipOptions(outbound: SingBoxOutbound, server: ServerConfig): void {
    const protocolLower = server.protocol.toLowerCase();

    // fragment 仅对「标准 sing-box TCP-TLS 栈」有意义，以下协议必须排除（否则死配置或直接启动 FATAL）：
    //   · hy2/tuic：TLS 在 QUIC 内、无 TCP ClientHello（死配置）；
    //   · naive：TLS 由 Cronet 自管，naive 出站直接拒绝 fragment 字段（实测
    //     "fragment is not supported on naive outbound" → 启动 FATAL），无论 h2/h3。
    // 注：ECH 不受此限——QUIC 与 naive(Cronet) 均原生支持 ECH。
    const fragmentUnsupported =
      protocolLower === 'hysteria2' || protocolLower === 'tuic' || protocolLower === 'naive';

    // ECH（隐藏 SNI）+ 每节点 TLS 分片（抗 SNI-DPI）：需已有 tls 块
    if (outbound.tls) {
      if (server.tlsSettings?.ech) outbound.tls.ech = { enabled: true };
      if (server.tlsSettings?.fragment && !fragmentUnsupported) outbound.tls.fragment = true;
    }

    // Multiplex（vless/trojan/vmess/shadowsocks）；vision flow(xtls-rprx-vision) 自带流分帧、与 mux
    // 不兼容（与是否 reality 无关，普通 TLS+vision 同样不兼容）→ 跳过
    const mux = server.multiplexSettings;
    const hasVisionFlow = (server.flow || '').toLowerCase().includes('vision');
    if (
      mux?.enabled &&
      ['vless', 'trojan', 'vmess', 'shadowsocks'].includes(protocolLower) &&
      !hasVisionFlow
    ) {
      outbound.multiplex = {
        enabled: true,
        protocol: mux.protocol || 'h2mux',
        ...(mux.maxConnections ? { max_connections: mux.maxConnections } : {}),
        ...(mux.minStreams ? { min_streams: mux.minStreams } : {}),
        ...(mux.padding ? { padding: true } : {}),
      };
    }

    // Hysteria2 端口跳跃（serverPorts 为逗号分隔的范围串，如 "20000:30000"，支持多段）
    if (protocolLower === 'hysteria2' && server.hysteria2Settings?.serverPorts) {
      const ports = server.hysteria2Settings.serverPorts
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (ports.length > 0) {
        outbound.server_ports = ports;
        if (server.hysteria2Settings.hopInterval) {
          outbound.hop_interval = server.hysteria2Settings.hopInterval;
        }
      }
    }
  }

  /**
   * 生成传输层配置
   */
  private generateTransportConfig(server: ServerConfig): SingBoxOutbound['transport'] {
    if (server.network === 'ws' && server.wsSettings) {
      // 0-RTT early-data：订阅/分享链解析时已存入 wsSettings，此前未落运行时配置导致静默失效
      return {
        type: 'ws',
        path: server.wsSettings.path || '/',
        headers: server.wsSettings.headers,
        max_early_data: server.wsSettings.maxEarlyData,
        early_data_header_name: server.wsSettings.earlyDataHeaderName,
      };
    }

    if (server.network === 'grpc' && server.grpcSettings) {
      return {
        type: 'grpc',
        service_name: server.grpcSettings.serviceName || '',
      };
    }

    // httpupgrade：较 ws 更隐蔽的 HTTP Upgrade 传输（复用 ws 的 path / Host）
    if (server.network === 'httpupgrade') {
      return {
        type: 'httpupgrade',
        path: server.wsSettings?.path || '/',
        host: server.wsSettings?.headers?.['Host'] || server.tlsSettings?.serverName,
      };
    }

    return undefined;
  }

  /**
   * 生成路由配置（sing-box 1.12.x / 1.13.x 兼容格式）
   */
  private generateRouteConfig(
    config: UserConfig,
    idToTagMap: Map<string, string>
  ): SingBoxRouteConfig {
    const rules: SingBoxRouteRule[] = [];
    const proxyMode = (config.proxyMode || 'smart').toLowerCase();

    // 主代理出站统一走 selector(proxy-selector)：clash_api 热切换即改 selector 指向、路由无需重生成。
    // 具体 targetServerId 的 app/custom 分流在各自逻辑里直指节点 tag，不经此变量。
    const selectedServerTag = 'proxy-selector';

    // blockQuic（节点无关）：开启时对"将走代理"的 QUIC(UDP443) 执行 reject，逼浏览器回退 TCP。
    // 「禁 QUIC」即禁 QUIC，与选中节点的协议/中继能力无关，对所有节点一视同仁。两点实测保证安全：
    //   · 节点自身的 UDP 拨号(naive-h3/hy2/tuic dial server)无害——拨号是 sing-box 进程自有 socket，
    //     受 fwmark/auto_detect_interface 保护、绕过 route 规则；netns TUN 抓包实测：带 reject udp443
    //     时 hy2 拨号包仍正常逸出（证伪旧假设"reject 经 strict_route 回流误杀拨号"）。
    //   · 不下发"全 UDP reject"——只禁 QUIC(443)。非 QUIC 的代理向 UDP 若节点不能中继(naive/ssh/http)，
    //     由 sing-box 出站层自动拒绝（实测日志 "UDP is not supported by outbound"，不漏 direct、不黑洞），
    //     无需路由层按节点固化。这也使路由配置与选中节点解耦 → 支持 selector 跨协议无缝热切换。
    // 节点无关：只要开了 blockQuic 且存在代理路径（非 direct 模式、有节点）就拦——不依赖 selectedServer
    // 解析成功（避免 selectedServerId 失效但 selector default 仍出流量时 QUIC 漏过）。
    const blockProxyQuic =
      config.blockQuic === true && proxyMode !== 'direct' && config.servers.length > 0;

    // 给定域名匹配器，返回应配对的 udp443 reject 规则（smart 模式放在每条 →代理 规则之前），否则 null。
    const proxyUdpRejectFor = (matcher: Record<string, any>): SingBoxRouteRule | null =>
      blockProxyQuic
        ? ({ ...matcher, network: ['udp'], port: [443], action: 'reject' } as any)
        : null;

    // A. 嗅探规则（必须在前，用于识别域名）
    // 1.13+ 必须在路由层开启 sniff，替代已移除的 inbound 级别 sniff 字段
    // sing-box 1.13.x 嗅探后自动将域名用于路由匹配（等效旧版 sniff_override_destination）
    if (coreVersionAtLeast(this.coreVersion, 1, 13)) {
      rules.push({
        action: 'sniff',
      } as any);
    }

    // 1. 强制放行 sing-box 核心进程：防止流量回流死循环
    // 必须放在最高优先级，确保核心组件的请求能直连物理网卡
    // 注意：不要把 FlowZ (主进程) 放在直连里，否则会干扰 FlowZ 自身的 GitHub 核心下载和测速。
    rules.push({
      process_name: ['sing-box', 'sing-box.exe'],
      action: 'route',
      outbound: 'direct',
    });

    // C. 强制引导核心 DNS 直连（必须在 hijack-dns 之前！）
    // 把已知 bootstrap DNS IP 放在 hijack-dns 之前，无论哪个进程发包都走直连，彻底断环。
    // 注意：这里只应该放国内的 DNS IP。如果放 8.8.8.8，会导致用户去 ping 8.8.8.8 时走直连被墙！
    rules.push({
      ip_cidr: [
        '223.5.5.5/32',
        '223.6.6.6/32',
        '119.29.29.29/32',
        '119.28.28.28/32',
        '114.114.114.114/32',
      ],
      port: [53, 443],
      action: 'route',
      outbound: 'direct',
    });

    // D. DNS 劫持（必须在引导 DNS IP 直连之后）
    // 劫持所有其余 port 53 流量（浏览器/系统 DNS），返回 FakeIP
    rules.push({
      port: [53],
      action: 'hijack-dns',
    });

    // F. 静默屏蔽 ICMP 流量（FakeIP 下常见，但代理节点通常不支持）
    // 放置在靠前位置，防止 ICMP 流量误入不支持的代理出站引发报错
    rules.push({
      protocol: 'icmp',
      action: 'reject',
    } as any);

    rules.push({
      process_name: [
        'Surge',
        'Surge 4',
        'Surge 5',
        'Clash',
        'Clash for Windows',
        'ClashX',
        'ClashX Pro',
        'clash-meta',
        'Quantumult X',
        'sing-box',
        'sing-box.exe',
        'mDNSResponder',
        'apsd',
        'nsurlsessiond',
        'airportd',
        'syspolicyd',
        'trustd',
        'ocspd',
        'securityd',
        'taskgated',
        'findmydeviced',
        'cloudd',
      ],
      action: 'route',
      outbound: 'direct',
    });

    const routeConfig: SingBoxRouteConfig = {
      rules,
      // 核心修复：default_domain_resolver 使用 IP-based DoH 引导解析器 (dns-bootstrap)，
      // 既避免解析 doh.pub 域名时的死循环，又免疫 UDP 53 限速/劫持（dns-bootstrap 同为 IP-based）。
      default_domain_resolver: 'dns-bootstrap',
      auto_detect_interface: true,
      // 如果模式是全局代理 (global/proxy)，则最终出口是所选节点
      final: proxyMode === 'direct' ? 'direct' : selectedServerTag,
    };

    // 【DNS 引导与辅助直连】：
    // 确保以下公共 DNS IP 不会被后面的 block 规则拦截，从而保证 DoH 握手和初次域名解析。
    // 海外 DNS 不应该强行直连（否则在国内会被黑洞）。移除原本强行直连 8.8.8.8 / 1.1.1.1 的设定。

    // 【终极绝杀隐私 DoH 泄漏】：
    // 现代浏览器会尝试通过常规 HTTPS 端口向特定域名发起 DoH 请求。
    // 这里 reject 这些 DoH 域名（发 RST，让浏览器立即回退，而非 block 静默丢包等 21s 重传超时），
    // 迫使浏览器退回系统标准 UDP 53，重新被 hijack-dns 捕获进入 DNS 分流/FakeIP 体系。
    // 与下方同组 DoH 域名的 QUIC/UDP-443 reject 规则保持行为一致。
    rules.push({
      domain_keyword: [
        'dns.google',
        'cloudflare-dns.com',
        'doh.opendns.com',
        'dns.quad9.net',
        'one.one.one.one',
      ],
      port: [443, 853],
      action: 'reject',
    } as any);

    // 排除全部代理节点的域名/IP，确保到任一节点的连接走直连（防回流死循环 + 兼容无缝切换/代理链）。
    // CDN 安全：域名节点用纯域名规则(domain + domain_suffix，靠 sniff 出的 SNI 精确匹配节点域名)，
    //   不预解析为共享 CDN IP（共享 IP 加直连会误伤同 IP 的被墙站点、且抗不住 IP 轮换）；
    //   去掉过宽的 domain_keyword（会误匹配任意"含该域名串"的无关域名）。
    // 仅用户显式填的 IP-literal 节点用 ip_cidr 排除（专用 IP、非共享，安全）。
    // 扩展到全部节点(不止选中)：切节点 / detour 前置代理无需重生成配置即被豁免。
    // 必须放在其他规则之前，否则可能被 geosite-cn 匹配导致死循环。
    {
      const isIpv4 = (host: string) => /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host);
      const isIpv6 = (host: string) => /^[0-9a-fA-F:]+$/.test(host) && host.includes(':');

      const ipSet = new Set<string>();
      const domainSet = new Set<string>();
      for (const s of config.servers) {
        const hosts = [s.address, s.tlsSettings?.serverName].filter(
          (h): h is string => !!h && h.length > 0
        );
        for (const host of hosts) {
          if (isIpv4(host)) ipSet.add(`${host}/32`);
          else if (isIpv6(host)) ipSet.add(`${host}/128`);
          else domainSet.add(host);
        }
      }

      if (domainSet.size > 0) {
        const domains = Array.from(domainSet);
        rules.push({
          // domain(精确，= 节点 SNI) + domain_suffix(仅 .${d}，匹配子域)。不放裸 d 进 domain_suffix：
          // 那是 raw 后缀匹配，会把共享 apex 下别的真实站点也沉降到直连。
          domain: domains,
          domain_suffix: domains.map((d) => `.${d}`),
          action: 'route',
          outbound: 'direct',
        });
      }

      if (ipSet.size > 0) {
        rules.push({
          ip_cidr: Array.from(ipSet),
          action: 'route',
          outbound: 'direct',
        });
      }
    }

    // 0a. U盾/安全插件的本地伪域名 → 强制 127.0.0.1，完全跳过 DNS
    // windows10.microdone.cn 等域名是 U盾厂商注册在本地的专用域名，公网 DNS 中不存在。
    // 普通 direct outbound 会先做 DNS 解析 → NXDOMAIN → 连接失败。
    // 版本分支：
    //   1.12.x → 使用 direct-loopback outbound（outbound 层面 override_address）
    //   1.13+  → 使用路由规则层面的 override_address（outbound 层面已移除此功能）
    const UKEY_LOCAL_DOMAINS = ['.microdone.cn'];
    const otherBankDomains = DOMESTIC_BANK_AND_STOCK_DOMAINS.filter(
      (d) => !UKEY_LOCAL_DOMAINS.includes(d)
    );

    if (coreVersionAtLeast(this.coreVersion, 1, 13)) {
      // 1.13+：路由规则支持 override_address
      rules.push({
        domain_suffix: UKEY_LOCAL_DOMAINS,
        action: 'route',
        outbound: 'direct',
        override_address: '127.0.0.1',
      });
    } else {
      // 1.12.x：使用专用的 direct-loopback outbound
      rules.push({
        domain_suffix: UKEY_LOCAL_DOMAINS,
        action: 'route',
        outbound: 'direct-loopback',
      });
    }

    // 0b. 其余银行/证券域名 → 普通 direct（正常 DNS 解析，这些域名在公网真实存在）
    if (otherBankDomains.length > 0) {
      rules.push({
        domain_suffix: otherBankDomains,
        action: 'route',
        outbound: 'direct',
      });
    }

    // 1. 私有 IP 段直连（内网地址不应该经过代理，优先级最高）
    // 仅当用户未关闭"绕过局域网"时添加
    if (config.bypassLAN !== false) {
      rules.push({
        ip_cidr: PRIVATE_IP_CIDRS,
        action: 'route',
        outbound: 'direct',
      });
    }

    // Bug 4 修复：删除此处重复的 QUIC 阻断规则
    // 第一条 QUIC reject 规则已在上方（生成 routeConfig 之前）添加，此处重复添加会造成规则冗余
    // reject 比 block 更合适（发 TCP RST 让浏览器立即回退到 TCP，而不是静默丢弃造成等待超时）

    // 3. 自定义规则（优先级次之，允许用户覆盖后续默认行为）
    if (proxyMode !== 'direct') {
      const { rules: customRules, ruleSets: customRuleSets } = this.generateCustomRules(
        config.customRules || [],
        config.customRuleSets || [],
        config.selectedServerId || undefined,
        idToTagMap,
        selectedServerTag
      );
      // 走代理的自定义规则同样要配对 udp443 reject（终止规则、在末尾兜底前命中）。逐条插入：
      // 代理向规则前先放一条同匹配器的 udp443 reject；direct/block 规则不配对。
      for (const cr of customRules) {
        if (
          cr.action === 'route' &&
          cr.outbound &&
          cr.outbound !== 'direct' &&
          cr.outbound !== 'block'
        ) {
          const matcher: Record<string, any> = {};
          if (cr.domain) matcher.domain = cr.domain;
          if (cr.domain_suffix) matcher.domain_suffix = cr.domain_suffix;
          if (cr.domain_keyword) matcher.domain_keyword = cr.domain_keyword;
          if (cr.rule_set) matcher.rule_set = cr.rule_set;
          if (cr.ip_cidr) matcher.ip_cidr = cr.ip_cidr;
          if (Object.keys(matcher).length > 0) {
            const r = proxyUdpRejectFor(matcher);
            if (r) rules.push(r);
          }
        }
        rules.push(cr);
      }

      if (customRuleSets.length > 0) {
        if (!routeConfig.rule_set) {
          routeConfig.rule_set = [];
        }
        routeConfig.rule_set.push(...customRuleSets);
      }

      // 排除进程规则：优先级最高，在应用分流之前插入，确保用户明确指定绕过的进程不被任何规则覆盖
      if (config.bypassProcesses && config.bypassProcesses.length > 0) {
        rules.push({
          process_name: config.bypassProcesses,
          action: 'route',
          outbound: 'direct',
        });
      }

      // 应用分流规则（真·应用分流，基于进程名）
      // 优先级高于后续的智能分流/全局分流，确保特定应用的流量始终走用户指定的出口
      for (const appRule of config.appRules || []) {
        if (!appRule.enabled) continue;
        const preset = getAppPreset(appRule.appId, config.customAppPresets);
        if (!preset) continue;

        // 确定出站方式
        let outbound = 'direct';
        if (appRule.action === 'proxy') {
          if (appRule.targetServerId && appRule.targetServerId !== config.selectedServerId) {
            const serverExists = config.servers.some((s) => s.id === appRule.targetServerId);
            outbound = serverExists
              ? idToTagMap.get(appRule.targetServerId) || `proxy-${appRule.targetServerId}`
              : selectedServerTag;
          } else {
            outbound = selectedServerTag;
          }
        } else if (appRule.action === 'block') {
          outbound = 'block';
        }

        // 走代理的 app 分流也要配对 udp443 reject（这些是终止规则、在末尾兜底之前命中，否则 blockQuic
        // 对该应用的 QUIC 失效）。direct/block 不配对。
        const appOutIsProxy = outbound !== 'direct' && outbound !== 'block';

        // a. 基于进程名的规则（最精准，适用于 macOS/Windows TUN 模式）
        if (preset.processNames && preset.processNames.length > 0) {
          if (appOutIsProxy) {
            const r = proxyUdpRejectFor({ process_name: preset.processNames });
            if (r) rules.push(r);
          }
          rules.push({
            process_name: preset.processNames,
            action: 'route',
            outbound,
          });
        }

        // b. 基于原有 rule_set 的规则（兜底，基于域名/IP 识别）
        const ruleSets = [
          ...preset.geositeTags.map((tag) => `geosite-${tag}`),
          ...(preset.geoipTags || []).map((tag) => `geoip-${tag}`),
        ];

        if (ruleSets.length > 0) {
          if (appOutIsProxy) {
            const r = proxyUdpRejectFor({ rule_set: ruleSets });
            if (r) rules.push(r);
          }
          rules.push({
            rule_set: ruleSets,
            action: 'route',
            outbound,
          });
        }
      }
    }

    // 【QUIC 阻断】：放在自定义规则和应用分流之后，确保用户的 direct/proxy 规则优先级更高
    // 这样游戏设为直连时，进程名匹配在前，游戏的 UDP 流量不会被误拒。
    // 仅阻断浏览器的 DoH over QUIC，迫使浏览器回退到系统 UDP 53 + hijack-dns 体系。
    // 重要：不能全量 reject 所有 UDP 443，否则 Hysteria2/TUIC 等 QUIC 协议节点会被误伤。
    rules.push({
      domain_keyword: [
        'dns.google',
        'cloudflare-dns.com',
        'doh.opendns.com',
        'dns.quad9.net',
        'one.one.one.one',
      ],
      network: ['udp'],
      port: [443],
      action: 'reject',
    } as any);

    // 【DNS 死循环防范】：sing-box 本地 DNS 解析器的请求必须强制直连，否则在全局代理模式下会产生死循环
    // 兼容 Windows 1.12.x 版本，不使用 DNS 配置里的 detour
    rules.push({
      protocol: 'dns',
      action: 'route',
      outbound: 'direct',
    } as any);

    rules.push({
      ip_cidr: ['223.5.5.5/32'],
      port: [53, 443],
      action: 'route',
      outbound: 'direct',
    });

    rules.push({
      domain_suffix: ['doh.pub'],
      action: 'route',
      outbound: 'direct',
    });

    // 【通用修复：Chrome/Edge 心跳 beacon 域名强制直连 —— global 和 smart 模式均生效】
    // gvt2.com / gvt1.com 是 Google CDN 心跳；clientservices / oauthaccountmanager /
    // optimizationguide-pa 是 Chrome 账号同步、FCM Push 和优化引导的后台服务。
    // 这些域名对代理节点出口通常限速或屏蔽（非浏览行为），一旦持续超时会耗尽连接池，
    // 导致所有正常网页也超时 —— 即"过一会就断网"现象。
    // 在 global 和 smart 两种模式下均强制直连，彻底消除对连接池的占用。
    if (proxyMode !== 'direct') {
      rules.push({
        domain_suffix: [
          // Google CDN 心跳
          'gvt2.com',
          'gvt1.com',
          // Chrome 账号同步 / FCM Push 后台
          'oauthaccountmanager.googleapis.com',
          'clientservices.googleapis.com',
          // Chrome 优化引导服务
          'optimizationguide-pa.googleapis.com',
          // Google FCM 推送 (port 5228)
          'mtalk.google.com',
          // Android 客户端服务
          'android.clients.google.com',
          // Chrome / GMS clients
          'clients1.google.com',
          'clients2.google.com',
          'clients3.google.com',
          'clients4.google.com',
          'clients5.google.com',
          'clients6.google.com',
          // 自动更新检查
          'update.googleapis.com',
        ],
        action: 'reject',
      });
    }

    // 智能分流规则（仅在智能分流模式下启用）
    if (proxyMode === 'smart') {
      // 已移除 ::/0 block，因为 block 是静默丢包，会导致 Chrome 等浏览器在发起 TCP SYN 包时陷入漫长的 21 秒重传等待（Happy Eyeballs 假死），
      // 从而让用户以为“所有的海外网站全都打不开了”。我们必须依靠浏览器的原生 fallback，或者直接让 Mac 本机关闭 IPv6 分配。

      // 针对 Google 核心服务（搜索/YouTube/Gmail 等）的关键词兜底规则（仅在未专门设置应用分流时作为备份）
      // 注意：这些规则在 AppRules 之后，所以不会覆盖用户手动指定的节点
      const googleKeywords = ['google', 'gmail', 'youtube', 'gstatic', 'googleapis', 'googlevideo'];

      // 代理向 UDP（smart）：在每条"→代理"规则之前配对一条 reject，使该走代理的 UDP 在被路由到代理
      // 前就 reject——不能中继的节点拦全部 UDP，能中继+blockQuic 仅拦 QUIC(UDP443)。下方 CN 直连规则
      // 不配对，故 CN/直连 UDP 不受影响（兜底见 generateRouteConfig 末尾）。
      const googleUdpReject = proxyUdpRejectFor({ domain_keyword: googleKeywords });
      if (googleUdpReject) rules.push(googleUdpReject);
      rules.push({
        domain_keyword: googleKeywords,
        action: 'route',
        outbound: selectedServerTag,
      });

      // 国外域名走代理
      const foreignUdpReject = proxyUdpRejectFor({ rule_set: 'geosite-geolocation-!cn' });
      if (foreignUdpReject) rules.push(foreignUdpReject);
      rules.push({
        rule_set: 'geosite-geolocation-!cn',
        action: 'route',
        outbound: selectedServerTag,
      });
      // 中国域名直连
      rules.push({
        rule_set: 'geosite-cn',
        action: 'route',
        outbound: 'direct',
      });
      // 中国 IP 直连
      rules.push({
        rule_set: 'geoip-cn',
        action: 'route',
        outbound: 'direct',
      });
    }

    // 添加 rule_set（除非是直连模式）
    // 直连模式下不需要 rule_set，因为全部走 direct
    if (proxyMode !== 'direct') {
      if (!routeConfig.rule_set) {
        routeConfig.rule_set = [];
      }
      routeConfig.rule_set.push(
        {
          tag: 'geosite-cn',
          type: 'local',
          format: 'binary',
          path: path.join(getUserDataPath(), 'rules', 'geosite-cn.srs'),
        },
        {
          tag: 'geosite-geolocation-!cn',
          type: 'local',
          format: 'binary',
          path: path.join(getUserDataPath(), 'rules', 'geosite-geolocation-!cn.srs'),
        },
        {
          tag: 'geoip-cn',
          type: 'local',
          format: 'binary',
          path: path.join(getUserDataPath(), 'rules', 'geoip-cn.srs'),
        }
      );
    }

    // 添加自定义规则和应用分流所需的 Geosite/GeoIP rule_set
    const { geosite: customGeositeCategories, geoip: customGeoipCategories } =
      this.getRequiredGeoCategories(
        config.customRules || [],
        config.appRules || [],
        config.customAppPresets || []
      );

    if (customGeositeCategories.size > 0 || customGeoipCategories.size > 0) {
      if (!routeConfig.rule_set) {
        routeConfig.rule_set = [];
      }

      // Bug 2 修复：
      // 1. 使用 fastly.jsdelivr.net CDN 加速，替代直连 raw.githubusercontent.com（在中国大陆常被封锁）
      // 2. download_detour 改为 'direct'，避免循环依赖（代理需要规则集才能启动，规则集需要代理才能下载）
      //    sing-box 启动时规则集下载必须走直连，后续更新可以走代理
      // 3. 注意：不是所有 geosite 标签都有独立的 .srs 文件（如 geosite-bbc.srs 不存在）
      //    如果下载失败，sing-box 会使用缓存版本，如无缓存则跳过该规则集

      // 添加 Geosite 远程规则集
      for (const category of Array.from(customGeositeCategories)) {
        // 构建镜像 URL：优先使用 fastly CDN，提升中国大陆可用性
        const geositeUrl =
          category === 'category-ai'
            ? 'https://fastly.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-category-ai-!cn.srs'
            : `https://fastly.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-${category}.srs`;

        routeConfig.rule_set.push({
          tag: `geosite-${category}`,
          type: 'remote',
          format: 'binary',
          url: geositeUrl,
          // 必须走直连下载，避免启动时循环依赖
          download_detour: 'direct',
        } as any);
      }

      // 添加 GeoIP 远程规则集
      for (const category of Array.from(customGeoipCategories)) {
        routeConfig.rule_set.push({
          tag: `geoip-${category}`,
          type: 'remote',
          format: 'binary',
          url: `https://fastly.jsdelivr.net/gh/SagerNet/sing-geoip@rule-set/geoip-${category}.srs`,
          // 必须走直连下载，避免启动时循环依赖
          download_detour: 'direct',
        } as any);
      }
    }

    // 【代理向 QUIC 兜底】：放在所有直连/分流规则之后，拦截"会落到 final(代理)"的剩余 QUIC(udp443)。
    // global 模式拦全部代理向 QUIC；smart 模式拦未被上方 →代理 配对 reject 命中的（CN 已直连豁免）。
    // 只拦 QUIC——非 QUIC 的代理向 UDP 若节点不能中继，由 sing-box 出站层自动拒绝（见上方 blockProxyQuic）。
    if (blockProxyQuic) {
      rules.push({ network: ['udp'], port: [443], action: 'reject' } as any);
    }

    return routeConfig;
  }

  /**
   * 收集自定义规则中使用的 Geosite 类别（同时扫描 customRules 和 appRules）
   */
  /**
   * 收集自定义规则中使用的 Geosite 和 GeoIP 类别（同时扫描 customRules 和 appRules）
   */
  private getRequiredGeoCategories(
    customRules: import('../../shared/types').DomainRule[],
    appRules: import('../../shared/types').AppRule[] = [],
    customAppPresets: import('../../shared/types').CustomAppPreset[] = []
  ): { geosite: Set<string>; geoip: Set<string> } {
    const geositeCategories = new Set<string>();
    const geoipCategories = new Set<string>();

    // 扫描手动定义的 geosite: 域名规则
    for (const rule of customRules) {
      if (!rule.enabled) continue;
      for (const domain of rule.domains) {
        if (domain.startsWith('geosite:')) {
          geositeCategories.add(domain.slice(8));
        }
      }
    }

    // 扫描应用分流规则
    for (const appRule of appRules) {
      if (!appRule.enabled) continue;
      const preset = getAppPreset(appRule.appId, customAppPresets);
      if (preset) {
        preset.geositeTags.forEach((tag) => geositeCategories.add(tag));
        if (preset.geoipTags) {
          preset.geoipTags.forEach((tag) => geoipCategories.add(tag));
        }
      }
    }
    return { geosite: geositeCategories, geoip: geoipCategories };
  }

  private generateCustomRules(
    customRules: import('../../shared/types').DomainRule[],
    customRuleSets: import('../../shared/types').CustomRuleSet[] = [],
    selectedServerId?: string,
    idToTagMap?: Map<string, string>,
    selectedServerTag: string = 'proxy'
  ): { rules: SingBoxRouteRule[]; ruleSets: SingBoxRuleSet[] } {
    const rules: SingBoxRouteRule[] = [];
    const ruleSets: SingBoxRuleSet[] = [];

    // 处理旧的 DomainRule (纯文本域名/geosite类)
    for (const rule of customRules) {
      if (
        !rule.enabled ||
        (rule.domains.length === 0 && (!rule.ipCidr || rule.ipCidr.length === 0))
      )
        continue;

      // 统一使用 domain_suffix，匹配域名及其所有子域名
      // 如 google.com 会匹配 google.com、www.google.com、mail.google.com 等
      // 同时支持 geosite: 前缀，转换为 rule_set
      const domainSuffix: string[] = [];
      const geositeTags: string[] = [];

      for (const d of rule.domains) {
        if (d.startsWith('geosite:')) {
          const category = d.slice(8);
          geositeTags.push(`geosite-${category}`);
        } else {
          domainSuffix.push(d.startsWith('*.') ? d.slice(2) : d);
        }
      }

      // 如果有普通域名或 IP CIDR，创建一条规则
      if (domainSuffix.length > 0 || (rule.ipCidr && rule.ipCidr.length > 0)) {
        const singboxRule: SingBoxRouteRule = {
          action: 'route',
        };

        if (domainSuffix.length > 0) {
          // domain_suffix 匹配该域名及所有子域名（如 bbc.com 匹配 www.bbc.com）
          singboxRule.domain_suffix = domainSuffix;
        }

        if (rule.ipCidr && rule.ipCidr.length > 0) {
          singboxRule.ip_cidr = rule.ipCidr;
        }

        // Bug 1 修复：必须传入 idToTagMap 和 selectedServerTag，
        // 否则 selectedServerTag 默认为 'proxy'，而实际出站标签是节点名称，导致 sing-box 启动失败
        this.applyRuleAction(
          singboxRule,
          rule.action,
          rule.targetServerId,
          selectedServerId,
          idToTagMap,
          selectedServerTag
        );
        rules.push(singboxRule);
      }

      // 如果有 Geosite 引用，创建一条规则
      if (geositeTags.length > 0) {
        const singboxRule: SingBoxRouteRule = {
          action: 'route',
          rule_set: geositeTags,
        };
        // Bug 1 修复：同上，必须传入完整参数确保 outbound 标签正确
        this.applyRuleAction(
          singboxRule,
          rule.action,
          rule.targetServerId,
          selectedServerId,
          idToTagMap,
          selectedServerTag
        );
        rules.push(singboxRule);
      }
    }

    // 处理新的 Remote RuleSet
    let ruleSetIndex = 1;
    for (const ruleSet of customRuleSets) {
      if (!ruleSet.enabled || !ruleSet.url) continue;

      const tag = `custom-ruleset-${ruleSetIndex++}`;
      ruleSets.push({
        tag,
        type: 'remote',
        format: 'binary',
        url: ruleSet.url,
        download_detour: selectedServerTag, // 默认通过当前选中的代理下载自定义规则集
      } as any);

      const singboxRule: SingBoxRouteRule = {
        action: 'route',
        rule_set: [tag],
      };

      // 此处的 CustomRuleSet 只包含 action 而无 targetServerId，不过统一走 applyRuleAction 判断
      this.applyRuleAction(
        singboxRule,
        ruleSet.action,
        undefined,
        selectedServerId,
        idToTagMap,
        selectedServerTag
      );
      rules.push(singboxRule);
    }

    return { rules, ruleSets };
  }

  /**
   * 应用规则动作到 sing-box 规则对象
   */
  private applyRuleAction(
    singboxRule: SingBoxRouteRule,
    action: string,
    targetServerId?: string,
    selectedServerId?: string,
    idToTagMap?: Map<string, string>,
    selectedServerTag: string = 'proxy'
  ): void {
    // 设置出站
    if (action === 'proxy') {
      // 如果指定了目标服务器，且不是主节点，则路由到特定的 outbound tag
      if (targetServerId && selectedServerId !== targetServerId) {
        const targetTag = idToTagMap?.get(targetServerId);
        singboxRule.outbound = targetTag || `proxy-${targetServerId}`;
      } else {
        singboxRule.outbound = selectedServerTag;
      }
    } else if (action === 'direct') {
      singboxRule.outbound = 'direct';
    } else if (action === 'block') {
      singboxRule.outbound = 'block';
    } else {
      // 如果没有指定，默认使用主节点
      singboxRule.outbound = selectedServerTag;
    }
  }

  /**
   * 写入 sing-box 配置文件
   */
  private async writeSingBoxConfig(config: SingBoxConfig): Promise<void> {
    const content = JSON.stringify(config, null, 2);
    await fs.writeFile(this.configPath, content, 'utf-8');
  }

  /**
   * 检查当前配置是否需要 root/admin 权限（TUN 模式）
   * Windows 和 macOS 的 TUN 模式都需要管理员权限
   */
  private needsRootPrivilege(): boolean {
    const isTunMode = this.currentConfig?.proxyModeType === 'tun';
    // Windows, macOS, and Linux TUN 模式都需要管理员权限
    return (
      isTunMode &&
      (process.platform === 'darwin' ||
        process.platform === 'win32' ||
        process.platform === 'linux')
    );
  }

  /**
   * 检查是否需要使用 osascript 运行（仅 macOS）
   */
  private needsOsascript(): boolean {
    return process.platform === 'darwin' && this.needsRootPrivilege();
  }

  /**
   * 检查是否需要使用 UAC 提升权限运行（仅 Windows TUN 模式）
   */
  private needsWindowsUAC(): boolean {
    return process.platform === 'win32' && this.needsRootPrivilege();
  }

  /**
   * 修复可能被 root 创建的文件权限（macOS）
   * 当从 TUN 模式切换到系统代理模式时，某些文件可能仍然属于 root
   * 需要在普通用户模式下修复这些文件的权限
   */
  private async fixFilePermissions(): Promise<void> {
    // 只在 macOS 上需要处理
    if (process.platform !== 'darwin') {
      return;
    }

    // 如果是 TUN 模式，不需要修复（会以 root 权限运行）
    if (this.needsRootPrivilege()) {
      return;
    }

    const userDataPath = getUserDataPath();
    const filesToFix = [
      getCachePath(),
      getSingBoxLogPath(),
      getSingBoxPidPath(),
      path.join(userDataPath, 'singbox_startup.log'),
    ];

    const fsSync = require('fs');
    const { execSync } = require('child_process');

    for (const filePath of filesToFix) {
      try {
        if (fsSync.existsSync(filePath)) {
          const stats = fsSync.statSync(filePath);
          // 检查文件是否属于 root (uid 0)
          if (stats.uid === 0) {
            this.logToManager('info', `修复文件权限: ${filePath}`);
            // 使用 chown 修改文件所有权为当前用户
            const currentUser = process.env.USER || process.env.LOGNAME;
            if (currentUser) {
              try {
                // 尝试使用 chown（可能需要密码）
                execSync(`chown ${currentUser} "${filePath}"`, { stdio: 'ignore' });
              } catch {
                // 如果 chown 失败，尝试删除文件让 sing-box 重新创建
                try {
                  fsSync.unlinkSync(filePath);
                  this.logToManager('info', `已删除需要重新创建的文件: ${filePath}`);
                } catch {
                  this.logToManager(
                    'warn',
                    `无法修复文件权限: ${filePath}，请手动删除或运行: sudo chown ${currentUser} "${filePath}"`
                  );
                }
              }
            }
          }
        }
      } catch {
        // 忽略检查错误
      }
    }
  }

  /**
   * 启动 sing-box 进程
   */
  private async startSingBoxProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // 检查 sing-box 可执行文件是否存在
        const fs = require('fs');
        if (!fs.existsSync(this.singboxPath)) {
          const error = new Error(`找不到 sing-box 可执行文件: ${this.singboxPath}`);
          this.logToManager('error', error.message);
          reject(error);
          return;
        }

        // Linux TUN 模式下的智能提权逻辑 (setcap)
        if (process.platform === 'linux' && this.needsRootPrivilege()) {
          try {
            const { execSync } = require('child_process');
            // 检查当前是否有 cap_net_admin
            const caps = execSync(`getcap "${this.singboxPath}"`, { encoding: 'utf-8' });
            if (!caps.includes('cap_net_admin')) {
              this.logToManager('info', 'Linux 核心缺失网络权限，正在请求提权...');
              // 使用 pkexec 调用 setcap 赋权
              execSync(
                `pkexec setcap 'cap_net_admin,cap_net_bind_service,cap_net_raw=+ep' "${this.singboxPath}"`
              );
              this.logToManager('info', 'Linux 核心提权成功');
            }
          } catch (err) {
            this.logToManager('error', `Linux 核心提权失败: ${(err as Error).message}`);
            // 不在此直接 reject，继续执行（用户可能通过其它方式提权或容错）
          }
        }

        // 根据平台和模式选择启动方式：
        // - macOS TUN 模式: 使用 osascript 请求管理员权限
        // - Windows TUN 模式: 使用 PowerShell Start-Process -Verb RunAs 请求 UAC 权限
        // - 其他情况: 直接运行
        let command: string;
        let args: string[];

        if (this.needsOsascript()) {
          // macOS: 使用 osascript 请求管理员权限运行
          // 注意：路径中可能包含空格，需要使用转义引号
          // sing-box 配置中已经设置了 log.output，日志会写入文件
          // 使用 & 让进程在后台运行，并将 PID 写入文件
          const pidFile = getSingBoxPidPath();
          const startupLogFile = path.join(getUserDataPath(), 'singbox_startup.log');
          command = '/usr/bin/osascript';

          // 如果开启了局域网共享且是 TUN 模式，同时开启系统的 IP 转发功能
          const forwardCmd = this.currentConfig?.allowLan
            ? 'sysctl -w net.ipv4.ip_forward=1; sysctl -w net.ipv6.conf.all.forwarding=1; '
            : '';

          // 使用 bash -c 来执行后台命令，确保 & 正常工作
          // 重定向 stdout 和 stderr 到日志文件，以便排查启动失败原因
          args = [
            '-e',
            `do shell script "/bin/bash -c '${forwardCmd}\\"${this.singboxPath}\\" run -c \\"${this.configPath}\\" > \\"${startupLogFile}\\" 2>&1 & echo $! > \\"${pidFile}\\"'" with administrator privileges`,
          ];
          this.logToManager(
            'info',
            `TUN 模式需要管理员权限${this.currentConfig?.allowLan ? '及开启 IP 转发' : ''}，正在请求...`
          );
        } else if (this.needsWindowsUAC()) {
          // Windows TUN 模式: 使用 PowerShell 请求 UAC 权限运行
          // 使用 Start-Process -Verb RunAs 来请求管理员权限
          const pidFile = getSingBoxPidPath();
          command = 'powershell.exe';

          // PowerShell 脚本：以管理员权限启动 sing-box 并记录 PID
          // 使用数组构建脚本避免模板字符串中 $ 被 JS 解析
          // 详细日志输出到 singbox_startup.log 帮助诊断启动问题
          const startupLogFile = path.join(getUserDataPath(), 'singbox_startup.log');
          const singboxPathEsc = this.singboxPath.replace(/'/g, "''");
          const configPathEsc = this.configPath.replace(/'/g, "''");
          const pidFileEsc = pidFile.replace(/'/g, "''");
          const logFileEsc = startupLogFile.replace(/'/g, "''");

          // Windows 局域网转发支持
          const forwardPsCmd = this.currentConfig?.allowLan
            ? 'Set-NetIPInterface -Forwarding Enabled; Set-NetIPInterface -AddressFamily IPv6 -Forwarding Enabled; '
            : '';

          const psScript = [
            "$ErrorActionPreference = 'Stop'",
            "$logFile = '" + logFileEsc + "'",
            "$pidFile = '" + pidFileEsc + "'",
            "$singboxPath = '" + singboxPathEsc + "'",
            "$configPath = '" + configPathEsc + "'",
            'try {',
            "  'Starting sing-box...' | Out-File -FilePath $logFile -Encoding UTF8",
            forwardPsCmd
              ? "  'Enabling IP Forwarding...' | Out-File -FilePath $logFile -Append -Encoding UTF8"
              : '',
            forwardPsCmd,
            "  'SingboxPath: ' + $singboxPath | Out-File -FilePath $logFile -Append -Encoding UTF8",
            "  'ConfigPath: ' + $configPath | Out-File -FilePath $logFile -Append -Encoding UTF8",
            "  if (-not (Test-Path $singboxPath)) { 'ERROR: sing-box not found' | Out-File -FilePath $logFile -Append -Encoding UTF8; exit 1 }",
            "  if (-not (Test-Path $configPath)) { 'ERROR: config not found' | Out-File -FilePath $logFile -Append -Encoding UTF8; exit 1 }",
            "  'Starting with UAC...' | Out-File -FilePath $logFile -Append -Encoding UTF8",
            "  $process = Start-Process -FilePath $singboxPath -ArgumentList 'run','-c',$configPath -Verb RunAs -PassThru -WindowStyle Hidden",
            '  if ($process -and $process.Id) {',
            "    'Process started PID: ' + $process.Id | Out-File -FilePath $logFile -Append -Encoding UTF8",
            '    $process.Id | Out-File -FilePath $pidFile -Encoding ASCII -NoNewline',
            '    exit 0',
            '  } else {',
            "    'ERROR: Start-Process returned null' | Out-File -FilePath $logFile -Append -Encoding UTF8",
            '    exit 1',
            '  }',
            '} catch {',
            "  'ERROR: ' + $_.Exception.Message | Out-File -FilePath $logFile -Append -Encoding UTF8",
            '  exit 1',
            '}',
          ].join('; ');

          args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript];
          this.logToManager(
            'info',
            `TUN 模式需要管理员权限${
              this.currentConfig?.allowLan ? '及开启 IP 转发' : ''
            }，正在请求 UAC 授权...`
          );
        } else {
          // 系统代理模式或 Linux：直接运行
          command = this.singboxPath;
          args = ['run', '-c', this.configPath];
        }

        // 启动进程
        // 关键：为 sing-box 1.12.x 注入环境变量以启用已弃用的 override_address 功能
        // 这是银行 U盾本地域名（如 windows10.microdone.cn → 127.0.0.1）正常工作的前提。
        // 1.13+ 已将此功能迁移到路由规则，不需要此环境变量。
        const spawnEnv = { ...process.env };
        if (!coreVersionAtLeast(this.coreVersion, 1, 13)) {
          spawnEnv['ENABLE_DEPRECATED_DESTINATION_OVERRIDE_FIELDS'] = 'true';
        }

        this.singboxProcess = spawn(command, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: spawnEnv,
        });

        // 记录启动信息
        this.pid = this.singboxProcess.pid || null;
        this.startTime = new Date();

        // macOS/Windows TUN 模式下，这个 PID 是 osascript/PowerShell 的 PID，不是 sing-box 的
        // 实际的 sing-box PID 会在 waitForPidFile 中从 PID 文件读取
        if (this.needsOsascript() || this.needsWindowsUAC()) {
          this.logToManager('info', `正在启动 sing-box（权限提升进程 PID: ${this.pid}）...`);
        } else {
          this.logToManager('info', `正在启动 sing-box 进程 (PID: ${this.pid})...`);
        }

        // 监听进程输出
        if (this.singboxProcess.stdout) {
          this.singboxProcess.stdout.on('data', (data: Buffer) => {
            this.handleProcessOutput(data.toString());
          });
        }

        if (this.singboxProcess.stderr) {
          this.singboxProcess.stderr.on('data', (data: Buffer) => {
            const output = data.toString();
            this.lastErrorOutput = output;
            this.handleProcessOutput(output);
          });
        }

        // 监听进程事件
        this.singboxProcess.on('error', (error) => {
          console.error('sing-box process error:', error);
          const friendlyError = this.parseLaunchError(error);
          this.logToManager('error', friendlyError);
          this.handleProcessError(error);
          reject(new Error(friendlyError));
        });

        this.singboxProcess.on('exit', (code, signal) => {
          console.log(`sing-box process exited with code ${code}, signal ${signal}`);

          // 对于 macOS TUN 模式，osascript 退出码为 0 表示成功启动了后台进程
          if (this.needsOsascript()) {
            if (code === 0) {
              // osascript 成功执行，sing-box 在后台运行
              // PID 文件读取由 setTimeout 中的 waitForPidFile 统一处理
              return; // 不调用 handleProcessExit，因为 sing-box 还在运行
            } else {
              // osascript 执行失败（用户取消或其他错误）
              const errorMessage =
                code === 1 ? '用户取消了管理员权限请求' : `启动失败，退出码: ${code}`;
              this.logToManager('error', errorMessage);
              reject(new Error(errorMessage));
              this.handleProcessExit(code, signal);
              return;
            }
          }

          // 对于 Windows TUN 模式，PowerShell 退出码为 0 表示成功启动了 sing-box
          if (this.needsWindowsUAC()) {
            if (code === 0) {
              // PowerShell 成功执行，sing-box 以管理员权限在后台运行
              // PID 文件读取由 setTimeout 中的 waitForPidFile 统一处理
              return; // 不调用 handleProcessExit，因为 sing-box 还在运行
            } else {
              // PowerShell 执行失败（用户取消 UAC 或其他错误）
              const errorMessage =
                code === 1 ? '用户取消了管理员权限请求' : `UAC 授权失败，退出码: ${code}`;
              this.logToManager('error', errorMessage);
              reject(new Error(errorMessage));
              this.handleProcessExit(code, signal);
              return;
            }
          }

          // 如果在启动阶段就退出了，说明启动失败
          const startupTime = Date.now() - (this.startTime?.getTime() || Date.now());
          if (startupTime < 2000 && code !== null && code !== 0) {
            const errorMessage = this.parseStartupError(code, this.lastErrorOutput);
            this.logToManager('error', errorMessage);
            reject(new Error(errorMessage));
          }

          this.handleProcessExit(code, signal);
        });

        // 等待一小段时间确保进程启动成功
        setTimeout(async () => {
          // macOS TUN 模式或 Windows TUN 模式：检查 singboxPid（从 PID 文件读取）
          // 其他模式：检查 singboxProcess 和 pid
          const isMacTunMode = this.needsOsascript();
          const isWindowsTunMode = this.needsWindowsUAC();

          if (isMacTunMode || isWindowsTunMode) {
            // TUN 模式：等待 PID 文件被写入
            await this.waitForPidFile();

            if (this.singboxPid) {
              // 启动日志文件监控（macOS 和 Windows TUN 模式都需要，因为后台进程的 stdout 无法被捕获）
              this.startLogFileWatcher();
              // 启动健康检查定时器
              this.startHealthCheck();

              // 触发启动事件
              this.emit('started');
              this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {
                pid: this.singboxPid,
                startTime: this.startTime,
              });
              this.logToManager('info', 'sing-box 进程启动成功');
              resolve();
            } else {
              const error = '启动 sing-box 进程失败：无法获取进程 PID';
              this.logToManager('error', error);
              // 启动失败，清理状态，避免健康检查使用错误的 PID
              this.cleanup();
              reject(new Error(error));
            }
          } else {
            // 系统代理模式或 Linux
            if (this.singboxProcess && this.pid) {
              // 启动健康检查定时器
              this.startHealthCheck();

              // 触发启动事件
              this.emit('started');
              this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {
                pid: this.pid,
                startTime: this.startTime,
              });
              this.logToManager('info', 'sing-box 进程启动成功');
              resolve();
            } else {
              const error = '启动 sing-box 进程失败：进程未能正常启动';
              this.logToManager('error', error);
              // 启动失败，清理状态
              this.cleanup();
              reject(new Error(error));
            }
          }
        }, 1000);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logToManager('error', `启动 sing-box 进程时发生异常: ${errorMessage}`);
        // 异常时也要清理状态
        this.cleanup();
        reject(error);
      }
    });
  }

  /**
   * 解析进程启动错误
   */
  private parseLaunchError(error: Error): string {
    const errorCode = (error as NodeJS.ErrnoException).code;

    switch (errorCode) {
      case 'ENOENT':
        return '找不到 sing-box 可执行文件，请检查安装是否完整';
      case 'EACCES':
        return 'sing-box 可执行文件没有执行权限，请检查文件权限';
      case 'EPERM':
        return '权限不足，无法启动 sing-box 进程。TUN 模式需要管理员权限';
      default:
        return `启动 sing-box 进程失败: ${error.message}`;
    }
  }

  /**
   * 解析启动阶段的错误
   */
  private parseStartupError(exitCode: number, errorOutput: string): string {
    // 首先尝试从错误输出中提取有用信息
    if (errorOutput) {
      const lowerOutput = errorOutput.toLowerCase();

      if (lowerOutput.includes('permission denied') || lowerOutput.includes('access denied')) {
        return `TUN 模式需要管理员权限，请以管理员身份运行应用 [${errorOutput}]`;
      }

      if (lowerOutput.includes('address already in use') || lowerOutput.includes('bind')) {
        return `端口已被占用，请在设置中更换其他端口或关闭占用端口的程序 [${errorOutput}]`;
      }

      if (
        lowerOutput.includes('invalid config') ||
        lowerOutput.includes('parse') ||
        lowerOutput.includes('json')
      ) {
        return `sing-box 配置文件格式错误，请检查服务器配置 [${errorOutput}]`;
      }

      if (lowerOutput.includes('connection refused') || lowerOutput.includes('dial')) {
        return `无法连接到代理服务器，请检查服务器地址和端口 [${errorOutput}]`;
      }

      if (lowerOutput.includes('certificate') || lowerOutput.includes('tls')) {
        return `TLS 证书验证失败，请检查服务器 TLS 配置 [${errorOutput}]`;
      }

      // 如果有具体的错误信息，翻译后返回
      const friendlyMessage = this.translateErrorMessage(errorOutput);
      if (friendlyMessage !== errorOutput) {
        return `sing-box 启动失败: ${friendlyMessage}`;
      }
    }

    // 根据退出码返回通用错误信息
    switch (exitCode) {
      case 1:
        return 'sing-box 启动失败，请检查配置文件和服务器设置';
      case 2:
        return 'sing-box 配置文件格式错误，请检查服务器配置';
      case 126:
        return 'sing-box 可执行文件没有执行权限';
      case 127:
        return '找不到 sing-box 可执行文件';
      default:
        return `sing-box 启动失败，退出码: ${exitCode}`;
    }
  }

  /**
   * 停止 sing-box 进程
   */
  private async stopSingBoxProcess(): Promise<void> {
    // macOS TUN 模式：sing-box 以 root 权限在后台运行，需要用 osascript 终止
    if (this.singboxPid && process.platform === 'darwin') {
      return this.stopSingBoxWithSudo();
    }

    // Windows TUN 模式：sing-box 以管理员权限在后台运行，使用 taskkill 终止
    if (this.singboxPid && process.platform === 'win32') {
      return this.stopSingBoxOnWindows();
    }

    if (!this.singboxProcess) {
      return;
    }

    return new Promise((resolve) => {
      const proc = this.singboxProcess!;

      // 设置超时强制终止
      const killTimeout = setTimeout(() => {
        if (proc.killed === false) {
          console.warn('sing-box process did not exit gracefully, force killing');
          proc.kill('SIGKILL');
        }
      }, 5000);

      // 监听退出事件
      proc.once('exit', () => {
        clearTimeout(killTimeout);
        this.cleanup();
        resolve();
      });

      // 发送 SIGTERM 信号优雅终止
      proc.kill('SIGTERM');
    });
  }

  /**
   * 使用 sudo 停止 sing-box 进程（macOS TUN 模式）
   */
  private async stopSingBoxWithSudo(): Promise<void> {
    if (!this.singboxPid) {
      this.cleanup();
      return;
    }

    const pidToKill = this.singboxPid;
    this.logToManager('info', `正在停止 sing-box 进程 (PID: ${pidToKill})...`);

    return new Promise((resolve) => {
      // 先尝试 SIGTERM 优雅终止
      const killProcess = spawn('/usr/bin/osascript', [
        '-e',
        `do shell script "kill -TERM ${pidToKill}" with administrator privileges`,
      ]);

      killProcess.on('exit', async (code) => {
        if (code === 0) {
          // 等待进程退出
          await this.waitForProcessExit(pidToKill, 3000);

          // 检查进程是否真的退出了
          if (this.isProcessAlive(pidToKill)) {
            this.logToManager('warn', '进程未响应 SIGTERM，尝试强制终止...');
            await this.forceKillProcess(pidToKill);
          } else {
            this.logToManager('info', 'sing-box 进程已停止');
          }
        } else {
          this.logToManager('warn', `停止 sing-box 进程可能失败，退出码: ${code}`);
          // 尝试强制终止
          await this.forceKillProcess(pidToKill);
        }

        // 清理 PID 文件
        const fsSync = require('fs');
        try {
          fsSync.unlinkSync(this.getPidFilePath());
        } catch {
          // 忽略错误
        }

        this.cleanup();

        // 触发停止事件
        this.emit('stopped');
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});

        resolve();
      });

      killProcess.on('error', async (error) => {
        this.logToManager('error', `停止 sing-box 进程失败: ${error.message}`);
        // 尝试强制终止
        await this.forceKillProcess(pidToKill);
        this.cleanup();
        resolve();
      });
    });
  }

  /**
   * 停止 sing-box 进程（Windows TUN 模式）
   * sing-box 以管理员权限（UAC）启动，停止时也需要管理员权限
   * 使用 PowerShell Start-Process -Verb RunAs 来请求 UAC 权限执行 taskkill
   */
  private async stopSingBoxOnWindows(): Promise<void> {
    if (!this.singboxPid) {
      this.cleanup();
      return;
    }

    const pidToKill = this.singboxPid;
    this.logToManager('info', `正在停止 sing-box 进程 (PID: ${pidToKill})，需要管理员权限...`);

    return new Promise((resolve) => {
      // 直接使用 PowerShell 以管理员权限执行 taskkill
      // sing-box 以 UAC 启动，必须用 UAC 权限才能终止
      const psScript =
        "Start-Process -FilePath 'taskkill' -ArgumentList '/F','/PID','" +
        pidToKill.toString() +
        "' -Verb RunAs -Wait -WindowStyle Hidden";

      const killProcess = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        {
          windowsHide: true,
        }
      );

      killProcess.stderr?.on('data', (data) => {
        this.logToManager('warn', `taskkill stderr: ${data.toString()}`);
      });

      killProcess.on('exit', (code) => {
        if (code === 0) {
          this.logToManager('info', 'sing-box 进程已停止');
        } else {
          // 非零退出码可能是进程已退出或用户取消 UAC
          this.logToManager('warn', `停止进程结果: code=${code}`);
        }

        // 清理 PID 文件
        const fsSync = require('fs');
        try {
          fsSync.unlinkSync(this.getPidFilePath());
        } catch {
          // 忽略错误
        }

        this.cleanup();

        // 触发停止事件
        this.emit('stopped');
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});

        resolve();
      });

      killProcess.on('error', (error) => {
        this.logToManager('error', `停止 sing-box 进程失败: ${error.message}`);
        this.cleanup();
        resolve();
      });
    });
  }

  /**
   * 等待进程退出
   */
  private async waitForProcessExit(pid: number, timeout: number): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (!this.isProcessAlive(pid)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !this.isProcessAlive(pid);
  }

  /**
   * 强制终止进程
   */
  private async forceKillProcess(pid: number): Promise<void> {
    return new Promise((resolve) => {
      const killProcess = spawn('/usr/bin/osascript', [
        '-e',
        `do shell script "kill -9 ${pid}" with administrator privileges`,
      ]);

      killProcess.on('close', () => {
        resolve();
      });

      killProcess.on('error', () => {
        // 最后尝试普通 kill
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 忽略错误
        }
        resolve();
      });
    });
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    this.stopLogFileWatcher();
    this.stopHealthCheck();
    this.singboxProcess = null;
    this.pid = null;
    this.singboxPid = null;
    this.startTime = null;
  }

  /**
   * 清理可能残留的 sing-box 进程
   * 这是解决"重启代理后网络不恢复"问题的关键
   */
  private async killOrphanedSingBoxProcesses(): Promise<void> {
    if (process.platform === 'darwin') {
      await this.killOrphanedProcessesMac();
    } else if (process.platform === 'win32') {
      await this.killOrphanedProcessesWindows();
    }
  }

  /**
   * macOS: 清理残留的 sing-box 进程
   * 优化：排除当前正在管理的进程，避免误杀
   *
   * 注意：TUN 模式下 sing-box 以 root 权限运行，必须用 osascript 请求管理员权限才能终止
   */
  private async killOrphanedProcessesMac(): Promise<void> {
    return new Promise((resolve) => {
      // 使用 pgrep 查找所有 sing-box 进程
      const pgrep = spawn('/usr/bin/pgrep', ['-f', 'sing-box']);
      let pids = '';

      pgrep.stdout.on('data', (data: Buffer) => {
        pids += data.toString();
      });

      pgrep.on('close', async () => {
        let pidList = pids
          .trim()
          .split('\n')
          .filter((p) => p.trim())
          .map((p) => parseInt(p.trim(), 10))
          .filter((p) => !isNaN(p) && p > 0);

        // 排除当前正在管理的进程（避免误杀）
        const currentPid = this.singboxPid || this.pid;
        if (currentPid) {
          pidList = pidList.filter((p) => p !== currentPid);
        }

        if (pidList.length === 0) {
          resolve();
          return;
        }

        this.logToManager(
          'warn',
          `发现 ${pidList.length} 个残留的 sing-box 进程，正在清理: ${pidList.join(', ')}`
        );

        // TUN 模式下 sing-box 以 root 权限运行，必须用 osascript 请求管理员权限终止
        const killCmd = pidList.map((p) => `kill -9 ${p}`).join('; ');
        const killProcess = spawn('/usr/bin/osascript', [
          '-e',
          `do shell script "${killCmd}" with administrator privileges`,
        ]);

        killProcess.on('close', async (code) => {
          if (code === 0) {
            this.logToManager('info', '残留进程已清理');
          } else {
            this.logToManager('warn', `清理残留进程可能失败，退出码: ${code}`);
          }
          // 等待系统完全清理 TUN 接口和路由表
          await this.waitForNetworkCleanup();
          resolve();
        });

        killProcess.on('error', async (error) => {
          this.logToManager('warn', `清理残留进程失败: ${error.message}`);
          await this.waitForNetworkCleanup();
          resolve();
        });
      });

      pgrep.on('error', () => {
        resolve();
      });
    });
  }

  /**
   * 等待网络清理完成
   * sing-box 进程终止后，系统需要时间清理 TUN 接口和路由表
   */
  private async waitForNetworkCleanup(): Promise<void> {
    // 等待 2 秒让系统清理 TUN 接口
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 可选：刷新 DNS 缓存（macOS）
    if (process.platform === 'darwin') {
      try {
        const { exec } = require('child_process');
        exec('dscacheutil -flushcache; killall -HUP mDNSResponder', (error: Error | null) => {
          if (error) {
            this.logToManager('debug', `刷新 DNS 缓存失败: ${error.message}`);
          } else {
            this.logToManager('debug', 'DNS 缓存已刷新');
          }
        });
      } catch {
        // 忽略错误
      }
    }
  }

  /**
   * Windows: 清理残留的 sing-box 进程
   * 优化：排除当前正在管理的进程，避免误杀
   */
  private async killOrphanedProcessesWindows(): Promise<void> {
    return new Promise((resolve) => {
      const { execSync } = require('child_process');

      try {
        // 使用 wmic 获取所有 sing-box.exe 进程的 PID
        const result = execSync(
          'wmic process where "name=\'sing-box.exe\'" get ProcessId /format:list',
          {
            encoding: 'utf-8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
          }
        );

        // 解析 PID 列表
        const pidMatches = result.match(/ProcessId=(\d+)/g);
        if (!pidMatches || pidMatches.length === 0) {
          resolve();
          return;
        }

        let pidList = pidMatches
          .map((m: string) => parseInt(m.replace('ProcessId=', ''), 10))
          .filter((p: number) => !isNaN(p) && p > 0);

        // 排除当前正在管理的进程
        const currentPid = this.singboxPid || this.pid;
        if (currentPid) {
          pidList = pidList.filter((p: number) => p !== currentPid);
        }

        if (pidList.length === 0) {
          resolve();
          return;
        }

        this.logToManager(
          'warn',
          `发现 ${pidList.length} 个残留的 sing-box 进程，正在清理: ${pidList.join(', ')}`
        );

        // 逐个终止进程
        for (const pid of pidList) {
          try {
            execSync(`taskkill /F /PID ${pid}`, {
              windowsHide: true,
              stdio: 'ignore',
            });
          } catch {
            // 忽略单个进程终止失败
          }
        }

        this.logToManager('info', '残留进程已清理');

        // 等待一小段时间让系统清理
        setTimeout(resolve, 500);
      } catch {
        // wmic 命令失败，可能没有残留进程
        resolve();
      }
    });
  }

  /**
   * 检查进程是否存活
   *
   * 统一使用系统命令检测进程，避免 Node.js process.kill(pid, 0) 在检测
   * 特权进程时的不可靠性（macOS/Windows TUN 模式下 sing-box 以管理员权限运行）
   */
  private isProcessAlive(pid: number): boolean {
    try {
      const { execSync } = require('child_process');

      if (process.platform === 'win32') {
        // Windows: 使用 tasklist 检测进程
        // /FI "PID eq xxx" 过滤指定 PID，/NH 不显示表头
        const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
          encoding: 'utf-8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        // 如果进程存在，输出会包含进程信息；不存在则输出 "INFO: No tasks..."
        return !result.includes('No tasks') && result.includes(String(pid));
      } else {
        // macOS/Linux: 使用 ps 检测进程
        const result = execSync(`ps -p ${pid} -o pid=`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return result.trim() === String(pid);
      }
    } catch {
      // 命令执行失败，进程不存在
      return false;
    }
  }

  /**
   * 启动健康检查定时器
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      return;
    }

    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, ProxyManager.HEALTH_CHECK_INTERVAL);

    this.logToManager('debug', '已启动进程健康检查');
  }

  /**
   * 停止健康检查定时器
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * 执行健康检查
   */
  private performHealthCheck(): void {
    // 如果正在重启中，跳过检查
    if (this.isRestarting) {
      return;
    }

    // TUN 模式下只检查 singboxPid（sing-box 的实际 PID）
    // 系统代理模式下检查 pid（直接启动的进程 PID）
    // 注意：TUN 模式下 this.pid 是 osascript/PowerShell 的 PID，不是 sing-box 的
    const isTunMode = this.currentConfig?.proxyModeType === 'tun';
    const activePid = isTunMode ? this.singboxPid : this.singboxPid || this.pid;

    if (!activePid) {
      return;
    }

    if (!this.isProcessAlive(activePid)) {
      // 尝试获取更多退出信息
      const exitInfo = this.getProcessExitInfo();
      this.logToManager(
        'error',
        `检测到 sing-box 进程 (PID: ${activePid}) 已意外退出${exitInfo ? `，${exitInfo}` : ''}`
      );

      // 清理资源（但不停止健康检查，因为可能要重启）
      this.singboxProcess = null;
      this.pid = null;
      this.singboxPid = null;
      this.stopLogFileWatcher();

      // 尝试自动重启
      if (this.shouldAutoRestart()) {
        this.attemptAutoRestart();
      } else {
        // 无法自动重启，通知用户
        this.emit('error', {
          message: 'sing-box 进程意外退出，已达到最大重启次数，请手动重启',
          code: -1,
        });

        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
          message: 'sing-box 进程多次异常退出，请检查网络或服务器配置后手动重启',
          code: -1,
        });

        this.emit('stopped');
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});

        // 完全清理
        this.cleanup();
      }
    }
  }

  /**
   * 检查是否应该自动重启
   */
  private shouldAutoRestart(): boolean {
    if (!this.autoRestartEnabled || !this.currentConfig) {
      return false;
    }
    // 核心更新待验证窗口：禁止自动重启，使新核心首次异常退出立即上报 error → 触发回滚
    if (this.autoRestartSuppressed) {
      return false;
    }

    const now = Date.now();

    // 如果距离上次重启超过冷却时间，重置计数
    if (now - this.lastRestartTime > ProxyManager.RESTART_COOLDOWN) {
      this.restartCount = 0;
    }

    // 检查是否超过最大重启次数
    return this.restartCount < ProxyManager.MAX_RESTART_COUNT;
  }

  /** 核心更新待验证窗口内由 CoreUpdateService 置 true：抑制自动重启，首次失败即上报触发回滚。 */
  setAutoRestartSuppressed(suppressed: boolean): void {
    this.autoRestartSuppressed = suppressed;
  }

  /** 当前配置是否含 naive 节点（naive 依赖随 app 打包的 libcronet，核心更新可能引入 ABI 漂移）。 */
  hasNaiveNodes(): boolean {
    return (this.currentConfig?.servers || []).some(
      (s) => (s.protocol || '').toLowerCase() === 'naive'
    );
  }

  /**
   * 尝试自动重启
   */
  private async attemptAutoRestart(): Promise<void> {
    if (!this.currentConfig) {
      return;
    }

    this.isRestarting = true;
    this.restartCount++;
    this.lastRestartTime = Date.now();

    this.logToManager(
      'warn',
      `正在尝试自动重启 sing-box (第 ${this.restartCount}/${ProxyManager.MAX_RESTART_COUNT} 次)...`
    );

    // 通知前端正在重启
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
      message: `sing-box 进程异常退出，正在自动重启 (${this.restartCount}/${ProxyManager.MAX_RESTART_COUNT})...`,
      code: -2, // 特殊代码表示正在重启
    });

    try {
      // 等待一小段时间让系统清理
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 重新启动
      await this.start(this.currentConfig);

      this.logToManager('info', 'sing-box 自动重启成功');

      // 通知前端重启成功
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {
        pid: this.singboxPid || this.pid,
        startTime: this.startTime,
        autoRestarted: true,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logToManager('error', `自动重启失败: ${errorMessage}`);

      // 如果还有重试机会，会在下次健康检查时再次尝试
      if (this.restartCount >= ProxyManager.MAX_RESTART_COUNT) {
        this.emit('error', {
          message: `自动重启失败: ${errorMessage}`,
          code: -1,
        });

        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
          message: `自动重启失败，请手动重启: ${errorMessage}`,
          code: -1,
        });

        this.emit('stopped');
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
        this.cleanup();
      }
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * 设置是否启用自动重启
   */
  setAutoRestartEnabled(enabled: boolean): void {
    this.autoRestartEnabled = enabled;
    this.logToManager('info', `自动重启已${enabled ? '启用' : '禁用'}`);
  }

  /**
   * 重置重启计数（用于用户手动启动后）
   */
  private resetRestartCount(): void {
    this.restartCount = 0;
    this.lastRestartTime = 0;
  }

  /**
   * 获取进程退出信息（用于诊断）
   * 尝试从系统日志或 sing-box 日志文件中获取退出原因
   */
  private getProcessExitInfo(): string {
    const info: string[] = [];

    try {
      const fsSync = require('fs');
      const logFilePath = this.getLogFilePath();

      // 读取 sing-box 日志文件的最后几行
      if (fsSync.existsSync(logFilePath)) {
        const logContent = fsSync.readFileSync(logFilePath, 'utf-8');
        const lines = logContent.trim().split('\n');
        const lastLines = lines.slice(-10); // 最后 10 行

        // 查找错误或警告信息
        for (const line of lastLines) {
          const lowerLine = line.toLowerCase();
          if (
            lowerLine.includes('error') ||
            lowerLine.includes('fatal') ||
            lowerLine.includes('panic') ||
            lowerLine.includes('failed')
          ) {
            info.push(`日志: ${line.substring(0, 200)}`);
          }
        }
      }

      // macOS: 尝试从系统日志获取信息
      if (process.platform === 'darwin') {
        const { execSync } = require('child_process');
        try {
          // 查询最近的 sing-box 相关系统日志
          const sysLog = execSync(
            `log show --predicate 'process == "sing-box"' --last 1m --style compact 2>/dev/null | tail -5`,
            { encoding: 'utf-8', timeout: 3000 }
          ).trim();
          if (sysLog) {
            info.push(`系统日志: ${sysLog.substring(0, 300)}`);
          }
        } catch {
          // 忽略系统日志查询失败
        }
      }
    } catch {
      // 忽略诊断错误
    }

    return info.length > 0 ? info.join('; ') : '';
  }

  /**
   * 等待 PID 文件被写入（macOS/Windows TUN 模式）
   *
   * 重要：在调用此方法前，必须先删除旧的 PID 文件，否则可能读到旧的 PID
   */
  private async waitForPidFile(): Promise<void> {
    const pidFile = this.getPidFilePath();
    const maxWaitTime = 60000; // 最多等待 60 秒（给 macOS 权限提升过程留足时间）
    const checkInterval = 200; // 每 200ms 检查一次
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const pidContent = await fs.readFile(pidFile, 'utf-8');
        const pid = parseInt(pidContent.trim(), 10);
        if (!isNaN(pid) && pid > 0) {
          // 验证这个 PID 对应的进程确实存在且是 sing-box
          if (this.isProcessAlive(pid)) {
            this.singboxPid = pid;
            this.pid = pid;
            this.logToManager('info', `sing-box 后台进程 PID: ${pid}`);
            return;
          }
        }
      } catch {
        // 文件还不存在，继续等待
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    this.logToManager('warn', 'PID 文件等待超时');
  }

  /**
   * 删除 PID 文件
   * 在启动新进程前调用，确保不会读到旧的 PID
   */
  private async deletePidFile(): Promise<void> {
    try {
      await fs.unlink(this.getPidFilePath());
    } catch {
      // 文件不存在，忽略
    }
  }

  /**
   * 获取 PID 文件路径
   */
  private getPidFilePath(): string {
    return getSingBoxPidPath();
  }

  /**
   * 将规则文件复制到 User Data 目录
   * 解决 macOS TUN 模式下特权进程无法读取 Downloads/Documents 目录的问题
   */
  private async copyRuleSetsToUserData(): Promise<void> {
    const rulesDir = path.join(getUserDataPath(), 'rules');

    // 确保目录存在
    try {
      if (!require('fs').existsSync(rulesDir)) {
        require('fs').mkdirSync(rulesDir, { recursive: true });
      }
    } catch (error) {
      this.logToManager('error', `创建规则目录失败: ${error}`);
      return;
    }

    const filesToCopy = [
      { src: resourceManager.getGeoSiteCNPath(), dest: 'geosite-cn.srs' },
      { src: resourceManager.getGeoSiteNonCNPath(), dest: 'geosite-geolocation-!cn.srs' },
      { src: resourceManager.getGeoIPPath(), dest: 'geoip-cn.srs' },
    ];

    const fs = require('fs/promises');

    for (const file of filesToCopy) {
      try {
        const destPath = path.join(rulesDir, file.dest);

        // 检查源文件是否存在
        if (!require('fs').existsSync(file.src)) {
          this.logToManager('warn', `源规则文件不存在: ${file.src}`);
          continue;
        }

        // 复制文件（覆盖）
        await fs.copyFile(file.src, destPath);
        // this.logToManager('debug', `已复制规则文件: ${file.dest}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logToManager('error', `复制规则文件失败 ${file.dest}: ${errorMessage}`);
      }
    }
  }

  /**
   * 启动日志文件监控（用于 macOS TUN 模式）
   */
  private startLogFileWatcher(): void {
    if (this.logFileWatcher) {
      return;
    }

    const logFilePath = this.getLogFilePath();
    this.lastLogFileSize = 0;

    // 清空旧的日志文件
    const fsSync = require('fs');
    try {
      fsSync.writeFileSync(logFilePath, '');
    } catch {
      // 忽略错误
    }

    // 每 500ms 检查一次日志文件
    this.logFileWatcher = setInterval(async () => {
      try {
        const stats = await fs.stat(logFilePath);

        // 防止长会话日志无限增长撑满磁盘：超过上限即截断（sing-box O_APPEND 写，截断后从 0 续写）
        if (stats.size > ProxyManager.MAX_LOG_FILE_SIZE) {
          await fs.truncate(logFilePath, 0);
          this.lastLogFileSize = 0;
          return;
        }

        // 如果文件大小变小了，说明文件被清空或截断了
        if (stats.size < this.lastLogFileSize) {
          this.lastLogFileSize = 0;
        }

        if (stats.size > this.lastLogFileSize) {
          // 读取新增的内容
          const fd = await fs.open(logFilePath, 'r');
          const buffer = Buffer.alloc(stats.size - this.lastLogFileSize);
          await fd.read(buffer, 0, buffer.length, this.lastLogFileSize);
          await fd.close();

          const newContent = buffer.toString('utf-8');
          this.lastLogFileSize = stats.size;

          // 处理日志内容
          if (newContent.trim()) {
            this.handleProcessOutput(newContent);
          }
        }
      } catch {
        // 文件可能还不存在，忽略错误
      }
    }, 500);
  }

  /**
   * 停止日志文件监控
   */
  private stopLogFileWatcher(): void {
    if (this.logFileWatcher) {
      clearInterval(this.logFileWatcher);
      this.logFileWatcher = null;
    }
    this.lastLogFileSize = 0;
  }

  /**
   * 处理进程输出
   */
  private handleProcessOutput(data: string): void {
    // 移除 ANSI 颜色代码
    const cleanData = this.removeAnsiCodes(data);

    // 按行分割
    const lines = cleanData.split('\n').filter((line) => line.trim());

    for (const line of lines) {
      this.parseAndLogLine(line);
    }
  }

  /**
   * 移除 ANSI 颜色代码
   */
  private removeAnsiCodes(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  }

  /**
   * 解析并记录日志行
   */
  private parseAndLogLine(line: string): void {
    // 过滤重复日志
    if (this.isDuplicateLog(line)) {
      return;
    }

    // 过滤低价值日志（连接建立、DNS 查询等频繁日志）
    if (this.isLowValueLog(line)) {
      return;
    }

    // 解析 sing-box 日志格式
    const logInfo = this.parseSingBoxLog(line);

    if (logInfo) {
      // 先翻译消息中的代理标签
      const resolvedMessage = this.resolveTagsToNames(logInfo.message);

      // 再转换为友好的中文提示
      const friendlyMessage = this.translateErrorMessage(resolvedMessage);

      // 空消息不记录（如私有 IP 超时）
      if (friendlyMessage) {
        this.logToManager(logInfo.level, friendlyMessage);
      }
    } else {
      // 无法解析的日志，尝试对原始行也进行标签转换
      const resolvedLine = this.resolveTagsToNames(line);
      this.logToManager('info', resolvedLine);
    }
  }

  /**
   * 检查是否为低价值日志（应该被过滤）
   * 保留：路由决策、错误、启动/停止等重要日志
   * 过滤：频繁的连接关闭、握手细节等日志
   */
  private isLowValueLog(line: string): boolean {
    const lowerLine = line.toLowerCase();

    // 优先过滤的噪音日志（即使包含其他关键词也要过滤）
    const noisePatterns = [
      'connection upload closed',
      'connection download closed',
      'forcibly closed',
      'connection closed',
      'connection established',
      'tls handshake',
      'handshake completed',
    ];

    for (const pattern of noisePatterns) {
      if (lowerLine.includes(pattern)) {
        return true; // 过滤掉
      }
    }

    // 高价值日志模式 - 这些日志应该保留
    const keepPatterns = [
      'started', // 启动完成
      'stopped', // 停止
      'sing-box started', // sing-box 启动
      'error', // 错误
      'fatal', // 致命错误
      'warn', // 警告
      'failed', // 失败
      'updated default interface', // 网络接口变化
      // 路由决策相关 - 关键日志
      'match rule', // 匹配规则
      'final rule', // 最终规则
      'rule-set', // 规则集匹配
      'outbound/proxy', // 代理出站 - 用户关心的
    ];

    // 检查是否包含高价值模式
    for (const pattern of keepPatterns) {
      if (lowerLine.includes(pattern)) {
        return false; // 不过滤，保留这条日志
      }
    }

    // 检查是否为内网IP的直连连接（这些太频繁，需要过滤）
    if (lowerLine.includes('outbound/direct')) {
      // 检查是否连接到私有IP地址
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(line)) {
          return true; // 过滤内网直连
        }
      }
      // 公网直连保留（如 CDN、国内网站等）
      return false;
    }

    // 过滤的低价值日志模式
    const filterPatterns = [
      'dns query', // DNS 查询
      'dns response', // DNS 响应
      'dns: exchanged', // DNS 交换
      'dns: cached', // DNS 缓存
      'resolved', // DNS 解析完成
      'udp packet', // UDP 包
      'inbound/tun[tun-in]', // TUN 入站细节
      'inbound/http[http-in]', // HTTP 入站细节
      'inbound/socks[socks-in]', // SOCKS 入站细节
    ];

    for (const pattern of filterPatterns) {
      if (lowerLine.includes(pattern)) {
        return true; // 过滤掉
      }
    }

    return false; // 默认保留
  }

  /** 最近处理过的日志消息，用于去重，最多缓存 10 条 */
  private recentLogHistory: string[] = [];

  /**
   * 检查是否为重复日志
   */
  private isDuplicateLog(message: string): boolean {
    const now = Date.now();
    const trimmedMessage = message.trim();

    // 过滤掉日志中的时间戳部分进行对比（例如：+0800 2026-04-05 12:05:01 ）
    // 这样即便 stdout 和 logFile 的时间戳有微秒级差异，也能正确去重
    const stripTimestamp = (msg: string) =>
      msg.replace(/\+\d{4}\s\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\s/, '');
    const cleanMessage = stripTimestamp(trimmedMessage);

    // 1. 如果新消息与缓冲区中的任意消息内容（忽略时间戳）相同，则认为是重复
    const normalizedHistory = this.recentLogHistory.map((m) => stripTimestamp(m));
    if (normalizedHistory.includes(cleanMessage) && now - this.lastLogTime < 1000) {
      return true;
    }

    // 2. 特殊情况：如果消息完全相同且在 1 秒内（由于并发到达）
    if (trimmedMessage === this.lastLogMessage && now - this.lastLogTime < 1000) {
      this.lastLogCount++;
      if (this.lastLogCount > 1) return true;
    }

    // 新消息，入队并重置
    this.recentLogHistory.push(trimmedMessage);
    if (this.recentLogHistory.length > 10) {
      this.recentLogHistory.shift();
    }

    this.lastLogMessage = trimmedMessage;
    this.lastLogCount = 1;
    this.lastLogTime = now;

    return false;
  }

  /**
   * 解析 sing-box 日志
   */
  private parseSingBoxLog(
    line: string
  ): { level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'; message: string } | null {
    // sing-box 日志格式示例：
    // 2024-01-01 12:00:00 INFO message
    // 2024-01-01 12:00:00 [INFO] message

    // 尝试匹配日志级别
    const levelMatch = line.match(/\b(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/i);
    if (!levelMatch) {
      return null;
    }

    let level = levelMatch[1].toUpperCase();
    if (level === 'WARNING') {
      level = 'WARN';
    }

    // 提取消息内容（去掉时间戳和级别）
    const message = line
      .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/, '')
      .replace(/\[?(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]?/i, '')
      .trim();

    return {
      level: level.toLowerCase() as 'debug' | 'info' | 'warn' | 'error' | 'fatal',
      message,
    };
  }

  /**
   * 将日志中的 proxy 标签（UUID 或 "proxy"）转换为人类可读的服务器名称
   */
  private resolveTagsToNames(message: string): string {
    if (!this.currentConfig || !this.currentConfig.servers) {
      return message;
    }

    let resolvedMessage = message;

    // 1. 处理这种格式：proxy-2cef4913-84f6-41f9-a251-d1f49767cef6
    const uuidPattern = /proxy-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
    resolvedMessage = resolvedMessage.replace(uuidPattern, (match, id) => {
      const server = this.currentConfig?.servers.find((s) => s.id === id);
      return server ? server.name : match;
    });

    // 2. 处理单独的 [proxy] 或 outbound/proxy 标识
    const selectedServer = this.currentConfig.servers.find(
      (s) => s.id === this.currentConfig?.selectedServerId
    );

    if (selectedServer) {
      // 替换方括号中的 [proxy]
      resolvedMessage = resolvedMessage.replace(/\[proxy\]/g, `[${selectedServer.name}]`);

      // 替换 outbound/proxy
      resolvedMessage = resolvedMessage.replace(
        /outbound\/proxy/g,
        `outbound/${selectedServer.name}`
      );

      // 替换 outbound: proxy
      resolvedMessage = resolvedMessage.replace(
        /outbound: proxy/g,
        `outbound: ${selectedServer.name}`
      );
    }

    return resolvedMessage;
  }

  /**
   * 翻译错误消息为友好的中文提示
   * 返回格式：友好提示 + 原始错误（如果有翻译）
   */
  private translateErrorMessage(message: string): string {
    console.error(message);
    const lowerMessage = message.toLowerCase();

    // 常见错误模式匹配
    if (lowerMessage.includes('report handshake success: connection refused')) {
      return `目标连接被拒绝：代理节点已连接，但目标服务器拒绝了连接（可能是节点限制或失效） [${message}]`;
    }

    if (
      lowerMessage.includes('connection refused') ||
      lowerMessage.includes('connect: connection refused')
    ) {
      return `连接被拒绝：无法连接到代理服务器，请检查服务器地址和端口是否正确 [${message}]`;
    }

    if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
      // 尝试提取目标地址
      const match = message.match(/connection.*?to\s+([^\s:]+(?::\d+)?)/i);
      const target = match ? match[1] : '';
      // 私有 IP 超时不显示（内网服务走代理必然超时）
      if (target && /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(target)) {
        return ''; // 返回空字符串，后续会被过滤
      }
      return target ? `连接超时: ${target}` : '连接超时：服务器响应超时';
    }

    if (lowerMessage.includes('dns') && lowerMessage.includes('fail')) {
      return `DNS 解析失败：无法解析服务器域名，请检查 DNS 设置 [${message}]`;
    }

    if (
      (lowerMessage.includes('certificate') ||
        lowerMessage.includes('tls') ||
        lowerMessage.includes('ssl')) &&
      !lowerMessage.includes('anytls') &&
      !lowerMessage.includes('shadowtls')
    ) {
      // 保留原始错误信息，帮助用户诊断具体的证书问题
      return `TLS 证书错误：服务器证书验证失败 [${message}]`;
    }

    if (lowerMessage.includes('authentication failed') || lowerMessage.includes('auth fail')) {
      return `认证失败：用户名或密码错误，请检查服务器配置 [${message}]`;
    }

    if (lowerMessage.includes('permission denied') || lowerMessage.includes('access denied')) {
      return `权限不足：需要管理员权限才能启动 TUN 模式 [${message}]`;
    }

    if (
      lowerMessage.includes('address already in use') ||
      lowerMessage.includes('bind: address already in use')
    ) {
      return `端口已被占用：请更换其他端口或关闭占用端口的程序 [${message}]`;
    }

    if (lowerMessage.includes('invalid config') || lowerMessage.includes('config error')) {
      return `配置错误：sing-box 配置文件格式不正确 [${message}]`;
    }

    // 如果没有匹配到特定错误，返回原始消息
    return message;
  }

  /**
   * 记录日志到 LogManager
   */
  private logToManager(
    level: 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string
  ): void {
    if (this.logManager) {
      this.logManager.addLog(level, message, 'sing-box');
    }
  }

  /**
   * 处理进程错误
   */
  private handleProcessError(error: Error): void {
    const errorMessage = this.translateErrorMessage(error.message);

    // 触发错误事件
    this.emit('error', {
      message: errorMessage,
      error: error.message,
    });

    // 发送到前端
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
      message: errorMessage,
      error: error.message,
    });
  }

  /**
   * 处理进程退出
   */
  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    // 解析退出原因
    const exitReason = this.parseExitReason(code, signal);

    this.logToManager('info', `sing-box process exited: ${exitReason}`);

    // 如果是异常退出（非正常停止）
    if (code !== null && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      const errorMessage = this.parseExitError(code);

      this.logToManager('error', `sing-box异常退出: ${errorMessage}`);

      // 触发错误事件
      this.emit('error', {
        message: errorMessage,
        code,
        signal,
      });

      // 发送到前端
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
        message: errorMessage,
        code,
        signal,
      });
    } else {
      // 正常退出，触发停止事件
      this.emit('stopped');
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
    }

    this.cleanup();
  }

  /**
   * 解析退出原因
   */
  private parseExitReason(code: number | null, signal: NodeJS.Signals | null): string {
    if (signal) {
      return `信号 ${signal}`;
    }
    if (code !== null) {
      return `退出码 ${code}`;
    }
    return '未知原因';
  }

  /**
   * 解析退出错误
   */
  private parseExitError(code: number): string {
    // 尝试从最后的错误输出中提取错误信息
    if (this.lastErrorOutput) {
      const friendlyMessage = this.translateErrorMessage(this.lastErrorOutput);
      if (friendlyMessage !== this.lastErrorOutput) {
        return friendlyMessage;
      }
    }

    // 根据退出码返回通用错误信息
    switch (code) {
      case 1:
        return 'sing-box 启动失败，请检查配置文件';
      case 2:
        return 'sing-box 配置文件格式错误';
      case 126:
        return 'sing-box 可执行文件没有执行权限';
      case 127:
        return '找不到 sing-box 可执行文件';
      case 137:
        return 'sing-box 进程被强制终止';
      case 143:
        return 'sing-box 进程被正常终止';
      default:
        return `sing-box 异常退出，退出码: ${code}`;
    }
  }

  /**
   * 发送事件到渲染进程
   */
  private sendEventToRenderer(channel: string, data: any): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * 获取 sing-box 可执行文件路径
   */
  private getSingBoxPath(): string {
    return resourceManager.getSingBoxPath();
  }

  /**
   * 设置系统代理
   */
  private async setSystemProxy(config: UserConfig): Promise<void> {
    const port = config.httpPort || 2080;
    const host = '127.0.0.1';

    this.logToManager('info', `正在设置系统代理 (${host}:${port})...`);

    if (process.platform === 'win32') {
      try {
        const { exec } = require('child_process');
        const runCommand = (cmd: string) =>
          new Promise((resolve, reject) => {
            exec(cmd, (error: any) => {
              if (error) reject(error);
              else resolve(null);
            });
          });

        // 启用代理
        await runCommand(
          `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`
        );
        // 设置代理服务器
        await runCommand(
          `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "${host}:${port}" /f`
        );
        // 设置代理忽略列表（例外），对每个域名同时生成三种格式以最大化兼容性：
        //   *.domain.com → WinINet 标准格式（传统 C++ 应用如同花顺/网银客户端）
        //   *domain.com  → Chrome/Chromium 内核专用格式（无点前缀，解决 Chrome 不认带点通配符的问题）
        //   domain.com   → 精确根域名匹配（兜底，确保根域名本身也被旁路）
        const domainBypassEntries = DOMESTIC_BANK_AND_STOCK_DOMAINS.flatMap((d) => {
          const base = d.startsWith('.') ? d.slice(1) : d;
          return [`*.${base}`, `*${base}`, base];
        }).join(';');
        const bypassDomains =
          '<local>;localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;' +
          domainBypassEntries;
        await runCommand(
          `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "${bypassDomains}" /f`
        );

        // 核心修复：修改注册表后必须通过 WinINet API 向操作系统发送刷新广播，否则各大浏览器和后台服务（包括网银插件）会一直使用旧的代理缓存，遇到重启必失效。
        const refreshCmd = `powershell -NoProfile -Command "$sig = '[DllImport(\\"wininet.dll\\")] public static extern bool InternetSetOption(int hInternet, int dwOption, int lpBuffer, int dwBufferLength);'; $type = Add-Type -MemberDefinition $sig -Name 'WinInet' -Namespace 'Proxy' -PassThru; $type::InternetSetOption(0, 39, 0, 0); $type::InternetSetOption(0, 37, 0, 0);"`;
        try {
          await runCommand(refreshCmd);
        } catch (e) {
          this.logToManager('warn', `WinINet 代理缓存刷新失败 (可能被阻止): ${e}`);
        }

        this.logToManager('info', 'Windows 系统代理已设置 (附带例外清单并刷新缓存)');
      } catch (error) {
        this.logToManager('error', `设置 Windows 系统代理失败: ${error}`);
      }
    } else if (process.platform === 'darwin') {
      try {
        const { execSync } = require('child_process');
        const socksPort = config.socksPort || 2081;

        // 动态获取所有网络服务名称，避免硬编码导致部分网卡失效
        const servicesOutput = execSync('networksetup -listallnetworkservices').toString();
        const services = servicesOutput
          .split('\n')
          .filter(
            (s: string) =>
              s &&
              !s.includes('*') &&
              s !== 'An asterisk (*) denotes that a network service is disabled.'
          );

        for (const service of services) {
          try {
            const s = service.trim();
            execSync(`networksetup -setwebproxy "${s}" ${host} ${port}`);
            execSync(`networksetup -setsecurewebproxy "${s}" ${host} ${port}`);
            execSync(`networksetup -setsocksfirewallproxy "${s}" ${host} ${socksPort}`);
          } catch {
            // ignore
          }
        }
        this.logToManager('info', 'macOS 系统代理已设置');
      } catch (error) {
        this.logToManager('error', `设置 macOS 系统代理失败: ${error}`);
      }
    }
  }

  /**
   * 取消系统代理
   */
  private async unsetSystemProxy(): Promise<void> {
    this.logToManager('info', '正在取消系统代理...');

    if (process.platform === 'win32') {
      try {
        const { exec } = require('child_process');
        const runCommand = (cmd: string) =>
          new Promise((resolve, reject) => {
            exec(cmd, (error: any) => {
              if (error) reject(error);
              else resolve(null);
            });
          });

        // 禁用代理
        await runCommand(
          `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`
        );

        // 核心修复：修改注册表后必须通过 WinINet API 向操作系统发送刷新广播
        const refreshCmd = `powershell -NoProfile -Command "$sig = '[DllImport(\\"wininet.dll\\")] public static extern bool InternetSetOption(int hInternet, int dwOption, int lpBuffer, int dwBufferLength);'; $type = Add-Type -MemberDefinition $sig -Name 'WinInet' -Namespace 'Proxy' -PassThru; $type::InternetSetOption(0, 39, 0, 0); $type::InternetSetOption(0, 37, 0, 0);"`;
        try {
          await runCommand(refreshCmd);
        } catch {
          // ignore
        }

        this.logToManager('info', 'Windows 系统代理已取消 (并刷新系统缓存)');
      } catch (error) {
        this.logToManager('error', `取消 Windows 系统代理失败: ${error}`);
      }
    } else if (process.platform === 'darwin') {
      try {
        const { execSync } = require('child_process');
        // 动态获取所有服务并关闭代理
        const servicesOutput = execSync('networksetup -listallnetworkservices').toString();
        const services = servicesOutput
          .split('\n')
          .filter(
            (s: string) =>
              s &&
              !s.includes('*') &&
              s !== 'An asterisk (*) denotes that a network service is disabled.'
          );

        for (const service of services) {
          try {
            const s = service.trim();
            execSync(`networksetup -setwebproxystate "${s}" off`);
            execSync(`networksetup -setsecurewebproxystate "${s}" off`);
            execSync(`networksetup -setsocksfirewallproxystate "${s}" off`);
          } catch {
            // ignore
          }
        }
        this.logToManager('info', 'macOS 系统代理已取消');
      } catch (error) {
        this.logToManager('error', `取消 macOS 系统代理失败: ${error}`);
      }
    }
  }
}
