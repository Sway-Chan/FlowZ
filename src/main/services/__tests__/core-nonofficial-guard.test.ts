/**
 * 非官方（第三方 fork）内核 → 禁在线/自动更新 闸门单测。
 * 检测口径纯函数在 shared/__tests__/core-build.test.ts；本测验 CoreUpdateService 三处闸：
 *  - checkUpdate：fork → {hasUpdate:false,+禁用提示}，**不打网络**（fetchReleases 不被调用）。
 *  - updateCore：fork → throw（拒绝在线更新）。
 *  - tryApplyStaged：fork → 作废暂存官方核 + 'discarded'（不覆盖用户 fork）；fork+无 staged → 'noop'。
 *  - official → 不被 fork 闸拦（放行到 fetchReleases）。
 * 「换核检测」无需运行内核：注入假 proxyManager（仅给 getCoreVersionLine 返回不同版本行）即可直接测
 *  「官方→会话内换 fork」全链路（getCoreVersionLine→classifyCoreBuild→守卫），并验 updateCore/tryApplyStaged
 *  force 刷新（自包含、不吃陈旧缓存）。自动调度经 runAutoUpdateCycle→checkUpdate 同被 checkUpdate 闸覆盖。
 */

import * as os from 'os';
import * as fsSync from 'fs';
import * as path from 'path';

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-coreguard-test-'));
jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  dialog: {},
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { CoreUpdateService } from '../CoreUpdateService';

function mkSvc(): any {
  const logManager = { addLog: () => {} } as any;
  return new CoreUpdateService(logManager);
}

/** 假 proxyManager：仅承载换核检测所需的 getCoreVersionLine（可变版本行）+ getCoreVersion + 未运行状态。 */
function fakePm(initialLine: string) {
  let line = initialLine;
  return {
    setLine: (l: string) => {
      line = l;
    },
    getCoreVersionLine: jest.fn(async (_force?: boolean) => line),
    getCoreVersion: jest.fn(async (_force?: boolean) => {
      const m = line.match(/(\d+\.\d+\.\d+)/);
      return m ? m[1] : '未知';
    }),
    getStatus: () => ({ running: false }),
  } as any;
}

beforeEach(() => {
  // 显式隔离：清掉上一个测试经 saveAutoState 写盘的 staged/autoState（同一 TMP userData 跨 svc 实例共享）。
  try {
    fsSync.rmSync(path.join(TMP, 'core-update-state.json'));
  } catch {
    /* 不存在即可 */
  }
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('非官方内核更新闸门（给定 verdict）', () => {
  it('fork → checkUpdate 返回禁用提示且不打网络（fetchReleases 不被调用）', async () => {
    const svc = mkSvc();
    jest.spyOn(svc, 'getCoreBuild').mockResolvedValue('fork');
    const fetchSpy = jest.spyOn(svc.coreDownloader, 'fetchReleases');
    const r = await svc.checkUpdate();
    expect(r.hasUpdate).toBe(false);
    expect(r.error).toMatch(/第三方|非官方/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fork → updateCore 抛错（拒绝在线更新）', async () => {
    const svc = mkSvc();
    jest.spyOn(svc, 'getCoreBuild').mockResolvedValue('fork');
    await expect(svc.updateCore('https://example.com/x.tar.gz')).rejects.toThrow(/第三方|非官方/);
  });

  it('fork + 有 staged → tryApplyStaged 作废暂存官方核并返回 discarded', async () => {
    const svc = mkSvc();
    jest.spyOn(svc, 'getCoreBuild').mockResolvedValue('fork');
    svc.saveAutoState({
      staged: { version: '1.99.0', dir: path.join(TMP, 'staged'), stagedAt: 'x' },
    });
    expect(svc.loadAutoState().staged).toBeTruthy();
    const result = await svc.tryApplyStaged('manual-apply');
    expect(result).toBe('discarded');
    expect(svc.loadAutoState().staged).toBeFalsy();
  });

  it('fork + 无 staged → tryApplyStaged 返回 noop（不误报 discarded）', async () => {
    const svc = mkSvc();
    jest.spyOn(svc, 'getCoreBuild').mockResolvedValue('fork');
    expect(svc.loadAutoState().staged).toBeFalsy();
    expect(await svc.tryApplyStaged('proxy-stopped')).toBe('noop');
  });

  it('official → checkUpdate 不被 fork 闸拦（放行到 fetchReleases，正向断言）', async () => {
    const svc = mkSvc();
    jest.spyOn(svc, 'getCoreBuild').mockResolvedValue('official');
    const fetchSpy = jest.spyOn(svc.coreDownloader, 'fetchReleases').mockResolvedValue([]);
    const r = await svc.checkUpdate();
    expect(r.hasUpdate).toBe(false);
    expect(r.error).not.toMatch(/第三方|非官方/);
    expect(fetchSpy).toHaveBeenCalled(); // 确实走到官方在线检查路径
  });
});

describe('换核检测全链路（注入版本行，无需运行内核）', () => {
  it('官方版本行 → getCoreBuild=official，checkUpdate 放行', async () => {
    const svc = mkSvc();
    svc.setProxyManager(fakePm('sing-box version 1.13.13'));
    jest.spyOn(svc.coreDownloader, 'fetchReleases').mockResolvedValue([]);
    expect(await svc.getCoreBuild()).toBe('official');
    const r = await svc.checkUpdate();
    expect(r.error).not.toMatch(/第三方|非官方/);
  });

  it('会话内换核 官方→fork：即时被守卫拦下（证明守卫跟随当前实跑内核、非陈旧缓存）', async () => {
    const svc = mkSvc();
    const pm = fakePm('sing-box version 1.13.13');
    svc.setProxyManager(pm);
    jest.spyOn(svc.coreDownloader, 'fetchReleases').mockResolvedValue([]);
    // 起始官方：放行
    expect((await svc.checkUpdate()).error).not.toMatch(/第三方|非官方/);

    // 换到第三方 fork（仅改版本行，无需重启/运行）
    pm.setLine('sing-box version 1.13.13-reF1nd');
    expect(await svc.getCoreBuild(true)).toBe('fork');
    const r = await svc.checkUpdate();
    expect(r.hasUpdate).toBe(false);
    expect(r.error).toMatch(/第三方|非官方/);

    // updateCore 守卫 force 刷新版本行（自包含，不依赖调用方先刷新）
    const lineSpy = jest.spyOn(pm, 'getCoreVersionLine');
    await expect(svc.updateCore('https://x/y.tar.gz')).rejects.toThrow(/第三方|非官方/);
    expect(lineSpy).toHaveBeenCalledWith(true);
  });

  it('官方 dev 构建（base-短commit hex）不误判为 fork', async () => {
    const svc = mkSvc();
    svc.setProxyManager(fakePm('sing-box version 1.13.13-78b2e12'));
    expect(await svc.getCoreBuild()).toBe('official');
  });
});
