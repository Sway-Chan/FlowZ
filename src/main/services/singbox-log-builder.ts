/**
 * sing-box 日志配置生成 —— 从 ProxyManager.generateLogConfig 抽出（SingBoxConfigBuilder 抽取 Phase 2 step 8）。
 * 纯函数：只读 config + 注入 privacyMode（隐私模式经 effectiveLogLevel 抬到 ≥warn）。
 * config 字节等价由 config-snapshot 网验证（含 TUN-darwin/win32 的 output 文件路径分支）。
 */

import type { UserConfig } from '../../shared/types';
import { effectiveLogLevel } from '../../shared/log-level';
import { getSingBoxLogPath } from '../utils/paths';
import type { SingBoxLogConfig } from './singbox-config-types';

/**
 * 生成日志配置
 */
export function buildLogConfig(config: UserConfig, privacyMode: boolean): SingBoxLogConfig {
  // 日志级别由用户配置（默认 info）。level 影响是否记录访问域名/SNI（info/debug 会记，warn+ 不记）。
  // 隐私模式经 effectiveLogLevel 抬到 ≥warn，从源头不让 sing-box 记录连接明细到 singbox.log。
  const logConfig: SingBoxLogConfig = {
    level: effectiveLogLevel(config.logLevel || 'info', privacyMode),
    timestamp: true,
  };

  // 用户关闭日志写盘：整体禁用 sing-box 日志（隐私/省盘），不再写文件
  if (config.disableLogFile) {
    logConfig.disabled = true;
    return logConfig;
  }

  // 在 TUN 模式下（macOS 和 Windows），使用权限提升运行时无法捕获 stdout
  // 需要将日志输出到文件，然后通过文件监控读取
  // 注意：这里直接根据 config 参数判断，而不是 this.currentConfig
  const isTunMode = config.proxyModeType?.toLowerCase() !== 'systemproxy';
  const isMacTunMode = process.platform === 'darwin' && isTunMode;
  const isWindowsTunMode = process.platform === 'win32' && isTunMode;

  if (isMacTunMode || isWindowsTunMode) {
    logConfig.output = getSingBoxLogPath();
  }

  return logConfig;
}
