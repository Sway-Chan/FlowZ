/**
 * server-page 的服务器数组变更纯逻辑 —— 从内联 handler 抽出（审计 §1/§6 Tier-2：CRUD 下沉）。
 * id/now 由调用方注入（crypto.randomUUID / new Date），使变更逻辑成纯函数可离线单测；
 * 锁住易错语义：编辑保留 subscriptionId/createdAt、克隆脱离订阅。orchestration（saveConfig/toast）见 use-server-actions。
 */
import type { ServerConfig } from '../bridge/types';

export type NewServerData = Omit<ServerConfig, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * 计算「保存服务器」后的 servers 数组：
 * - editingServer 存在 → 就地替换该 id 的项，**保留** subscriptionId（订阅节点编辑属临时改动）+ createdAt，更新 updatedAt；
 * - 否则 → 追加新节点（注入 newId + createdAt/updatedAt = now）。
 */
export function buildSavedServers(
  servers: ServerConfig[],
  serverData: NewServerData,
  editingServer: ServerConfig | undefined,
  newId: string,
  now: string
): ServerConfig[] {
  if (editingServer) {
    return servers.map((s) =>
      s.id === editingServer.id
        ? {
            ...serverData,
            id: editingServer.id,
            subscriptionId: editingServer.subscriptionId,
            createdAt: editingServer.createdAt,
            updatedAt: now,
          }
        : s
    );
  }
  const newServer: ServerConfig = {
    ...serverData,
    id: newId,
    createdAt: now,
    updatedAt: now,
  };
  return [...servers, newServer];
}

/**
 * 克隆为脱离订阅的自建副本：新 id、清 subscriptionId、改名、新时间戳。
 * （订阅节点的本地自定义需用此方式保留，否则下次订阅更新会覆盖。）
 */
export function buildClonedServer(
  server: ServerConfig,
  cloneName: string,
  newId: string,
  now: string
): ServerConfig {
  return {
    ...server,
    id: newId,
    subscriptionId: undefined,
    name: cloneName,
    createdAt: now,
    updatedAt: now,
  };
}
