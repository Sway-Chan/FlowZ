/** macOS「系统设置 → 通用 → 登录项与扩展」深链（「允许在后台」开关所在面板）。main / renderer 共用。 */
export const LOGIN_ITEMS_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';

/**
 * 应用对外 HTTP 请求 User-Agent 单点常量。
 * 用于 GitHub API、release/资源下载等 electron net.request 出站请求头。
 * 注意：与订阅 UA（`FlowZ/<版本>`，见 SubscriptionService.defaultSubscriptionUserAgent）语义不同——
 * 订阅 UA 需伪装成中性客户端规避机场拦截，此处仅作应用自标识。
 */
export const APP_USER_AGENT = 'FlowZ-Electron';
