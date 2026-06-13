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
    async (_event: IpcMainInvokeEvent, args?: { serverIds?: string[] }) => {
      const config = await configManager.loadConfig();
      const results: Record<string, number> = {};

      const serversToTest = args?.serverIds
        ? config.servers.filter((s) => args.serverIds!.includes(s.id))
        : config.servers;

      const rawResults = await speedTestService.testAllServers(serversToTest);

      for (const [id, latency] of rawResults.entries()) {
        results[id] = latency === null ? -1 : latency;
      }

      return results;
    }
  );
}
