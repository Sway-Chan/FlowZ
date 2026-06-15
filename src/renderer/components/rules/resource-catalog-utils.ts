/**
 * 资源库列表项状态机：由 TAB + 「本地是否已有」(present) 推导该项是否可勾选下载、是否标「文件缺失」。
 *
 * present 的语义按 TAB 不同（调用方负责求值）：
 * - 内置 TAB：随包规则集运行时文件是否在磁盘（fileExists）。
 * - 外置 TAB：是否下载记录在 且 磁盘文件实际存在（presentIds）。
 *
 * 关键不变量：
 * - 内置 TAB 永不可勾选下载；文件「该在却没在」(!present) = 真异常 → 标「文件缺失」。
 * - 外置 TAB 本地无 (!present，含从未下载 / 下载后文件被删) → 可勾选下载；
 *   「未下载」是远程清单的常态，**绝不**标「文件缺失」（那是面向用户的误导，整页变红噪音）。
 */
export function resolveCatalogItemState(
  tab: 'builtin' | 'external',
  present: boolean
): { selectable: boolean; missing: boolean } {
  if (tab === 'builtin') return { selectable: false, missing: !present };
  return { selectable: !present, missing: false };
}
