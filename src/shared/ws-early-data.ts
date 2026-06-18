/**
 * WebSocket 0-RTT 早数据：把 v2ray/xray 的 path `?ed=`(+可选 `eh=`)约定翻译成 sing-box 内核显式字段。
 *
 * 背景（#57 L2，已实测 + 查证官方文档）：
 * - xray/v2ray 客户端约定：path 里 `?ed=<bytes>` 启用早数据（首包长度阈值，推荐 2560、上限 8192），
 *   早数据载于 `Sec-WebSocket-Protocol` 头；`eh=<name>` 可自定义该头名（clash-meta/mihomo 约定，默认 Sec-WebSocket-Protocol）。
 * - sing-box 1.13 **不自动解析** path 里的 `?ed=`：它把整段 `/x?ed=2560` 当字面路径、`?` 编码成 `%3F` 发出，
 *   且默认早数据走 path 模式 → 与 xray 服务端按 `/x` 分流 + header 早数据的约定错位 → 连不上（实测 wire capture）。
 *   要兼容 xray 必须显式设 `max_early_data` + `early_data_header_name="Sec-WebSocket-Protocol"`（header 模式）。
 *
 * 故：在生成 sing-box 传输配置时把 path 里的 `ed`/`eh` 拆出来，落成内核字段；path 去掉 ed/eh（保留其它 query）。
 */

/** v2ray/xray 默认早数据头（header 模式，兼容 xray-core 必需）。 */
export const DEFAULT_EARLY_DATA_HEADER = 'Sec-WebSocket-Protocol';

export interface WsEarlyData {
  /** 去掉 ed/eh 后的 path（其它 query 保留）。 */
  path: string;
  /** path 含合法 `?ed=N`(N>0) 时为 N，否则 undefined。 */
  maxEarlyData?: number;
  /** maxEarlyData 存在时为 `eh` 值或默认 Sec-WebSocket-Protocol，否则 undefined。 */
  earlyDataHeaderName?: string;
}

/**
 * 解析 WS path 的早数据约定。无 `?ed=` 或 ed 非正整数 → 原样返回 path（不改、不设字段）。
 * 仅当 `ed` 为正整数时拆分：剥离 ed/eh、设 maxEarlyData=ed、earlyDataHeaderName=eh||默认头。
 */
export function parseWsEarlyData(rawPath: string): WsEarlyData {
  const path = rawPath || '/';
  const qIdx = path.indexOf('?');
  if (qIdx < 0) return { path };

  const pathname = path.slice(0, qIdx);
  const params = new URLSearchParams(path.slice(qIdx + 1));
  const edRaw = params.get('ed');
  if (edRaw == null) return { path }; // 无 ed → 不动

  const ed = Number.parseInt(edRaw, 10);
  if (!Number.isFinite(ed) || ed <= 0) return { path }; // ed 非法 → 保守不改，避免误伤

  const eh = params.get('eh') || DEFAULT_EARLY_DATA_HEADER;
  params.delete('ed');
  params.delete('eh');
  const rest = params.toString();
  return {
    path: rest ? `${pathname}?${rest}` : pathname,
    maxEarlyData: ed,
    earlyDataHeaderName: eh,
  };
}
