/**
 * 多行文本框输入解析：按换行拆 + trim + 去空（每行一条目）。
 * 收口设置「例外清单」编辑器与规则值编辑器中逐字相同的 split('\n').map(trim).filter(Boolean)。
 */
export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
