/**
 * DiagnosticService 的日志取数单测：守住「报告里三段日志各读各的文件」这条路径收口。
 *
 * 为什么必须有：`paths.ts` 的 `getSingBoxStartupLogPath()` 注释声明「诊断报告与写侧共用本函数，杜绝两边
 * 路径漂移」，但在此之前这条声明只由 grep 保证——把 `getSingBoxStartupLogPath()` 误写成 `getSingBoxLogPath()`
 * 全套测试照样绿（报告只是把 singbox.log 渲染两遍，两个标题都在），`Promise.all` 三元组顺序错位同理无人拦。
 *
 * 只桩 IO 与协作对象，不碰真实文件系统、不碰宿主网络。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-diagsvc-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { DiagnosticService } from '../DiagnosticService';
import { getLogsPath, getSingBoxLogPath, getSingBoxStartupLogPath } from '../../utils/paths';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeSvc(opts: { startedViaHelper?: boolean } = {}): any {
  const configManager: any = { loadConfig: jest.fn().mockResolvedValue({ logLevel: 'info' }) };
  const logManager: any = { flush: jest.fn().mockResolvedValue(undefined) };
  const proxyManager: any = {
    getCoreVersion: jest.fn().mockResolvedValue('1.14.0-beta.2'),
    getStatus: jest.fn().mockReturnValue({ running: false }),
    isStartedViaHelper: jest.fn().mockReturnValue(!!opts.startedViaHelper),
    generateSingBoxConfig: jest.fn().mockReturnValue({ log: { level: 'info' } }),
    getCronetHealStats: jest.fn().mockReturnValue({ triggered: 0, failed: 0 }),
    getLastStartReadyRetries: jest.fn().mockReturnValue(0),
  };
  const systemProxyManager: any = { getProxyStatus: jest.fn().mockResolvedValue(null) };
  return new DiagnosticService(configManager, logManager, proxyManager, systemProxyManager) as any;
}

describe('DiagnosticService — 日志取数路径收口', () => {
  it('三段日志各读各的文件，startup log 走 getSingBoxStartupLogPath()（不与 singbox.log 同源）', async () => {
    const svc = makeSvc();
    const seen: string[] = [];
    jest.spyOn(svc, 'readTail').mockImplementation(async (...args: unknown[]) => {
      const p = args[0] as string;
      seen.push(p);
      return `tail-of:${path.basename(p)}`;
    });

    const md = await svc.buildReport();

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3); // 三个互不相同 → 排除「两段读同一文件」的漂移
    expect(seen[0]).toBe(path.join(getLogsPath(), 'app.log'));
    expect(seen[1]).toBe(getSingBoxLogPath());
    expect(seen[2]).toBe(getSingBoxStartupLogPath());
    // 顺序错位（把 singboxLogTail 与 startupLogTail 调换）会被下面两条钉住
    expect(md).toMatch(/## singbox\.log（近期）[\s\S]*tail-of:singbox\.log/);
    expect(md).toMatch(/## singbox_startup\.log[\s\S]*tail-of:singbox_startup\.log/);
  });

  it('Windows 非 helper 路径的段标题如实标注「不含核输出」（#324 假阴性防线）', async () => {
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const svc = makeSvc({ startedViaHelper: false });
      jest.spyOn(svc, 'readTail').mockResolvedValue('FlowZ watchdog starting...');
      const md = await svc.buildReport();
      expect(md).toContain('写侧 UAC 看护脚本');
      expect(md).toContain('不含核输出');
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true });
    }
  });

  it('helper 路径标注为含核 stdout+stderr 且只追加不截断', async () => {
    const svc = makeSvc({ startedViaHelper: true });
    jest.spyOn(svc, 'readTail').mockResolvedValue('FATAL[0000] boom');
    const md = await svc.buildReport();
    expect(md).toContain('核 stdout+stderr');
    expect(md).toContain('只追加不截断');
  });
});
