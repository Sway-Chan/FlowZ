/**
 * SpeedTestService.runWithLimit 单测（纯并发逻辑、无网络/无 sing-box）：测速预热+正式测速的并发上限工作池。
 * 验证：每项恰处理一次、并发不超上限、小订阅(items≤limit)全并行、空数组 no-op。私有方法经 (svc as any) 直调。
 */
import { SpeedTestService } from '../SpeedTestService';

const mockLog = { addLog: () => {} } as unknown as ConstructorParameters<
  typeof SpeedTestService
>[0];

describe('SpeedTestService.runWithLimit（并发上限工作池）', () => {
  const svc = new SpeedTestService(mockLog) as unknown as {
    runWithLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>;
  };

  it('所有项恰好处理一次，且并发不超过上限', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const processed: number[] = [];
    let active = 0;
    let maxActive = 0;
    await svc.runWithLimit(items, 8, async (x: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      processed.push(x);
      active--;
    });
    expect(processed.slice().sort((a, b) => a - b)).toEqual(items); // 每项恰一次、不漏不重
    expect(maxActive).toBeLessThanOrEqual(8); // 并发不超上限
    expect(maxActive).toBeGreaterThan(1); // 确实在并发
  });

  it('items ≤ limit：全并行（worker 数=items，零额外延迟）', async () => {
    let active = 0;
    let maxActive = 0;
    await svc.runWithLimit([1, 2, 3], 32, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(maxActive).toBe(3);
  });

  it('空数组：no-op', async () => {
    let called = 0;
    await svc.runWithLimit([], 8, async () => {
      called++;
    });
    expect(called).toBe(0);
  });
});
