/**
 * API 客户端
 * 封装所有 IPC 调用方法，提供类型安全的 API 接口
 */

import { ipcClient } from './ipc-client';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  UserConfig,
  ServerConfig,
  ProxyStatus,
  LogEntry,
  TrafficStats,
  DomainRule,
  AutoStartStatus,
  ConnectionStateInfo,
  SubscriptionConfig,
} from '../../shared/types';

/**
 * 代理控制 API
 */
export const proxyApi = {
  /**
   * 启动代理
   * @param config 用户配置
   */
  async start(config: UserConfig): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.PROXY_START, config);
  },

  /**
   * 停止代理
   */
  async stop(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.PROXY_STOP);
  },

  /**
   * 重启代理
   */
  async restart(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.PROXY_RESTART);
  },

  /**
   * 获取代理状态
   */
  async getStatus(): Promise<ProxyStatus> {
    return ipcClient.invoke(IPC_CHANNELS.PROXY_GET_STATUS);
  },

  /**
   * 监听代理启动事件
   */
  onStarted(
    listener: (data: {
      pid: number | null;
      startTime?: string | Date | null;
      autoRestarted?: boolean;
    }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_PROXY_STARTED, listener);
  },

  /**
   * 监听代理停止事件
   */
  onStopped(listener: (data: Record<string, never>) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_PROXY_STOPPED, listener);
  },

  /**
   * 监听代理错误事件。主进程各 emit 点 payload 形状不一，message 优先 / error 兜底。
   */
  onError(
    listener: (data: {
      message?: string;
      error?: string;
      code?: number;
      signal?: string | null;
    }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_PROXY_ERROR, listener);
  },

  /**
   * 监听自动换节点成功事件
   */
  onAutoNodeSwitched(
    listener: (data: { reason: string; newServerName: string; latency: number }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_AUTO_NODE_SWITCHED, listener);
  },
};

/**
 * 配置管理 API
 */
export const configApi = {
  /**
   * 获取完整配置
   */
  async get(): Promise<UserConfig> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_GET);
  },

  /**
   * 保存完整配置
   */
  async save(config: UserConfig): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_SAVE, config);
  },

  /**
   * 更新代理模式
   */
  async updateMode(mode: UserConfig['proxyMode']): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_UPDATE_MODE, { mode });
  },

  /**
   * 获取配置值
   */
  async getValue<T = any>(key: string): Promise<T> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_GET_VALUE, { key });
  },

  /**
   * 设置配置值
   */
  async setValue(key: string, value: any): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_SET_VALUE, { key, value });
  },

  /**
   * 监听配置变化事件
   */
  onChanged(
    listener: (data: { key?: string; oldValue?: any; newValue?: any }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_CONFIG_CHANGED, listener);
  },

  /**
   * 获取隐私模式状态
   */
  async getPrivacyMode(): Promise<boolean> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_GET_PRIVACY_MODE);
  },

  /**
   * 设置隐私模式状态
   */
  async setPrivacyMode(value: boolean): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_SET_PRIVACY_MODE, value);
  },

  /**
   * 设置应用语言 (同步给主进程)
   */
  async setLanguage(lang: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.APP_SET_LANGUAGE, lang);
  },
};

/**
 * 服务器管理 API
 */
export const serverApi = {
  /**
   * 获取所有服务器
   */
  async getAll(): Promise<ServerConfig[]> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_GET_ALL);
  },

  /**
   * 添加服务器
   */
  async add(server: Omit<ServerConfig, 'id'>): Promise<ServerConfig> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_ADD, server);
  },

  /**
   * 更新服务器
   */
  async update(server: ServerConfig): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_UPDATE, server);
  },

  /**
   * 删除服务器
   */
  async delete(serverId: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_DELETE, { serverId });
  },

  /**
   * 切换服务器
   */
  async switch(serverId: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_SWITCH, { serverId });
  },

  /**
   * 解析协议 URL
   */
  async parseUrl(url: string): Promise<Omit<ServerConfig, 'id'>> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_PARSE_URL, { url });
  },

  /**
   * 从 URL 添加服务器
   */
  async addFromUrl(url: string, name?: string): Promise<ServerConfig> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_ADD_FROM_URL, { url, name });
  },

  /**
   * 生成分享 URL
   */
  async generateUrl(server: ServerConfig): Promise<string> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_GENERATE_URL, { server });
  },

  /**
   * 测试指定服务器延迟，不传则测试所有服务器
   */
  async speedTest(serverIds?: string[]): Promise<Record<string, number>> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_SPEED_TEST, { serverIds });
  },
};

/**
 * 路由规则管理 API
 */
