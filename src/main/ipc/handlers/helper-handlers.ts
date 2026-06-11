/**
 * macOS 提权 helper IPC 处理器
 * 状态查询 + 安装/卸载（安装/卸载会弹一次 osascript 管理员授权框）。
 */

import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { HelperStatus } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import type { HelperManager } from '../../services/HelperManager';

export function registerHelperHandlers(helperManager: HelperManager): void {
  registerIpcHandler<void, HelperStatus>(IPC_CHANNELS.HELPER_GET_STATUS, async () =>
    helperManager.getStatus()
  );

  registerIpcHandler<void, { success: boolean; error?: string; status: HelperStatus }>(
    IPC_CHANNELS.HELPER_INSTALL,
    async (_event: IpcMainInvokeEvent) => helperManager.install()
  );

  registerIpcHandler<void, { success: boolean; error?: string; status: HelperStatus }>(
    IPC_CHANNELS.HELPER_UNINSTALL,
    async (_event: IpcMainInvokeEvent) => helperManager.uninstall()
  );

  console.log('[Helper Handlers] Registered all helper IPC handlers');
}
