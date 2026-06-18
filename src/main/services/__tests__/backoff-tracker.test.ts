import { BackoffTracker } from '../backoff-tracker';

describe('BackoffTracker', () => {
  const BASE = 1000;
  const MAX = 8000;

  it('无记录 → isEligible true', () => {
    const b = new BackoffTracker(BASE, MAX);
    expect(b.isEligible('x', 0)).toBe(true);
  });

  it('recordFailure 指数退避 BASE*2^(n-1)，capped MAX', () => {
    const b = new BackoffTracker(BASE, MAX);
    expect(b.recordFailure('x', 0)).toEqual({ failures: 1, delayMs: 1000 });
    expect(b.recordFailure('x', 0)).toEqual({ failures: 2, delayMs: 2000 });
    expect(b.recordFailure('x', 0)).toEqual({ failures: 3, delayMs: 4000 });
    expect(b.recordFailure('x', 0)).toEqual({ failures: 4, delayMs: 8000 }); // 8000=MAX
    expect(b.recordFailure('x', 0)).toEqual({ failures: 5, delayMs: 8000 }); // capped
  });

  it('退避窗口内 isEligible false，过点后 true', () => {
    const b = new BackoffTracker(BASE, MAX);
    b.recordFailure('x', 1000); // nextEligibleAt = 1000 + 1000 = 2000
    expect(b.isEligible('x', 1999)).toBe(false);
    expect(b.isEligible('x', 2000)).toBe(true);
  });

  it('recordSuccess 清零，下次失败从 1 起', () => {
    const b = new BackoffTracker(BASE, MAX);
    b.recordFailure('x', 0);
    b.recordFailure('x', 0);
    b.recordSuccess('x');
    expect(b.isEligible('x', 0)).toBe(true);
    expect(b.recordFailure('x', 0)).toEqual({ failures: 1, delayMs: 1000 });
  });

  it('prune 剪除不在活跃集合的键', () => {
    const b = new BackoffTracker(BASE, MAX);
    b.recordFailure('a', 0); // nextEligibleAt = 1000
    b.recordFailure('b', 0);
    b.prune(new Set(['a']));
    // b 被剪 → 重新可尝试且失败从 1 起；a 保留退避
    expect(b.isEligible('b', 0)).toBe(true);
    expect(b.recordFailure('b', 0)).toEqual({ failures: 1, delayMs: 1000 });
    expect(b.isEligible('a', 0)).toBe(false);
  });

  it('多 id 独立计数', () => {
    const b = new BackoffTracker(BASE, MAX);
    b.recordFailure('a', 0);
    expect(b.recordFailure('b', 0)).toEqual({ failures: 1, delayMs: 1000 });
    expect(b.recordFailure('a', 0)).toEqual({ failures: 2, delayMs: 2000 });
  });
});
