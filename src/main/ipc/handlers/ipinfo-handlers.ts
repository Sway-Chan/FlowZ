/**
 * 出口 IP 信息 IPC 处理器：渲染端主动拉取（可 force 强刷）当前快照。
 * 推送更新走 EVENT_IP_INFO_UPDATED（由 IpInfoService.onUpdate 广播）。
 */

import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { IpInfoSnapshot } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import type { IpInfoService } from '../../services/IpInfoService';

export function registerIpInfoHandlers(ipInfoService: IpInfoService): void {
  registerIpcHandler<{ force?: boolean } | undefined, IpInfoSnapshot>(
    IPC_CHANNELS.IP_INFO_GET,
    async (_event: IpcMainInvokeEvent, args?: { force?: boolean }) =>
      ipInfoService.refresh(args?.force ?? false)
  );
}
