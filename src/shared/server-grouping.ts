import type { ServerConfig, SubscriptionConfig } from './types';

/**
 * 节点分组（自建 + 各订阅），供托盘菜单 / 节点选择器 / 任意需要「按订阅分组」展示处共用，
 * 保证分组口径单一一致。
 */
export interface ServerGroup {
  /** 'manual' 或订阅 id */
  id: string;
  /** 展示名：自建组为 'manual' 占位（调用方本地化），订阅组为订阅名 */
  name: string;
  isManual: boolean;
  servers: ServerConfig[];
}

/**
 * 把节点按归属分组：自建（无 subscriptionId，或 subscriptionId 指向已删订阅的孤儿）置首，
 * 其后每个订阅一组。空组省略，顺序与 subscriptions 入参一致。
 */
export function groupServersBySubscription(
  servers: ServerConfig[],
  subscriptions: SubscriptionConfig[] = []
): ServerGroup[] {
  const knownIds = new Set(subscriptions.map((s) => s.id));
  const groups: ServerGroup[] = [];

  // 自建 = 无归属 或 归属订阅已不存在（孤儿不丢，并入自建）
  const manual = servers.filter((s) => !s.subscriptionId || !knownIds.has(s.subscriptionId));
  if (manual.length > 0) {
    groups.push({ id: 'manual', name: 'manual', isManual: true, servers: manual });
  }

  for (const sub of subscriptions) {
    const subServers = servers.filter((s) => s.subscriptionId === sub.id);
    if (subServers.length > 0) {
      groups.push({ id: sub.id, name: sub.name, isManual: false, servers: subServers });
    }
  }

  return groups;
}
