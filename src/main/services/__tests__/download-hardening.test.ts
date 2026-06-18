import { createIdleTimeout, parseExpectedBytes } from '../download-hardening';

describe('createIdleTimeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('arm 后 ms 到点触发 onTimeout', () => {
    const onTimeout = jest.fn();
    const idle = createIdleTimeout(onTimeout, 1000);
    idle.arm();
    jest.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('再次 arm 重置计时（持续有数据则不触发）', () => {
    const onTimeout = jest.fn();
    const idle = createIdleTimeout(onTimeout, 1000);
    idle.arm();
    jest.advanceTimersByTime(800);
    idle.arm(); // 重置
    jest.advanceTimersByTime(800);
    expect(onTimeout).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('clear 后不再触发', () => {
    const onTimeout = jest.fn();
    const idle = createIdleTimeout(onTimeout, 1000);
    idle.arm();
    idle.clear();
    jest.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe('parseExpectedBytes', () => {
  it('合法 content-length → 数值', () => {
    expect(parseExpectedBytes('12345')).toBe(12345);
  });
  it('数组头取首个', () => {
    expect(parseExpectedBytes(['678', '999'])).toBe(678);
  });
  it('缺失 → 回落 fallback（asset size）', () => {
    expect(parseExpectedBytes(undefined, 4096)).toBe(4096);
  });
  it('缺失且无回落 → NaN', () => {
    expect(Number.isNaN(parseExpectedBytes(undefined))).toBe(true);
  });
  it('非法且无正回落 → NaN', () => {
    expect(Number.isNaN(parseExpectedBytes('abc'))).toBe(true);
    expect(Number.isNaN(parseExpectedBytes('abc', 0))).toBe(true);
  });
});
