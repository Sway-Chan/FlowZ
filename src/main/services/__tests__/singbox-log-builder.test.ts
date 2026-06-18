/**
 * buildLogConfig 单测 —— 原 ProxyManager.generateLogConfig 无单测（仅 config-snapshot 集成锁字节）。
 * 锁：日志级别（含隐私抬级）/ disableLogFile / TUN(mac·win) output 文件路径分支（按平台）。
 */
jest.mock('electron', () => ({
  app: { getPath: () => '/fake/userData', getAppPath: () => '/fake/app', isPackaged: false },
  net: {},
}));

import { buildLogConfig } from '../singbox-log-builder';
import type { UserConfig } from '../../../shared/types';
import { withPlatform } from './platform-test-utils';

const cfg = (over: Partial<UserConfig>): UserConfig => over as unknown as UserConfig;

describe('buildLogConfig', () => {
  it('默认 info + timestamp；privacyMode=true → 抬到 ≥warn', () => {
    expect(buildLogConfig(cfg({}), false)).toMatchObject({ level: 'info', timestamp: true });
    const priv = buildLogConfig(cfg({ logLevel: 'info' }), true);
    expect(['warn', 'error', 'fatal']).toContain(priv.level); // 隐私从源头不记连接明细
  });

  it('disableLogFile → disabled:true，提前返回（无 output）', () => {
    const c = withPlatform('darwin', () =>
      buildLogConfig(cfg({ proxyModeType: 'tun', disableLogFile: true }), false)
    );
    expect(c.disabled).toBe(true);
    expect(c.output).toBeUndefined();
  });

  it('systemProxy（任意平台）→ 不写 output（stdout 可捕获）', () => {
    const c = withPlatform('darwin', () =>
      buildLogConfig(cfg({ proxyModeType: 'systemProxy' }), false)
    );
    expect(c.output).toBeUndefined();
  });

  it('TUN + macOS/Windows → 写 output 文件路径（提权运行时无法捕获 stdout）', () => {
    const mac = withPlatform('darwin', () => buildLogConfig(cfg({ proxyModeType: 'tun' }), false));
    expect(mac.output).toMatch(/\.log$/);
    const win = withPlatform('win32', () => buildLogConfig(cfg({ proxyModeType: 'tun' }), false));
    expect(win.output).toMatch(/\.log$/);
  });

  it('TUN + Linux → 不写 output（非 mac/win 不需要文件中转）', () => {
    const c = withPlatform('linux', () => buildLogConfig(cfg({ proxyModeType: 'tun' }), false));
    expect(c.output).toBeUndefined();
  });
});
