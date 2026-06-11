/**
 * 隐私模式密码 IPC 处理器（F29）。
 * 设置/校验全在 main 进行；明文与哈希都不下发渲染端，渲染端只能拿到 hasPassword 布尔与 verify 结果。
 */
import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { registerIpcHandler } from '../ipc-handler';
import {
  hashPassword,
  verifyPassword,
  readPrivacyHash,
  writePrivacyHash,
  hasPrivacyPassword,
} from '../../utils/privacy-lock';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerPrivacyHandlers(): void {
  // 设置/清除隐私密码：main 哈希后写独立文件；plain==='' 即清除
  registerIpcHandler<{ plain: string }, { success: boolean }>(
    IPC_CHANNELS.PRIVACY_SET_PASSWORD,
    async (_e: IpcMainInvokeEvent, args: { plain: string }) => {
      const { getPrivacyMode } = require('../../index');
      // 锁屏态禁止改/清密码：否则可先清空再解锁，白送一条绕过链
      if (getPrivacyMode()) return { success: false };
      const plain = args?.plain ?? '';
      if (plain === '') writePrivacyHash(null);
      else writePrivacyHash(await hashPassword(plain));
      return { success: true };
    }
  );

  // 解锁校验：在 main 比对；无密码立即放行；ok 时由 main 退出隐私模式（复用 exitPrivacyMode 广播）
  registerIpcHandler<{ plain: string }, { ok: boolean }>(
    IPC_CHANNELS.PRIVACY_UNLOCK,
    async (_e: IpcMainInvokeEvent, args: { plain: string }) => {
      const h = readPrivacyHash();
      const ok = h === null ? true : await verifyPassword(args?.plain ?? '', h);
      if (ok) {
        const { setPrivacyMode } = require('../../index');
        setPrivacyMode(false);
      } else {
        await sleep(300); // 弱速率限制 + 抹平时序差
      }
      return { ok };
    }
  );

  // 是否已设密码（仅布尔，绝不泄漏哈希）
  registerIpcHandler<void, boolean>(IPC_CHANNELS.PRIVACY_HAS_PASSWORD, async () =>
    hasPrivacyPassword()
  );

  console.log('[Privacy Handlers] Registered privacy IPC handlers');
}
