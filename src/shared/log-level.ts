import type { LogLevel } from './types';

const ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];

/**
 * 隐私模式下的有效日志级别：把级别抬到至少 warn（info/debug 才会记录访问域名/SNI 等连接明细，warn 及以上不记），
 * 从而在隐私模式下源头收敛连接日志（sing-box）与应用日志（app.log）。非隐私模式原样返回用户所设级别。
 * 单一真值 config.logLevel 经此函数派生有效级别，同时喂给 sing-box config 与 LogManager，保持两者一致。
 */
export function effectiveLogLevel(level: LogLevel, privacy: boolean): LogLevel {
  if (!privacy) return level;
  const cur = ORDER.indexOf(level);
  const warn = ORDER.indexOf('warn');
  // 非法/未知级别（indexOf=-1）保守视为需收敛 → warn
  return cur < warn ? 'warn' : level;
}
