/**
 * macOS 提权 helper IPC 处理器
 * 状态查询 + 安装/卸载（安装/卸载会弹一次 osascript 管理员授权框）。
 */

import { IpcMainInvokeEvent, app, shell } from 'electron';
import * as fs from 'fs';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { HelperStatus } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import type { HelperManager } from '../../services/HelperManager';
import type { IProxyManager } from '../../services/ProxyManager';

export function registerHelperHandlers(
  helperManager: HelperManager,
  proxyManager: IProxyManager
): void {
  registerIpcHandler<boolean | undefined, HelperStatus>(
    IPC_CHANNELS.HELPER_GET_STATUS,
    async (_event, force) => helperManager.getStatus(force === true)
  );

  registerIpcHandler<void, { success: boolean; error?: string; status: HelperStatus }>(
    IPC_CHANNELS.HELPER_INSTALL,
    async (_event: IpcMainInvokeEvent) => helperManager.install()
  );

  registerIpcHandler<void, { success: boolean; error?: string; status: HelperStatus }>(
    IPC_CHANNELS.HELPER_UNINSTALL,
    async (_event: IpcMainInvokeEvent) => {
      // 卸载前若代理正经 helper 运行：先用「仍在的 helper」零提权停核，再卸载。否则卸载后 helper socket
      // 消失，下次 stop 会落 forceKill 裸弹 osascript（无引导）。卸载本身的 osascript 授权是预期的一次。
      if (proxyManager.getStatus().running && proxyManager.isStartedViaHelper()) {
        await proxyManager.stop().catch(() => {});
      }
      return helperManager.uninstall();
    }
  );

  // 完全卸载 FlowZ：清 helper + 受保护目录（root，弹一次密码框）+ 用户配置 + 应用本体（移废纸篓），然后退出。
  registerIpcHandler<void, { ok: boolean; error?: string }>(
    IPC_CHANNELS.APP_UNINSTALL_ALL,
    async () => {
    try {
      // 停代理（在位 helper 零提权停核，避免卸载后裸弹 osascript）
      if (proxyManager.getStatus().running && proxyManager.isStartedViaHelper()) {
        await proxyManager.stop().catch(() => {});
      }
      // 1. 清 helper + 受保护目录（macOS：uninstall 脚本已 rm -rf /Library/Application Support/FlowZ，含受保护目录
      //    core/，弹一次密码框；非 macOS 无 helper，跳过）
      if (process.platform === 'darwin') {
        const r = await helperManager.uninstall();
        if (!r.success) {
          return { ok: false, error: r.error || 'helper 卸载失败，已中止完全卸载' };
        }
      }
      // 2. 删用户数据（config/日志等，用户目录可写、无需 root）
      try {
        fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
      } catch {
        /* 尽力清理 */
      }
      // 3. 应用本体移入废纸篓（比 rm 安全、可恢复）；仅对确为 .app 包的路径操作。
      try {
        const appBundle = app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '');
        if (appBundle.endsWith('.app')) {
          await shell.trashItem(appBundle);
        }
      } catch {
        /* 删不掉 .app 不阻断退出 */
      }
      // 4. 退出（留 0.5s 让 IPC 回执先到达渲染端）
      setTimeout(() => app.quit(), 500);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
