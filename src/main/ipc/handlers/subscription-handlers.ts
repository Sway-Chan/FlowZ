import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { SubscriptionConfig } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { SubscriptionService, SubscriptionUpdateResult } from '../../services/SubscriptionService';
import { ConfigManager } from '../../services/ConfigManager';
import { randomUUID } from 'crypto';

/**
 * 注册订阅管理相关的 IPC 处理器
 */
export function registerSubscriptionHandlers(
  subscriptionService: SubscriptionService,
  configManager: ConfigManager
): void {
  // 添加订阅
  registerIpcHandler<
    { subscription: Omit<SubscriptionConfig, 'id' | 'createdAt'> },
    SubscriptionConfig
  >(
    IPC_CHANNELS.SUBSCRIPTION_ADD,
    async (
      _event: IpcMainInvokeEvent,
      args: { subscription: Omit<SubscriptionConfig, 'id' | 'createdAt'> }
    ) => {
      const config = await configManager.loadConfig();
      if (!config.subscriptions) {
        config.subscriptions = [];
      }

      const now = new Date().toISOString();
      const newSubscription: SubscriptionConfig = {
        ...args.subscription,
        id: randomUUID(),
        createdAt: now,
      };

      config.subscriptions.push(newSubscription);
      await configManager.saveConfig(config);

      return newSubscription;
    }
  );

  // 更新订阅配置
  registerIpcHandler<{ subscription: SubscriptionConfig }, void>(
    IPC_CHANNELS.SUBSCRIPTION_UPDATE,
    async (_event: IpcMainInvokeEvent, args: { subscription: SubscriptionConfig }) => {
      const config = await configManager.loadConfig();
      if (!config.subscriptions) return;

      const index = config.subscriptions.findIndex((s) => s.id === args.subscription.id);
      if (index === -1) {
        throw new Error(`订阅不存在: ${args.subscription.id}`);
      }

      config.subscriptions[index] = args.subscription;
      await configManager.saveConfig(config);
    }
  );

  // 删除订阅
  registerIpcHandler<{ subscriptionId: string }, void>(
    IPC_CHANNELS.SUBSCRIPTION_DELETE,
    async (_event: IpcMainInvokeEvent, args: { subscriptionId: string }) => {
      const config = await configManager.loadConfig();
      if (!config.subscriptions) return;

      const index = config.subscriptions.findIndex((s) => s.id === args.subscriptionId);
      if (index === -1) {
        throw new Error(`订阅不存在: ${args.subscriptionId}`);
      }

      // 删除订阅
      config.subscriptions.splice(index, 1);

      // 删除该订阅下的所有节点
      config.servers = config.servers.filter((s) => s.subscriptionId !== args.subscriptionId);

      // 如果当前选中的节点被删除了，清除选中状态
      if (config.selectedServerId) {
        const stillExists = config.servers.some((s) => s.id === config.selectedServerId);
        if (!stillExists) {
          config.selectedServerId = null;
        }
      }

      await configManager.saveConfig(config);
    }
  );

  // 更新订阅节点
  registerIpcHandler<{ subscriptionId: string }, SubscriptionUpdateResult>(
    IPC_CHANNELS.SUBSCRIPTION_UPDATE_SERVERS,
    async (_event: IpcMainInvokeEvent, args: { subscriptionId: string }) => {
      const config = await configManager.loadConfig();
      if (!config.subscriptions) throw new Error('没有订阅配置');

      const subscription = config.subscriptions.find((s) => s.id === args.subscriptionId);
      if (!subscription) {
        throw new Error(`订阅不存在: ${args.subscriptionId}`);
      }

      try {
        const result = await subscriptionService.fetchSubscription(
          subscription.url,
          subscription.id
        );
        const fetchedServers = result.servers;

        // 获取原来的该订阅下的节点，按稳定指纹对账（不依赖显示名）
        const oldServers = config.servers.filter((s) => s.subscriptionId === subscription.id);
        const {
          servers: newServersToKeep,
          added,
          updated,
          deleted,
          deletedIds,
        } = SubscriptionService.reconcileServers(
          oldServers,
          fetchedServers,
          new Date().toISOString()
        );

        if (config.selectedServerId && deletedIds.has(config.selectedServerId)) {
          config.selectedServerId = null;
        }

        const otherServers = config.servers.filter((s) => s.subscriptionId !== subscription.id);
        config.servers = [...otherServers, ...newServersToKeep];

        // 更新订阅的最后更新时间和流量信息
        subscription.lastUpdated = new Date().toISOString();
        if (result.userInfo) {
          subscription.userInfo = result.userInfo;
        }

        await configManager.saveConfig(config);

        return {
          success: true,
          addedServers: added,
          updatedServers: updated,
          deletedServers: deleted,
          userInfo: result.userInfo,
        };
      } catch (error: any) {
        return {
          success: false,
          addedServers: 0,
          updatedServers: 0,
          deletedServers: 0,
          error: error.message,
        };
      }
    }
  );

  // 启动时批量更新所有开启了 autoUpdate 的订阅
  registerIpcHandler<void, { updated: number; failed: number }>(
    IPC_CHANNELS.SUBSCRIPTION_UPDATE_ALL,
    async (_event: IpcMainInvokeEvent) => {
      const config = await configManager.loadConfig();
      if (!config.subscriptions || config.subscriptions.length === 0) {
        return { updated: 0, failed: 0 };
      }

      let updatedCount = 0;
      let failedCount = 0;

      for (const subscription of config.subscriptions) {
        if (!subscription.autoUpdate) continue;
        try {
          const result = await subscriptionService.fetchSubscription(
            subscription.url,
            subscription.id
          );
          const fetchedServers = result.servers;

          const oldServers = config.servers.filter((s) => s.subscriptionId === subscription.id);
          const { servers: newServersToKeep, deletedIds } = SubscriptionService.reconcileServers(
            oldServers,
            fetchedServers,
            new Date().toISOString()
          );

          if (config.selectedServerId && deletedIds.has(config.selectedServerId)) {
            config.selectedServerId = null;
          }

          const otherServers = config.servers.filter((s) => s.subscriptionId !== subscription.id);
          config.servers = [...otherServers, ...newServersToKeep];
          subscription.lastUpdated = new Date().toISOString();
          if (result.userInfo) subscription.userInfo = result.userInfo;

          updatedCount++;
        } catch {
          failedCount++;
        }
      }

      await configManager.saveConfig(config);
      return { updated: updatedCount, failed: failedCount };
    }
  );

  console.log('[Subscription Handlers] Registered all subscription IPC handlers');
}
