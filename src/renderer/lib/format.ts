/** 字节数格式化为人类可读（B/KB/MB/GB/TB）。 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${units[i]}`;
}
