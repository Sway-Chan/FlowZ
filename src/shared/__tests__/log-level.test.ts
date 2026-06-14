import { effectiveLogLevel } from '../log-level';

describe('effectiveLogLevel — 隐私模式日志抬级', () => {
  it('非隐私 → 原样返回用户所设级别', () => {
    expect(effectiveLogLevel('debug', false)).toBe('debug');
    expect(effectiveLogLevel('info', false)).toBe('info');
    expect(effectiveLogLevel('warn', false)).toBe('warn');
    expect(effectiveLogLevel('error', false)).toBe('error');
    expect(effectiveLogLevel('fatal', false)).toBe('fatal');
  });
  it('隐私 + debug/info（会记访问域名/SNI）→ 抬到 warn 收敛连接明细', () => {
    expect(effectiveLogLevel('debug', true)).toBe('warn');
    expect(effectiveLogLevel('info', true)).toBe('warn');
  });
  it('隐私 + warn/error/fatal（本就不记明细）→ 不降级、原样', () => {
    expect(effectiveLogLevel('warn', true)).toBe('warn');
    expect(effectiveLogLevel('error', true)).toBe('error');
    expect(effectiveLogLevel('fatal', true)).toBe('fatal');
  });
  it('隐私 + 非法/未知级别 → 保守抬到 warn', () => {
    expect(effectiveLogLevel('xxx' as never, true)).toBe('warn');
  });
});
