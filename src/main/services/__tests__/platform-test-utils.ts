/**
 * 平台敏感单测共享夹具：临时改写 process.platform 跑 fn，结束后恢复原值。
 * config-gen 多处按 process.platform 分支（TUN 栈/排除段/日志 output 路径），共享避免各 *.test.ts 重复定义。
 */
export function withPlatform<T>(plat: NodeJS.Platform, fn: () => T): T {
  const orig = process.platform;
  Object.defineProperty(process, 'platform', { value: plat, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  }
}
