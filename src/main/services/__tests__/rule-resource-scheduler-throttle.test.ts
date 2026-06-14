/**
 * RuleResourceScheduler 资源库目录刷新节流单测（B）。
 *
 * 节流语义：catalog 刷新取「上次成功 fetchedAt 与上次尝试 lastCatalogRefreshAttempt 的较晚者」，
 * 间隔（默认 12h）内不重试——fetchedAt 未成功时恒 0，靠 lastCatalogRefreshAttempt 兜住失败重试，
 * 避免离线/限流时每 30min tick 白打 GitHub。
 *
 * 直接置 started=true 并调 private runDueUpdates（避开 start() 的 12s/30min 定时器），
 * mock configManager/ruleResourceManager/logManager。
 */
jest.mock('electron', () => ({
  app: { getPath: jest.fn().mockReturnValue('/tmp/fake-userdata') },
}));

import { RuleResourceScheduler } from '../RuleResourceScheduler';

function makeMocks(fetchedAt: number | null) {
  const configManager = {
    loadConfig: jest.fn().mockResolvedValue({
      ruleResourceAutoUpdate: true,
      ruleResources: [], // 空资源列表：跳过 .srs 下载循环，聚焦 catalog 节流
      ruleResourceUpdateIntervalHours: 12,
    }),
  };
  const ruleResourceManager = {
    getCatalog: jest.fn().mockResolvedValue({ fetchedAt }),
    refreshCatalog: jest.fn().mockResolvedValue(undefined),
    updateMany: jest.fn().mockResolvedValue([]), // 内置 geo 规则集磁盘缺失时被调；返回空不影响 catalog 节流断言
  };
  const logManager = { addLog: jest.fn() };
  return { configManager, ruleResourceManager, logManager };
}

describe('RuleResourceScheduler 资源库目录刷新节流', () => {
  it('fetchedAt=0（从未成功）→ 首次刷新，间隔内再调不重试', async () => {
    const m = makeMocks(0);
    const sched = new RuleResourceScheduler(
      m.configManager as any,
      m.ruleResourceManager as any,
      m.logManager as any
    );
    (sched as any).started = true; // 避开 start() 定时器

    await (sched as any).runDueUpdates('test');
    expect(m.ruleResourceManager.refreshCatalog).toHaveBeenCalledTimes(1);

    // 间隔内（12h）再调：lastCatalogRefreshAttempt 已置为上次 now → 节流不重拉
    await (sched as any).runDueUpdates('test');
    expect(m.ruleResourceManager.refreshCatalog).toHaveBeenCalledTimes(1);
  });

  it('fetchedAt 较新（间隔内已成功）→ 不刷新', async () => {
    const recent = Date.now() - 1000; // 1s 前（远小于 12h）
    const m = makeMocks(recent);
    const sched = new RuleResourceScheduler(
      m.configManager as any,
      m.ruleResourceManager as any,
      m.logManager as any
    );
    (sched as any).started = true;

    await (sched as any).runDueUpdates('test');
    expect(m.ruleResourceManager.refreshCatalog).not.toHaveBeenCalled();
  });

  it('ruleResourceAutoUpdate=false → 不刷新（总开关关）', async () => {
    const m = makeMocks(0);
    m.configManager.loadConfig.mockResolvedValue({
      ruleResourceAutoUpdate: false,
      ruleResources: [],
      ruleResourceUpdateIntervalHours: 12,
    });
    const sched = new RuleResourceScheduler(
      m.configManager as any,
      m.ruleResourceManager as any,
      m.logManager as any
    );
    (sched as any).started = true;

    await (sched as any).runDueUpdates('test');
    expect(m.ruleResourceManager.refreshCatalog).not.toHaveBeenCalled();
  });
});
