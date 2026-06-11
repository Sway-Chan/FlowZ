/**
 * 系统能力 IPC 处理器：进程枚举（路由规则的进程快速选择器用）。
 */

import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { SystemProcessInfo } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { listSystemProcesses } from '../../services/ProcessEnumerator';

export function registerSystemHandlers(): void {
  registerIpcHandler<void, SystemProcessInfo[]>(
    IPC_CHANNELS.SYSTEM_LIST_PROCESSES,
    async (_event: IpcMainInvokeEvent) => listSystemProcesses()
  );

  console.log('[System Handlers] Registered system IPC handlers');
}