export const rulesApi = {
  /**
   * 获取所有规则
   */
  async getAll(): Promise<DomainRule[]> {
    return ipcClient.invoke(IPC_CHANNELS.RULES_GET_ALL);
  },

  /**
   * 添加规则
   */
  async add(rule: Omit<DomainRule, 'id'>): Promise<DomainRule> {
    return ipcClient.invoke(IPC_CHANNELS.RULES_ADD, rule);
  },

  /**
   * 更新规则
   */
  async update(rule: DomainRule): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.RULES_UPDATE, rule);
  },

  /**
   * 删除规则
   */
  async delete(ruleId: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.RULES_DELETE, { ruleId });
  },
};

/**
 * 日志管理 API
 */
export const logsApi = {
  /**
   * 获取日志
   */
  async get(limit?: number): Promise<LogEntry[]> {
    return ipcClient.invoke(IPC_CHANNELS.LOGS_GET, { limit });
  },

  /**
   * 清空日志
   */
  async clear(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.LOGS_CLEAR);
  },

  /**
   * 设置日志级别
   */
  async setLevel(level: LogEntry['level']): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.LOGS_SET_LEVEL, { level });
  },

  /**
   * 监听日志接收事件
   */
  onReceived(listener: (log: LogEntry) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_LOG_RECEIVED, listener);
  },
};

/**
 * 自启动管理 API
 */
export const autoStartApi = {
  /**
   * 设置自启动
   */
  async set(enabled: boolean): Promise<boolean> {
    return ipcClient.invoke(IPC_CHANNELS.AUTO_START_SET, { enabled });
  },

  /**
   * 获取自启动状态
   */
  async getStatus(): Promise<AutoStartStatus> {
    return ipcClient.invoke(IPC_CHANNELS.AUTO_START_GET_STATUS);
  },
};

/**
 * 统计信息 API
 */
export const statsApi = {
  /**
   * 获取流量统计
   */
  async get(): Promise<TrafficStats> {
    return ipcClient.invoke(IPC_CHANNELS.STATS_GET);
  },

  /**
   * 重置流量统计
   */
  async reset(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.STATS_RESET);
  },

  /**
   * 监听统计更新事件
   */
  onUpdated(listener: (stats: TrafficStats) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_STATS_UPDATED, listener);
  },
};

/**
 * 连接状态 API
 */
export const connectionApi = {
  /**
   * 监听连接状态变化事件
   */
  onStateChanged(listener: (state: ConnectionStateInfo) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_CONNECTION_STATE_CHANGED, listener);
  },
};

/**
 * 版本信息类型
 */
export interface VersionInfo {
  appVersion: string;
  appName: string;
  buildDate: string;
  singBoxVersion: string;
  copyright: string;
  repositoryUrl: string;
}

/**
 * 版本信息 API
 */
export const versionApi = {
  /**
   * 获取版本信息
   */
  async getInfo(): Promise<VersionInfo> {
    return ipcClient.invoke(IPC_CHANNELS.VERSION_GET_INFO);
  },
};

/**
 * 管理员权限检查结果
 */
export interface AdminCheckResult {
  isAdmin: boolean;
  platform: NodeJS.Platform;
  needsElevationForTun: boolean;
}

/**
 * 管理员权限 API
 */
export const adminApi = {
  /**
   * 检查管理员权限状态
   */
  async check(): Promise<AdminCheckResult> {
    return ipcClient.invoke(IPC_CHANNELS.ADMIN_CHECK);
  },
};

/**
 * 更新检查结果
 */
export interface UpdateCheckResult {
  hasUpdate: boolean;
  updateInfo?: UpdateInfo;
  error?: string;
}

/**
 * 更新信息
 */
export interface UpdateInfo {
  version: string;
  title: string;
  releaseNotes: string;
  downloadUrl: string;
  fileSize: number;
  publishedAt: string;
  isPrerelease: boolean;
  fileName: string;
}

/**
 * 更新进度
 */
export interface UpdateProgress {
  status:
    | 'idle'
    | 'checking'
    | 'no-update'
    | 'update-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  percentage: number;
  message: string;
  error?: string;
}

/**
 * 更新管理 API
 */
export const updateApi = {
  /**
   * 检查更新
   */
  async check(includePrerelease = false): Promise<UpdateCheckResult> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_CHECK, { includePrerelease });
  },

  /**
   * 下载更新
   */
  async download(
    updateInfo: UpdateInfo
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD, { updateInfo });
  },

  /**
   * 安装更新
   */
  async install(filePath: string): Promise<{ success: boolean; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_INSTALL, { filePath });
  },

  /**
   * 跳过版本
   */
  async skip(version: string): Promise<{ success: boolean }> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_SKIP, { version });
  },

  /**
   * 打开 Releases 页面
   */
  async openReleases(): Promise<{ success: boolean }> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_OPEN_RELEASES);
  },

  /**
   * 监听更新进度事件
   */
  onProgress(listener: (progress: UpdateProgress) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_UPDATE_PROGRESS, listener);
  },
};

