/**
 * ProxyManager 启动路径快照单测（issue #324 排查噪声）。
 *
 * exit / setTimeout 回调必须按【本次 spawn 实际走的启动路径】判定，不能现查 needsOsascript()/
 * needsWindowsUAC()——二者读 currentConfig（**当前**模式）。模式切换（系统代理 → TUN）时旧核被 SIGTERM 停，
 * 其 exit 回调此刻已看到新模式 tun → 直起的 sing-box 被当成 UAC 包装进程判定，一次正常停核被误报成
 * 「UAC 授权失败，退出码: null」，把排查带偏到提权方向。
 *
 * 平台谓词经 `(svc as any)` 打桩（宿主是 Linux），spawn 全 mock：不起真进程、不碰 PowerShell/网卡。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');
const { EventEmitter } = require('events');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-launchpath-'));
const FAKE_CORE = path.join(TMP, 'sing-box');
fsSync.writeFileSync(FAKE_CORE, '#!/bin/sh\n');

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

const spawnMock = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { ProxyManager } from '../ProxyManager';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** spawn 出的假进程：只需 pid + exit 事件（stdout/stderr 置 null 走「无管道」分支）。 */
function makeFakeChild(): any {
  const child: any = new EventEmitter();
  child.pid = 4321;
  child.stdout = null;
  child.stderr = null;
  child.kill = jest.fn();
  return child;
}

/**
 * @param uacNow 谓词现值提供者：模拟「回调里现查当前模式」——测试可在 spawn 后翻转它。
 */
function makeSvc(uacNow: () => boolean): any {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  fsSync.writeFileSync(configPath, '{}');
  const svc: any = new ProxyManager(undefined, undefined, configPath, FAKE_CORE);
  svc.currentConfig = { proxyModeType: 'systemProxy', servers: [] };
  svc.needsOsascript = () => false;
  svc.needsWindowsUAC = () => uacNow();
  // Windows UAC 分支的提权命令构造（走 service 注入路径，不落 inline PowerShell 兜底）
  svc.privilegeService = {
    // 宿主是 Linux：needsPrivilege 恒 false，让 needsLinuxTun 不把本用例拖进 Linux setcap/helper 支路。
    needsPrivilege: () => false,
    ensureCapabilities: jest.fn().mockResolvedValue(undefined),
    generateWatchdogScript: () => ({ path: path.join(TMP, 'watchdog.ps1') }),
    buildElevatedLaunchCommand: () => ({ command: 'powershell.exe', args: ['-NoProfile'] }),
  };
  svc.helperManager = undefined;
  svc.logToManager = jest.fn();
  svc.sendEventToRenderer = jest.fn();
  svc.cleanup = jest.fn();
  svc.startHealthCheck = jest.fn();
  svc.startLogFileWatcher = jest.fn();
  svc.waitForPidFile = jest.fn().mockResolvedValue(undefined);
  return svc;
}

/** 等 spawn 真被调用（startSingBoxProcess 前置是 async），返回假子进程。 */
async function spawnedChild(): Promise<any> {
  for (let i = 0; i < 200 && spawnMock.mock.calls.length === 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
  expect(spawnMock).toHaveBeenCalled();
  return spawnMock.mock.results[0].value;
}

describe('issue #324 — 启动路径按 spawn 时快照判定，不随模式切换漂移', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeFakeChild());
  });

  it('直起的核在启动期被 SIGTERM 停 + 期间模式已切到 TUN → 不误报「UAC 授权失败」', async () => {
    let uac = false; // spawn 时：系统代理模式（直起）
    const svc = makeSvc(() => uac);
    const p = svc.startSingBoxProcess(svc.lifecycleGeneration ?? 0);
    const child = await spawnedChild();

    // 模式切换：currentConfig 已变 tun，此刻谓词现值翻转（修复前 exit 回调会据此误判）
    uac = true;
    svc.currentConfig = { proxyModeType: 'tun', servers: [] };
    child.emit('exit', null, 'SIGTERM');

    await expect(p).rejects.toThrow(/启动期退出 \(code=null, signal=SIGTERM\)/);
    const logged = svc.logToManager.mock.calls.map((c: unknown[]) => String(c[1])).join('\n');
    expect(logged).not.toMatch(/UAC 授权失败/);
    expect(logged).not.toMatch(/用户取消了管理员权限请求/);
  });

  it('直起的核以 code=1 退出 + 期间模式已切到 TUN → 按核退出码归因，不误报「用户取消授权」', async () => {
    let uac = false; // spawn 时：系统代理模式（直起），退出码归 parseStartupError
    const svc = makeSvc(() => uac);
    const p = svc.startSingBoxProcess(svc.lifecycleGeneration ?? 0);
    const child = await spawnedChild();

    uac = true; // 模式切换：谓词现值翻转（修复前 code===1 会被读成「用户取消 UAC」）
    svc.currentConfig = { proxyModeType: 'tun', servers: [] };
    child.emit('exit', 1, null);

    await expect(p).rejects.toThrow(/sing-box 启动失败，请检查配置文件和服务器设置/);
    expect(svc.logToManager.mock.calls.map((c: unknown[]) => String(c[1])).join('\n')).not.toMatch(
      /用户取消了管理员权限请求/
    );
  });

  it('spawn 后 1s 成功判定期内模式切到 TUN → 仍按直起路径判成功，不去等 TUN 的 PID 文件', async () => {
    let uac = false; // spawn 时：直起，成功判据是 singboxProcess && pid
    const svc = makeSvc(() => uac);
    const p = svc.startSingBoxProcess(svc.lifecycleGeneration ?? 0);
    await spawnedChild();

    uac = true; // 1s 判定窗口内模式切换（修复前 setTimeout 会改走 waitForPidFile → 误判「无法获取 PID」）
    svc.currentConfig = { proxyModeType: 'tun', servers: [] };

    await expect(p).resolves.toBeUndefined();
    expect(svc.waitForPidFile).not.toHaveBeenCalled();
  });

  it('确实走 UAC 包装路径时，包装进程被信号杀（code=null）也不判授权失败', async () => {
    const svc = makeSvc(() => true); // 全程 Windows TUN 路径
    const p = svc.startSingBoxProcess(svc.lifecycleGeneration ?? 0);
    const child = await spawnedChild();

    child.emit('exit', null, 'SIGTERM');

    await expect(p).rejects.toThrow(/启动期退出 \(code=null, signal=SIGTERM\)/);
    expect(svc.logToManager.mock.calls.map((c: unknown[]) => String(c[1])).join('\n')).not.toMatch(
      /UAC 授权失败/
    );
  });

  it('UAC 路径下用户取消授权（code=1）仍报「用户取消了管理员权限请求」（不回归）', async () => {
    const svc = makeSvc(() => true);
    const p = svc.startSingBoxProcess(svc.lifecycleGeneration ?? 0);
    const child = await spawnedChild();

    child.emit('exit', 1, null);

    await expect(p).rejects.toThrow(/用户取消了管理员权限请求/);
  });

  it('UAC 路径下包装进程非零退出（code=2）仍报「UAC 授权失败」（不回归）', async () => {
    const svc = makeSvc(() => true);
    const p = svc.startSingBoxProcess(svc.lifecycleGeneration ?? 0);
    const child = await spawnedChild();

    child.emit('exit', 2, null);

    await expect(p).rejects.toThrow(/UAC 授权失败，退出码: 2/);
  });
});
