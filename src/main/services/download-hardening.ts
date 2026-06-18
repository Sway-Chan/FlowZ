/**
 * 下载加固原语：收口 CoreUpdateService / UpdateService 文件下载中逐字相同、且「改一处易忘另一处」的
 * 两段加固——停滞看门狗 + content-length 完整性。这类漂移正是 fetchReleases 曾缺超时 bug 的同源问题。
 *
 * RuleResource.fetchBuffer 因含整体超时 + 内存 sink + content-encoding 跳过 + null 语义，差异较大，
 * 不强行套用本原语（适度独立）。纯逻辑、可单测（fake timers）。
 */

/**
 * 停滞看门狗：arm() 启动/重置 ms 计时，clear() 清除。ms 内未再 arm → 触发 onTimeout（调用方 abort+reject）。
 * 连接阶段与每次 data 各 arm 一次；end/error 时 clear。
 */
export function createIdleTimeout(
  onTimeout: () => void,
  ms: number
): { arm: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = (): void => {
    clear();
    timer = setTimeout(onTimeout, ms);
  };
  return { arm, clear };
}

/**
 * 解析 content-length 响应头为期望字节数（完整性校验基准）；缺失/非法回落 fallback（如 GitHub asset size），
 * 无可用回落则返回 NaN。调用方在 end 时以 `!isNaN(expected) && received !== expected` 判截断。
 */
export function parseExpectedBytes(
  header: string | string[] | undefined,
  fallback?: number
): number {
  const raw = Array.isArray(header) ? header[0] : header;
  const parsed = parseInt(raw as string, 10);
  if (!isNaN(parsed)) return parsed;
  return fallback != null && fallback > 0 ? fallback : NaN;
}
