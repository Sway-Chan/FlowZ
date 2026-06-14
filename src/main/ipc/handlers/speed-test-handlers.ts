/**
 * 测速相关 IPC 处理器
 */

import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { registerIpcHandler } from '../ipc-handler';
import { ConfigManager } from '../../services/ConfigManager';

import { SpeedTestService } from '../../services/SpeedTestService';

/**
 * 注册测速相关的 IPC 处理器
 */
export function registerSpeedTestHandlers(
  configManager: ConfigManager,
  speedTestService: SpeedTestService
): void {
  // 服务器测速
  registerIpcHandler<{ serverIds?: string[] }, Record<string, number>>(
    IPC_CHANNELS.SERVER_SPEED_TEST,
    async (event: IpcMainInvokeEvent, args?: { serverIds?: string[] }) => {
      const config = await configManager.loadConfig();
      const results: Record<string, number> = {};

      const serversToTest = args?.serverIds
        ? config.servers.filter((s) => args.serverIds!.includes(s.id))
        : config.servers;

      // 逐节点回调：每测完一个节点立即发送 EVENT（渲染端订阅增量更新），不等队列。
      const rawResults = await speedTestService.testAllServers(
        serversToTest,
        (serverId, latency) => {
          event.sender.send(IPC_CHANNELS.EVENT_SPEED_TEST_RESULT, {
            serverId,
            latency: latency === null ? -1 : latency,
          });
        },
        (tested, ok, total) => {
          event.sender.send(IPC_CHANNELS.EVENT_SPEED_TEST_PROGRESS, { tested, ok, total });
        },
        config.speedTestUrl
      );

      for (const [id, latency] of rawResults.entries()) {
        results[id] = latency === null ? -1 : latency;
      }

      return results;
    }
  );
}
