/**
 * Bridge types for compatibility with old code
 * Re-exports types from shared types
 */

export type {
  UserConfig,
  ServerConfig,
  Rule,
  RuleType,
  RuleCondition,
  SystemProcessInfo,
  ProxyStatus,
  TrafficStats,
  LogEntry,
  ApiResponse,
  SubscriptionConfig,
  ProxyMode,
  ProxyModeType,
  IpInfo,
  IpInfoSnapshot,
  RuleResource,
  RuleResourceListItem,
  RuleResourceCatalogItem,
  RuleResourceCatalogResult,
  RuleResourceProgress,
  RuleResourceCategory,
  RuleResourceDownloadItem,
  RuleResourceDownloadResult,
  RuleResourceRef,
} from '../../shared/types';

export type ProtocolType =
  | 'vless'
  | 'trojan'
  | 'hysteria2'
  | 'shadowsocks'
  | 'anytls'
  | 'tuic'
  | 'vmess'
  | 'naive'
  | 'socks'
  | 'http'
  | 'ssh'
  | 'wireguard'
  | 'tailscale'
  | 'custom';