/**
 * 核心更新 API
 */
export const coreUpdateApi = {
  /**
   * 检查核心更新
   */
  async check(): Promise<{
    hasUpdate: boolean;
    currentVersion: string;
    latestVersion?: string;
    downloadUrl?: string;
    releaseNotes?: string;
    error?: string;
  }> {
    return ipcClient.invoke('core-update:check');
  },

  /**
   * 更新核心
   */
  async update(downloadUrl: string): Promise<boolean> {
    return ipcClient.invoke('core-update:update', downloadUrl);
  },

  /**
   * 获取核心版本
   */
  async getVersion(): Promise<string> {
    return ipcClient.invoke('core-update:get-version');
  },

  /**
   * 获取核心版本信息（当前版本、备份版本、是否有备份）
   */
  async getVersionInfo(): Promise<{
    currentVersion: string;
    backupVersion: string | null;
    hasBackup: boolean;
    lastKnownVersion: string | null;
  }> {
    return ipcClient.invoke(IPC_CHANNELS.CORE_GET_VERSION_INFO);
  },

  /**
   * 回滚核心到上一个备份版本
   */
  async rollback(): Promise<boolean> {
    return ipcClient.invoke(IPC_CHANNELS.CORE_ROLLBACK);
  },

  /**
   * 监听核心版本变更事件
   */
  onVersionChanged(
    listener: (data: {
      previousVersion: string;
      currentVersion: string;
      hasBackup: boolean;
    }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_CORE_VERSION_CHANGED, listener);
  },

  /**
   * 手动替换核心（打开文件选择器，用户选择 sing-box 二进制）
   */
  async replaceManual(): Promise<boolean> {
    return ipcClient.invoke(IPC_CHANNELS.CORE_REPLACE_MANUAL);
  },
};

/**
 * 订阅管理 API
 */
export const subscriptionApi = {
  /**
   * 添加订阅
   */
  async add(
    subscription: Omit<SubscriptionConfig, 'id' | 'createdAt'>
  ): Promise<SubscriptionConfig> {
    return ipcClient.invoke(IPC_CHANNELS.SUBSCRIPTION_ADD, { subscription });
  },

  /**
   * 更新订阅配置
   */
  async update(subscription: SubscriptionConfig): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SUBSCRIPTION_UPDATE, { subscription });
  },

  /**
   * 根据 ID 删除订阅
   */
  async delete(subscriptionId: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SUBSCRIPTION_DELETE, { subscriptionId });
  },

  /**
   * 触发订阅节点更新
   */
  async updateServers(subscriptionId: string): Promise<{
    success: boolean;
    addedServers: number;
    updatedServers: number;
    deletedServers: number;
    error?: string;
  }> {
    return ipcClient.invoke(IPC_CHANNELS.SUBSCRIPTION_UPDATE_SERVERS, { subscriptionId });
  },
};

/**
 * 数据备份与恢复摘要信息
 */
export interface BackupInfo {
  serverCount: number;
  manualServerCount: number;
  subscriptionCount: number;
  ruleCount: number;
  ruleSetCount: number;
  appRuleCount: number;
}

/**
 * 数据备份与恢复 API
 */
export const backupApi = {
  /**
   * 导出备份（弹出系统文件保存对话框）
   */
  async export(): Promise<{ success: boolean; filePath?: string; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.BACKUP_EXPORT);
  },

  /**
   * 导入并恢复备份（弹出系统文件打开对话框）
   */
  async import(): Promise<{ success: boolean; info?: BackupInfo; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.BACKUP_IMPORT);
  },

  /**
   * 获取当前配置摘要（节点数、订阅数、规则数等）
   */
  async getInfo(): Promise<BackupInfo> {
    return ipcClient.invoke(IPC_CHANNELS.BACKUP_GET_INFO);
  },
};

/**
 * 统一的 API 客户端
 */
export const api = {
  proxy: proxyApi,
  config: configApi,
  server: serverApi,
  rules: rulesApi,
  logs: logsApi,
  autoStart: autoStartApi,
  stats: statsApi,
  connection: connectionApi,
  version: versionApi,
  admin: adminApi,
  update: updateApi,
  coreUpdate: coreUpdateApi,
  subscription: subscriptionApi,
  backup: backupApi,
};

/**
 * 默认导出
 */
export default api;
