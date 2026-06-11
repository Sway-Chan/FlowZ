import { app, BrowserWindow, dialog, Menu, powerMonitor, shell } from 'electron';
import * as path from 'path';
import { ConfigManager } from './services/ConfigManager';
import { ProtocolParser } from './services/ProtocolParser';
import { LogManager } from './services/LogManager';
import { TrayManager } from './services/TrayManager';
import { ProxyManager } from './services/ProxyManager';
import { createSystemProxyManager, SystemProxyBase } from './services/SystemProxyManager';
import { resourceManager } from './services/ResourceManager';
import { SubscriptionService } from './services/SubscriptionService';
import { registerPrivacyHandlers } from './ipc/handlers/privacy-handlers';
import {
  registerConfigHandlers,
  registerServerHandlers,
  registerLogHandlers,
  registerProxyHandlers,
  registerVersionHandlers,
  registerAdminHandlers,
  registerUpdateHandlers,
  registerRulesHandlers,
  registerAutoStartHandlers,
  registerSpeedTestHandlers,
  registerSubscriptionHandlers,
  setUpdateService,
  setTrayStateCallback,
  registerCoreUpdateHandlers,
  setCoreUpdateService,
  registerBackupHandlers,
  registerHelperHandlers,
  registerIpInfoHandlers,
  registerSystemHandlers,
  registerRuleResourceHandlers,
} from './ipc/handlers';
import { createAutoStartManager } from './services/AutoStartManager';
import { UpdateService } from './services/UpdateService';
import { CoreUpdateService } from './services/CoreUpdateService';
import { SpeedTestService } from './services/SpeedTestService';
import { AutoSwitchService } from './services/AutoSwitchService';
import { SubscriptionScheduler } from './services/SubscriptionScheduler';
import { StatsService } from './services/StatsService';
import { IpInfoService } from './services/IpInfoService';
import { RuleResourceManager } from './services/RuleResourceManager';
import { seedBuiltinRuleSets } from './services/builtin-geo-rulesets';
import { RuleResourceScheduler } from './services/RuleResourceScheduler';
import { HelperManager } from './services/HelperManager';
import type { HelperStatus, UserConfig } from '../shared/types';
import { ipcEventEmitter } from './ipc/ipc-events';
import { mainEventEmitter, MAIN_EVENTS } from './ipc/main-events';
import { initUserDataPath } from './utils/paths';
import { IPC_CHANNELS } from '../shared/ipc-channels';

// 初始化用户数据路径（必须在 app.requestSingleInstanceLock() 之前调用）
// 以确保便携模式下，锁文件和所有 Electron 数据都重定向到正确的目录
initUserDataPath();

// Windows LTSC / 精简版系统兼容处理
// 如果用户是 LTSC 且黑屏，建议他们通过设置开启“禁用硬件加速”选项
// 强制开启软件渲染会导致正常 Windows 用户出现严重白屏或掉帧，因此这里移除全局强制设定。
// 仅保留基础的禁用 GPU 沙箱，防止部分环境权限不足导致的 GPU 进程崩溃
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// 开启 V8 手动 GC 能力，用于进入轻量模式时主动释放主进程堆内存
// 不影响正常运行，仅在 enterLightweightMode 时调用一次
try {
  require('v8').setFlagsFromString('--expose-gc');
} catch {
  // 部分环境不支持，忽略
}

// 单实例锁：防止开启多个软件实例
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
    // 当有人试图运行第二个实例时，聚焦并显示主窗口
    showWindow();
  });
}

let mainWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
const isDevelopment = process.env.NODE_ENV === 'development';
let idleCheckInterval: NodeJS.Timeout | null = null; // 自动空闲模式轮询（powerMonitor 真实系统输入空闲）

// Privacy Mode State (Main Process)
let isPrivacyMode = false;

/**
 * 获取隐私模式状态
 */
export function getPrivacyMode(): boolean {
  return isPrivacyMode;
}

/**
 * 设置隐私模式状态
 * @param value 是否开启
 */
export function setPrivacyMode(value: boolean): void {
  if (isPrivacyMode === value) return;
  isPrivacyMode = value;
  // 通知所有窗口同步此状态
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(value ? 'event:enterPrivacyMode' : 'event:exitPrivacyMode');
  }
}

// 自动空闲模式：用 powerMonitor 真实系统输入空闲判定（替代窗口 blur/hide 边沿武装；
// 覆盖「聚焦闲置 / 静默自启从未 show / 运行中才打开开关」等 blur/hide 模型盖不住的场景）。
const IDLE_THRESHOLD_SEC = 600; // 10 分钟（getSystemIdleTime 返回秒）
const IDLE_POLL_MS = 60 * 1000; // 轮询粒度 60s（实际触发约 10–11 分钟）

/**
 * 每 60s 检查系统输入空闲，达阈值则按开关进入轻量 / 隐私模式。
 * 轻量：聚焦时豁免（用户可能在盯拓扑/流量面板，不销毁眼前窗口）；隐私：锁屏语义，不豁免聚焦。
 * 进入后不会重复触发：轻量销毁窗口后 mainWindow 失效自动跳过；隐私置 isPrivacyMode 后跳过。
 */
async function checkIdleAutoModes(): Promise<void> {
  try {
    const cfg = await configManager.loadConfig().catch(() => null);
    if (!cfg) return;
    if (!cfg.autoLightweightMode && !cfg.autoPrivacyMode) return;
    if (powerMonitor.getSystemIdleTime() < IDLE_THRESHOLD_SEC) return;
    // 窗口创建在途时跳过本轮：轻量分支会 destroy 窗口，避免销毁 ensureWindow 半成品（防御，当前不可达）
    if (creatingWindow) return;

    if (
      cfg.autoLightweightMode &&
      trayManager &&
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.isFocused()
    ) {
      logManager.addLog('info', 'System idle reached, entering lightweight mode', 'Main');
      trayManager.enterLightweightMode();
    }

    if (cfg.autoPrivacyMode && !isPrivacyMode) {
      logManager.addLog('info', 'System idle reached, entering privacy mode', 'Main');
      setPrivacyMode(true);
    }
  } catch {
    // ignore
  }
}

// Initialize service references
let configManager: ConfigManager;
let protocolParser: ProtocolParser;
let logManager: LogManager;
let proxyManager: ProxyManager | null = null;
let systemProxyManager: ReturnType<typeof createSystemProxyManager>;
let updateService: UpdateService;
let coreUpdateService: CoreUpdateService;
let subscriptionService: SubscriptionService;
let speedTestService: SpeedTestService;
let autoSwitchService: AutoSwitchService;
let subscriptionScheduler: SubscriptionScheduler;
let statsService: StatsService | null = null;
let ipInfoService: IpInfoService | null = null;
let ruleResourceManager: RuleResourceManager | null = null;
let ruleResourceScheduler: RuleResourceScheduler | null = null;
let helperManager: HelperManager | null = null;
let currentLanguage = 'zh-CN'; // 渲染端 APP_SET_LANGUAGE 同步，供主进程 native dialog 文案选语言

/**
 * helper 引导对话框（注入 ProxyManager.setHelperGate，由 start() 在 darwin+TUN+helper 未就绪+未 dismiss
 * 时统一调用——收敛单点，覆盖按钮/托盘/切模式/config-changed 重启等全部入口）。
 * 返回 'abort' → 终止本次启动（终态等价 osascript 取消=停止态）；'proceed' → 继续（装好走零提权，否则 osascript 回退）。
 */
async function promptHelperGate(
  hs: HelperStatus,
  _config: UserConfig
): Promise<'proceed' | 'abort'> {
  if (!helperManager) return 'proceed';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  const zh = currentLanguage.toLowerCase().startsWith('zh');
  if (hs.backgroundDisabled) {
    // 后台被系统禁用：install 大概率被 BTM 拦截 → 引导去系统设置 reenable，而非「安装」
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: zh
        ? ['打开系统设置', '用系统授权启动', '取消']
        : ['Open System Settings', 'Use system auth', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: zh ? '提权助手后台运行被系统关闭' : 'Helper background run disabled',
      detail: zh
        ? '请在系统设置「登录项与扩展」重新开启本应用的「允许在后台」，否则 TUN 启停将每次弹系统授权。也可本次用系统授权启动。'
        : 'Re-enable "Allow in the Background" for this app under System Settings → Login Items & Extensions; otherwise TUN start/stop prompts each time. Or start with system auth this time.',
    });
    if (response === 2) return 'abort'; // 取消：不启动
    if (response === 0) {
      await shell
        .openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension')
        .catch(() => {});
      return 'abort'; // 去设置修，本次不启动
    }
    return 'proceed'; // response 1 → osascript 回退
  }
  // 未安装 / 路径不符 → 安装并启动
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: zh
      ? ['安装并启动', '用系统授权启动', '取消']
      : ['Install & start', 'Use system auth', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: zh ? '安装提权助手？' : 'Install privileged helper?',
    detail: zh
      ? '安装后 TUN 模式启停代理免每次系统授权；也可本次用系统授权启动。'
      : 'After install, TUN start/stop no longer needs system authorization each time; or start with system auth this time.',
  });
  if (response === 2) return 'abort'; // 取消：不启动
  if (response === 0) await helperManager.install().catch(() => {}); // 装好后 start 走 helper 零提权
  return 'proceed';
}

// 全局异常捕获 - 主进程
process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error);
  if (logManager) {
    logManager.addLog('fatal', `未捕获的异常: ${error.message}\n${error.stack}`, 'Main');
  }

  // 在开发环境显示错误对话框
  if (isDevelopment) {
    const electronApp = require('electron').app;
    if (electronApp?.isReady()) {
      dialog.showErrorBox('未捕获的异常', `${error.message}\n\n${error.stack}`);
    } else {
      console.error(`App not ready. Uncaught Exception: ${error.stack}`);
    }
  }

  // 不退出应用，尝试继续运行
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  const errorStack = reason instanceof Error ? reason.stack : '';
  if (logManager) {
    logManager.addLog('error', `未处理的 Promise 拒绝: ${errorMessage}\n${errorStack}`, 'Main');
  }

  // 在开发环境显示错误对话框
  if (isDevelopment && reason instanceof Error) {
    const electronApp = require('electron').app;
    if (electronApp?.isReady()) {
      dialog.showErrorBox('未处理的 Promise 拒绝', `${errorMessage}\n\n${errorStack}`);
    } else {
      console.error(`App not ready. Unhandled Rejection: ${errorStack}`);
    }
  }
});

// 开发环境启用热重载 (moved and unmounted since it causes app undefined bug in electron)

/**
 * 显示主窗口
 * 如果窗口不存在则创建，如果已存在则显示并聚焦
 */
// 创建中记忆：createWindow 在 new BrowserWindow 前 await loadConfig，多入口（启动/activate/托盘/second-instance）
// 在「无窗口」态并发触发会各自越过检查、建出两个窗口（首个泄漏）→ 所有入口共享同一次进行中的创建。
let creatingWindow: Promise<void> | null = null;
// 显式唤出请求：在途创建（可能属 silent 启动 forceShow=false）完成后由 ready-to-show 消费 → 绘制完成才显示，免未绘制帧闪现。
let pendingForceShow = false;
function ensureWindow(forceShow = false): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) return Promise.resolve();
  if (!creatingWindow) {
    creatingWindow = createWindow(forceShow)
      .catch((e) => {
        logManager.addLog(
          'error',
          `创建主窗口失败: ${e instanceof Error ? e.message : String(e)}`,
          'Main'
        );
      })
      .finally(() => {
        creatingWindow = null;
      });
  }
  return creatingWindow;
}

async function showWindow() {
  // Accessory 态下窗口无法成为 key window/置前 → 必须先回 Regular 再 show
  restoreDockPresence();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === 'darwin') app.focus({ steal: true }); // showWindow 恒为显式用户意图
    return;
  }
  // 标记待显示：在途创建若属 silent 启动，由 createWindow 的 ready-to-show 在绘制完成后显示（免未绘制帧闪现）
  pendingForceShow = true;
  await ensureWindow(true);
  // 兜底：ready-to-show 已在 await 解析前触发过（加载极快）且窗口仍隐藏 → 直接显示（此时已绘制完，无闪现）
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isLoading() &&
    !mainWindow.isVisible()
  ) {
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
  }
}

// ── macOS 菜单栏常驻：关窗即摘 Dock 图标 ───────────────────────────────────
// 机制（真机实测定论）：
// 1) `app.setActivationPolicy('accessory')` 让 `app.dock.isVisible()`→false（系统已认定无图标）；
// 2) 但仅改 policy 时 Dock 不刷新已显示的 tile → 图标视觉残留（前几次失败的真因，非 API 没生效）；
// 3) 紧跟 `app.hide()` 把前台交还前一 app → 真实 app 切换 → Dock 重绘、移除 accessory tile。
// 弃用 `app.dock.hide()`（底层 Carbon TransformProcessType 对 active app no-op + 1s 防抖，本就不可靠）。
let dockHidden = false; // 当前是否处于 accessory（菜单栏-only）

function hideDockIfMenubarOnly() {
  if (process.platform !== 'darwin') return;
  if (isQuitting || dockHidden) return;
  // 守卫：任一窗口仍可见（主窗 / 更新进度窗）则不摘 Dock——否则 app.hide() 会把它一并藏掉。
  // 用「全部窗口」判定（含主窗）→ 函数对任何调用点都自保，不依赖调用方保证主窗已隐藏（如进度窗关闭后重评估）。
  const anyVisible = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible());
  if (anyVisible) return;
  app.setActivationPolicy('accessory');
  dockHidden = true;
  app.hide(); // 触发 Dock 重绘以移除残留 tile（同步即时、无滞后）
}

/** 恢复 Dock 图标（accessory→regular）。必须在 show()/focus() 之前调用。 */
function restoreDockPresence(): void {
  if (process.platform !== 'darwin') return;
  if (!dockHidden) return;
  app.setActivationPolicy('regular');
  dockHidden = false;
  // Accessory→Regular 已知怪癖：窗口可能落在其他 app 之后/菜单栏不挂接 → 下一拍显式激活
  setTimeout(() => {
    if (!isQuitting) app.focus({ steal: true });
  }, 50);
}

// 任一窗口关闭后重评估「无可见窗口 → 菜单栏-only」：覆盖更新进度窗关闭、主窗轻量 destroy 等
// 主窗已隐藏的边缘（hideDockIfMenubarOnly 自带 anyVisible 守卫 → 仅真无可见窗口才摘，主窗仍开则 no-op）。
// 模块级注册（早于首个窗口创建）→ 含启动期主窗。主窗红灯关走 'hide'（非 'closed'），不经此、不重复。
if (process.platform === 'darwin') {
  app.on('browser-window-created', (_e, win) => {
    win.on('closed', () => {
      if (!isQuitting) hideDockIfMenubarOnly();
    });
  });
}

async function createWindow(forceShow = false) {
  // macOS 需要设置应用菜单以启用 Cmd+C/V/X/A 等快捷键
  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
          { role: 'delete', label: '删除' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'zoom', label: '缩放' },
          { type: 'separator' },
          { role: 'front', label: '前置全部窗口' },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  const isMac = process.platform === 'darwin';

  // 单次 loadConfig 读取窗口尺寸 + 主题（loadConfig 内部 catch 兜默认配置、绝不抛，无需 try/catch）。
  // 注意：transparent 仅 macOS 启用，Win/Linux 启用会侧边栏透明 + 鼠标事件穿透（Electron 已知问题）。
  let windowWidth = 1200;
  let windowHeight = 800;
  const cfg = await configManager.loadConfig();
  if (cfg.rememberWindowSize && cfg.windowBounds) {
    windowWidth = cfg.windowBounds.width;
    windowHeight = cfg.windowBounds.height;
  }
  if (cfg.uiTheme) {
    const { nativeTheme } = require('electron');
    nativeTheme.themeSource = cfg.uiTheme;
  }

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 800,
    minHeight: 600,
    title: 'FlowZ',
    icon: resourceManager.getAppIconPath(),
    show: false, // 先不显示，等待加载完成
    backgroundColor: isMac ? '#00000000' : cfg.uiTheme === 'dark' ? '#121217' : '#f1f5f9',
    transparent: isMac,
    autoHideMenuBar: true, // 自动隐藏菜单栏
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: isDevelopment, // 仅在开发环境启用开发者工具，生产环境禁用（除非特殊需求）
    },
    // macOS 特定配置
    ...(isMac && {
      titleBarStyle: 'hiddenInset',
      vibrancy: 'sidebar',
      visualEffectState: 'active',
    }),
  });

  // Windows: 监听系统主题变化，同步原生窗口背景色
  // 这是修复 GPU 待机后圆角处出现黑色伪影的关键：
  // 当 Chromium 合成器层缓存失效时，原生窗口背景会短暂露出，
  // 如果颜色和 sidebar 不匹配就会看到黑点。
  if (!isMac && mainWindow) {
    const { nativeTheme } = require('electron');
    // 命名 handler + 'closed' 时移除：否则每次 createWindow 累积一个全局监听器，
    // 自动轻量(销毁) × ensureWindow(重建) 的销毁-重建循环下无界累积（~10 轮 MaxListenersExceededWarning）。
    const onThemeUpdated = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const isDark = nativeTheme.shouldUseDarkColors;
        mainWindow.setBackgroundColor(isDark ? '#121217' : '#f1f5f9');
      }
    };
    nativeTheme.on('updated', onThemeUpdated);
    mainWindow.once('closed', () => nativeTheme.removeListener('updated', onThemeUpdated));
  }

  // ── 窗口尺寸记忆：监听 resize 并防抖保存 ──
  let resizeTimer: NodeJS.Timeout | null = null;
  mainWindow.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      try {
        const cfg = await configManager.loadConfig();
        if (cfg.rememberWindowSize && mainWindow && !mainWindow.isDestroyed()) {
          const [w, h] = mainWindow.getSize();
          cfg.windowBounds = { width: w, height: h };
          await configManager.saveConfig(cfg);
        }
      } catch {
        // 保存失败不影响使用
      }
    }, 500);
  });

  // 移除默认菜单栏（Windows/Linux）
  if (process.platform !== 'darwin') {
    mainWindow.setMenu(null);
  }

  // 注册窗口到 IPC 事件发送器，以便接收广播事件
  ipcEventEmitter.registerWindow(mainWindow);

  // 更新托盘管理器的窗口引用
  if (trayManager) {
    trayManager.setMainWindow(mainWindow);
  }

  // 窗口加载完成后显示
  mainWindow.once('ready-to-show', async () => {
    // 立即消费 pendingForceShow（早于任何 await，避免与并发 showWindow 竞态）：显式唤出在途 silent 启动时强制显示
    const wantShow = forceShow || pendingForceShow;
    pendingForceShow = false;
    try {
      const cfg = await configManager.loadConfig();
      const isHiddenArg = process.argv.includes('--hidden');
      const isMacHidden =
        process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden;

      // forceShow：用户显式唤出窗口（托盘「打开主窗口」/ activate / 窗口被销毁后重建）时绕过静默启动门控，
      // 否则 silentStart=true 时点了没反应。仅应用初始启动（forceShow=false）才尊重 silentStart。
      if (wantShow || (!cfg.silentStart && !isHiddenArg && !isMacHidden)) {
        mainWindow?.show();
        logManager.addLog('info', 'Main window shown', 'Main');
      } else {
        logManager.addLog('info', 'Main window kept hidden (Silent Start)', 'Main');
        // 静默启动窗口从不显示 → 主动进入菜单栏-only，否则 Dock 图标空挂直到首次 show→hide（P1-2）
        if (process.platform === 'darwin') hideDockIfMenubarOnly();
      }
    } catch {
      // 如果配置加载失败，默认显示窗口
      mainWindow?.show();
    }
  });

  // 开发环境加载 Vite 开发服务器
  if (isDevelopment) {
    mainWindow.loadURL('http://localhost:5173').catch((err) => {
      logManager.addLog('error', `Failed to load dev server: ${err.message}`, 'Main');
    });
    // mainWindow.webContents.openDevTools(); // 移除自动打开，改为手动打开 (Cmd+Option+I)
  } else {
    // 生产环境加载打包后的文件
    let indexPath: string;

    // 生产环境默认不打开开发者工具
    // 如果需要调试，可以通过快捷键 (Cmd/Ctrl+Shift+I) 打开，
    // 因为 webPreferences.devTools 仍然是 enable 的

    indexPath = path.join(__dirname, '../../renderer/index.html');

    mainWindow.loadFile(indexPath).catch((err) => {
      logManager.addLog('error', `Failed to load index.html: ${err.message}`, 'Main');
    });
  }

  // 处理窗口加载错误
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    logManager.addLog('error', `Window failed to load: ${errorDescription} (${errorCode})`, 'Main');
  });

  // macOS：隐藏到托盘时摘 Dock 图标（仅驻留菜单栏，不占 Dock / Cmd-Tab），重新显示时恢复。
  // 经 activation policy 状态机（见 hideDockIfMenubarOnly/restoreDockPresence），覆盖所有显隐路径。
  if (process.platform === 'darwin') {
    mainWindow.on('hide', () => {
      // setActivationPolicy('accessory') + app.hide() 摘 Dock 图标（实测机制见 hideDockIfMenubarOnly）。
      if (!isQuitting) hideDockIfMenubarOnly();
    });
    mainWindow.on('show', () => {
      // 兜底：未经 showWindow 的直接 show()（ready-to-show / 托盘 helper 引导）也恢复 Dock 图标
      restoreDockPresence();
    });
  }

  // 处理窗口关闭事件
  // 注意：必须同步调用 preventDefault()，否则窗口会直接销毁。
  // 任何 await 操作都应该在此之后。
  mainWindow.on('close', (event) => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;

    // 退出管线（Cmd+Q/Dock/托盘退出 → app.quit() → before-quit 置 isQuitting）：放行销毁，
    // 不再 preventDefault→hide，否则 macOS 上 quit 会被吞成"隐藏"、will-quit 清理永不执行（根因 A）。
    if (isQuitting) return;

    // 默认先阻止关闭
    event.preventDefault();

    // 异步获取配置并决定是隐藏还是真正销毁
    configManager
      .loadConfig()
      .then((config) => {
        if (window.isDestroyed()) return;

        // macOS：关窗按钮恒隐藏（mac 惯例——红灯关窗不退应用），保留渲染态、避免重建开销与状态错乱
        // （焦点/激活项/currentView 不丢）。其余平台按 minimizeToTray 决定隐藏或销毁。
        if (process.platform === 'darwin' || config.minimizeToTray) {
          window.hide();
          logManager.addLog('info', 'Window hidden to tray', 'Main');
        } else {
          // 允许窗口销毁，不再 preventDefault
          // 既然已经调用过 preventDefault，我们需要手动调用 destroy
          logManager.addLog('info', 'Window destroying (minimizeToTray off)', 'Main');
          window.destroy();
        }
      })
      .catch((err) => {
        console.error('Failed to load config during window close:', err);
        if (!window.isDestroyed()) window.destroy();
      });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (trayManager) {
      trayManager.setMainWindow(null);
    }
    // 轻量 destroy 的 Dock 摘除由模块级 browser-window-created → 'closed' 钩子统一处理（不在此重复）。
    logManager.addLog('info', 'Main window closed', 'Main');
  });

  // Windows 系统注销/关机：BrowserWindow 的 win32 'session-end' 是真实事件（app 不发它）。
  // 同步兜底关掉系统代理，防注销/关机后注册表代理残留致重启断网。
  mainWindow.on('session-end', () => {
    if (!gotTheLock) return;
    logManager.addLog('warn', 'OS session-end detected, syncing cleanup', 'Main');
    syncCleanupOnExit();
  });
}

/**
 * 清理应用资源
 * 在应用退出前调用，确保清理系统代理和终止进程
 */
async function cleanupResources(): Promise<void> {
  // 幂等 + 并发安全：多入口共享同一次清理 promise——并发第二入口 await 同一进行中清理，不截断。
  // 注意：更新流程不走这里（改用非终态的 runCleanup），避免安装失败后 app 续命却把一次性清理标记毒化。
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      // 整体 try/catch 兜底：退出清理 promise 永不 reject——否则 memoize 会把 rejected 态钉死，
      // 令并发 await 它的 SIGTERM/SIGINT handler 抛错、吞掉 process.exit。logManager 在 ready 前可能未就绪 → 可选链。
      try {
        logManager?.addLog('info', 'Cleaning up resources before exit...', 'Main');
        let timer: ReturnType<typeof setTimeout> | undefined;
        // 限时：退出清理 ≤8s 硬上限，超时则放弃继续退出 —— 绝不让清理无限阻塞退出。
        await Promise.race([
          runCleanup(),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              logManager?.addLog('warn', 'Cleanup timed out (8s), proceeding to exit', 'Main');
              resolve();
            }, 8000);
          }),
        ]);
        if (timer) clearTimeout(timer); // 正常完成则清计时器，避免误导性的超时 warn
      } catch (e) {
        console.error('cleanupResources error:', e);
      }
    })();
  }
  return cleanupPromise;
}

async function runCleanup(): Promise<void> {
  try {
    // 0. 停止后台定时器（订阅调度 / 自动换节点 / 自动空闲轮询）
    if (idleCheckInterval) {
      clearInterval(idleCheckInterval);
      idleCheckInterval = null;
    }
    subscriptionScheduler?.stop();
    ruleResourceScheduler?.stop();
    autoSwitchService?.destroy();

    // 1. 拆除代理（去 status.running 门控：跨会话孤儿 / 隐藏会话残留也必须回收；退出语境零提权弹框）
    if (proxyManager) {
      logManager.addLog('info', 'Tearing down proxy for quit...', 'Main');
      await proxyManager.teardownForQuit();
      logManager.addLog('info', 'Proxy torn down', 'Main');
    }

    // 2. 清理系统代理设置（marker 门控：仅关 FlowZ 自己设置的系统代理；TUN 模式 / 用户自配的企业/第三方
    //    代理无 marker → 不动，符合通用-E「仅 FlowZ 自己设置的才被强关」不变量。跨会话残留由 marker 兜）。
    try {
      const proxyStatus = await systemProxyManager.getProxyStatus();
      if (proxyStatus.enabled && SystemProxyBase.readMarker()) {
        logManager.addLog('info', 'Disabling system proxy...', 'Main');
        await systemProxyManager.disableProxy();
        logManager.addLog('info', 'System proxy disabled', 'Main');
      }
    } catch (error) {
      // 系统代理清理失败不应阻止应用退出
      const errorMessage = error instanceof Error ? error.message : String(error);
      logManager.addLog('warn', `Failed to disable system proxy: ${errorMessage}`, 'Main');
      console.warn('Failed to disable system proxy:', error);
    }

    logManager.addLog('info', 'Resource cleanup completed', 'Main');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logManager.addLog('error', `Error during cleanup: ${errorMessage}`, 'Main');
    console.error('Error during cleanup:', error);
  }
}

/**
 * 导出托盘管理器（用于测试）
 */
export function getTrayManager(): TrayManager | null {
  return trayManager;
}

/**
 * 更新托盘菜单状态
 * @param isProxyRunning 代理是否正在运行
 * @param hasError 是否存在连接错误
 */
async function updateTrayMenuState(isProxyRunning: boolean, hasError?: boolean): Promise<void> {
  if (!trayManager) return;

  try {
    const config = await configManager.loadConfig();
    trayManager.updateFullTrayMenu({
      isProxyRunning,
      hasError,
      servers: config.servers,
      subscriptions: config.subscriptions || [],
      selectedServerId: config.selectedServerId,
      proxyMode: config.proxyMode,
      proxyModeType: config.proxyModeType,
    });

    // 同时更新托盘图标状态
    trayManager.updateTrayIcon(isProxyRunning ? 'connected' : 'idle');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logManager.addLog('error', `Failed to update tray menu state: ${errorMessage}`, 'Main');
  }
}

if (gotTheLock) {
  app.whenReady().then(async () => {
    // 初始化服务
    configManager = new ConfigManager();
    protocolParser = new ProtocolParser();
    logManager = new LogManager();
    systemProxyManager = createSystemProxyManager();
    updateService = new UpdateService(logManager);
    coreUpdateService = new CoreUpdateService(logManager);
    subscriptionService = new SubscriptionService(protocolParser, logManager);
    speedTestService = new SpeedTestService(logManager);
    // 记录应用启动日志
    logManager.addLog('info', 'Application started', 'Main');

    // 启动期系统代理 marker 恢复：上次会话崩溃/强杀/断电导致 disableProxy 未执行时 marker 残留，
    // 实查系统代理仍指向我们（127.0.0.1:<记录端口>，或 host 匹配兜 mac socks 端口差异）则拆除，
    // 防用户重启后代理指向死端口断网。指向校验防 stomp 用户自配的本地代理；
    // marker 在但代理已非我们 → 只清 marker（否则退出门控永远放行、每次退出误关用户代理）。
    // 常规路径成本仅一次同步 ENOENT 读（无 marker 即跳过），不阻塞启动。
    try {
      const marker = SystemProxyBase.readMarker();
      if (marker) {
        const status = await systemProxyManager.getProxyStatus();
        const markerHost = marker.ourHostPort.split(':')[0];
        const candidates = [status.httpProxy, status.httpsProxy, status.socksProxy].filter(
          (p): p is string => !!p
        );
        const pointsToUs = candidates.some(
          (p) => p === marker.ourHostPort || p.split(':')[0] === markerHost
        );
        if (status.enabled && pointsToUs) {
          logManager.addLog(
            'warn',
            `检测到上次会话残留的系统代理(${marker.ourHostPort})，正在拆除...`,
            'Main'
          );
          await systemProxyManager.disableProxy(); // 拆除成功后内部 clearMarker
          logManager.addLog('info', '残留系统代理已拆除', 'Main');
        } else {
          // marker 失效（代理未启用 / 已被用户改走）→ 只清 marker，不动系统设置
          SystemProxyBase.clearMarkerFile();
          logManager.addLog('info', '清理失效的系统代理 marker（当前代理未指向本应用）', 'Main');
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logManager.addLog('warn', `启动期系统代理 marker 恢复失败: ${errorMessage}`, 'Main');
    }

    // macOS: 禁用 App Nap，防止系统认为应用"没有响应"
    // 当应用在后台运行代理时，App Nap 会导致系统误判应用状态
    if (process.platform === 'darwin') {
      const { powerSaveBlocker } = require('electron');
      powerSaveBlocker.start('prevent-app-suspension');
    }

    // macOS Dock 图标用 bundle 内置 icon.icns（已为透明球图标）；不再运行期 setIcon 覆盖，
    // 避免「启动后图标从带背景切成透明」的可见跳变（带背景仅来自旧图标的系统图标缓存，已透明化）。

    // 加载配置并处理错误
    try {
      const config = await configManager.loadConfig();
      logManager.addLog('info', 'Configuration loaded successfully', 'Main');

      // 检查配置是否为默认配置（可能是因为加载失败）
      if (config.servers.length === 0 && config.selectedServerId === null) {
        // 这可能是首次启动或配置文件损坏
        logManager.addLog('warn', 'Using default configuration', 'Main');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logManager.addLog('error', `Failed to load configuration: ${errorMessage}`, 'Main');

      // 显示错误对话框通知用户
      dialog.showErrorBox(
        '配置加载失败',
        `无法加载配置文件，将使用默认配置。\n\n错误信息: ${errorMessage}`
      );
    }

    await ensureWindow(); // 走串行化入口（forceShow=false 尊重 silentStart），与 activate/托盘/second-instance 共享创建

    // 初始化 ProxyManager（需要在窗口创建后）
    proxyManager = new ProxyManager(logManager, mainWindow || undefined);
    coreUpdateService.setProxyManager(proxyManager);
    coreUpdateService.setConfigProvider(() => configManager.loadConfig());

    // macOS 提权 helper：装一次后 TUN 模式启停 sing-box 免提权；未装则回退 PR-M1 看护脚本。
    helperManager = new HelperManager(logManager);
    proxyManager.setHelperManager(helperManager);
    proxyManager.setHelperGate(promptHelperGate);

    // 流量统计：代理运行时轮询 clash_api，经事件推渲染端展示（带 clash secret 鉴权）
    statsService = new StatsService(
      (stats) => ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_STATS_UPDATED, stats),
      () => proxyManager?.getClashApiSecret() ?? '',
      (snap) => ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_CONNECTIONS_UPDATED, snap)
    );

    // 出口 IP 信息：经探针 inbound 测本地直连出口 / 代理出口，事件驱动刷新（无周期轮询）
    ipInfoService = new IpInfoService(
      () => proxyManager?.getProbePorts() ?? null,
      () => proxyManager?.getStatus().running ?? false,
      (snap) => ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_IP_INFO_UPDATED, snap)
    );
    // 启动后拉一次本地直连出口 IP 初值
    setTimeout(() => void ipInfoService?.refresh(true), 2000);

    // 规则资源管理：下载 .srs / 动态 catalog / GitHub 加速；进度经事件推渲染端
    ruleResourceManager = new RuleResourceManager(
      configManager,
      (p) => ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_RULE_RESOURCE_PROGRESS, p),
      (cfg) => ipcEventEmitter.sendToAll('event:configChanged', { newValue: cfg }),
      (cfg) => mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, cfg)
    );
    // 启动即把内置 geo 规则集补种到运行时目录：缺失/损坏补种 + 出厂态下 app 升级带来的新出厂数据刷新
    // （不回滚网络更新版）。使「规则资源」页在首次启动代理前也能反映真实文件、可更新/重置；幂等、不阻塞启动。
    void configManager
      .loadConfig()
      .then((cfg) =>
        seedBuiltinRuleSets({ builtinGeoMeta: cfg?.builtinGeoMeta, refreshOutOfBox: true })
      )
      .catch(() => {});

    // 初始化自动换节点服务
    autoSwitchService = new AutoSwitchService(
      configManager,
      proxyManager,
      logManager,
      () => mainWindow
    );
    // 根据当前配置决定是否启用
    {
      const cfg = await configManager.loadConfig().catch(() => null);
      if (cfg?.autoSwitchNode) {
        autoSwitchService.enable();
      }
    }

    // 订阅自动更新调度器：启动补更陈旧订阅 + 周期更新（不打断当前连接）
    subscriptionScheduler = new SubscriptionScheduler(
      configManager,
      subscriptionService,
      logManager,
      () => proxyManager?.getStatus().running ?? false,
      (cfg) => {
        ipcEventEmitter.sendToAll('event:configChanged', { newValue: cfg });
        // P2-2：后台订阅更新增删节点后刷新托盘「选择服务器」子菜单（updateTrayMenuState 重载最新 config）。
        // 走 tray-only 刷新、不发 MAIN_EVENTS.CONFIG_CHANGED → 不触发 switchMode 重启，守住「不打断连接」不变量。
        void updateTrayMenuState(proxyManager?.getStatus().running ?? false);
      }
    );
    subscriptionScheduler.start();

    // 自动空闲模式：powerMonitor 真实系统输入空闲轮询（app ready 后才可用），替代窗口 blur/hide 边沿武装
    idleCheckInterval = setInterval(() => void checkIdleAutoModes(), IDLE_POLL_MS);

    // 规则资源自动更新调度（sing-box 不自更新本地 .srs，由 FlowZ 周期重下载；静默、不打断连接）
    ruleResourceScheduler = new RuleResourceScheduler(
      configManager,
      ruleResourceManager,
      logManager
    );
    ruleResourceScheduler.start();

    // 监听代理管理器事件，更新托盘状态。
    // 说明：同节点「原地重启」由 ProxyManager 内部接管（handleProcessExit / 健康检查 → attemptAutoRestart，
    // 单一计数器 + 上限 + 冷却）。'error' 仅在「自动重启被抑制（核心更新校验窗口）或已达上限」时触发，
    // 故此处只需处理：核心回滚 → 放弃恢复并清理系统代理。崩溃不触发换节点（换节点交给心跳连通性检测）。
    proxyManager.on('error', async (error: { message: string; code?: number }) => {
      logManager.addLog('error', `Proxy error: ${error.message}`, 'Main');
      // 发生错误时，更新托盘显示为"连接异常"
      updateTrayMenuState(false, true);

      // 1) 新核心首次启动失败（自动重启被抑制时）→ 自动回滚旧核心并重启
      try {
        const rolledBack = await coreUpdateService.autoRollbackIfPendingUpdate();
        if (rolledBack) {
          logManager.addLog('warn', '新核心启动失败，已自动回滚，正在以旧核心重启代理...', 'Main');
          const cfg = await configManager.loadConfig();
          await proxyManager?.start(cfg);
          return;
        }
      } catch (rollbackErr) {
        logManager.addLog('error', `自动回滚重启失败: ${rollbackErr}`, 'Main');
      }

      // 2) 放弃自动恢复（重启已达上限）：清理系统代理，避免网络不可用（错误已由 ProxyManager 投递前端）
      try {
        const proxyStatus = await systemProxyManager.getProxyStatus();
        if (proxyStatus.enabled) {
          logManager.addLog('info', 'Disabling system proxy due to proxy error...', 'Main');
          await systemProxyManager.disableProxy();
          logManager.addLog('info', 'System proxy disabled after error', 'Main');
        }
      } catch (cleanupError) {
        const errorMessage =
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        logManager.addLog(
          'warn',
          `Failed to disable system proxy after error: ${errorMessage}`,
          'Main'
        );
      }

      // 终态错误（放弃自动恢复）不一定走 'stopped' 事件 → 主动解绑主进程会话代理，否则 defaultSession
      // 仍指向已死的 http://127.0.0.1:<port>，更新检查/规则资源拉取一直失败。幂等：核心已死 → running=false → {mode:'system'}。
      await applyMainSessionProxy();
    });

    // 主进程 defaultSession 代理总开关 mainSessionViaProxy（默认开）：running ∧ 开关开 → 借道 http 代理；
    // 否则 → {mode:'system'}（尊重 OS 系统代理、非裸 direct）。每次 config 变更重入幂等。
    // 注：TUN 模式 OS 层捕获，「关」也不能完全直连（probe-direct 路由深修待真机验证后补）。
    let lastMainSessionProxyOn: boolean | null = null; // 仅状态翻转时记日志，避免每次 config 保存刷屏
    const applyMainSessionProxy = async () => {
      try {
        const { session } = require('electron');
        const cfg = await configManager.loadConfig();
        const running = proxyManager?.getStatus().running ?? false;
        const on = running && cfg.mainSessionViaProxy !== false;
        if (on) {
          const proxyUrl = `http://127.0.0.1:${cfg.httpPort || 2080}`;
          await session.defaultSession.setProxy({
            proxyRules: proxyUrl,
            // IPv6 字面量须加方括号才是合法 Chromium bypass 规则（loopback 本就隐式 bypass，[::1] 仅为显式）
            proxyBypassRules: '127.0.0.1,localhost,[::1]',
          });
          if (lastMainSessionProxyOn !== true) {
            logManager.addLog('info', `Electron 主进程更新检查走代理: ${proxyUrl}`, 'Main');
          }
        } else {
          await session.defaultSession.setProxy({ mode: 'system' });
          if (lastMainSessionProxyOn === true) {
            logManager.addLog('info', 'Electron 主进程更新检查恢复直连/系统代理', 'Main');
          }
        }
        lastMainSessionProxyOn = on;
      } catch (err) {
        logManager.addLog('warn', `应用主进程会话代理失败: ${err}`, 'Main');
      }
    };

    proxyManager.on('started', async () => {
      statsService?.start();
      subscriptionScheduler?.onProxyStarted(); // 代理就绪 → 补跑因 viaProxy 跳过的启动订阅更新
      try {
        await coreUpdateService.recordSuccessfulVersion();
        logManager.addLog('info', '已记录当前运行的内核版本基线', 'Main');
      } catch (e) {
        logManager.addLog('warn', `记录内核基线版本失败: ${e}`, 'Main');
      }

      await applyMainSessionProxy();

      // 代理就绪后延迟刷新出口 IP（等 selector / 探针 inbound 起来）
      setTimeout(() => void ipInfoService?.refresh(true), 1500);
    });

    // 节点热切换成功（clash_api PUT 已生效）→ 只重测代理出口（本地出口不因切节点变）。
    // 由 main 在热切换出口触发，避免渲染端猜时机导致探针先于切换落地而测到旧节点。
    proxyManager.on('node-hot-switched', () => void ipInfoService?.refreshProxy());

    proxyManager.on('stopped', async () => {
      statsService?.stop();
      await applyMainSessionProxy(); // running=false → {mode:'system'}，恢复主进程会话直连/系统代理

      // 停止后重测出口 IP（proxy 置 null，direct 走主进程裸直连）
      void ipInfoService?.refresh(true);

      // 正常停止时，重置错误状态
      updateTrayMenuState(false, false);

      // 确保系统代理被清理
      try {
        const proxyStatus = await systemProxyManager.getProxyStatus();
        if (proxyStatus.enabled) {
          await systemProxyManager.disableProxy();
          logManager.addLog('info', 'System proxy disabled on stop', 'Main');
        }
      } catch (cleanupError) {
        const errorMessage =
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        logManager.addLog(
          'warn',
          `Failed to disable system proxy on stop: ${errorMessage}`,
          'Main'
        );
      }
    });

    // 注册 IPC 处理器（需要在 ProxyManager 创建后）
    registerConfigHandlers(configManager);
    registerPrivacyHandlers();
    registerServerHandlers(protocolParser, configManager);
    registerLogHandlers(logManager, proxyManager);
    registerProxyHandlers(proxyManager, systemProxyManager, statsService);
    registerIpInfoHandlers(ipInfoService);
    registerSystemHandlers();
    registerRuleResourceHandlers(ruleResourceManager);
    registerVersionHandlers(coreUpdateService);
    registerAdminHandlers();

    registerRulesHandlers(configManager);

    // 注册核心更新处理器
    setCoreUpdateService(coreUpdateService, logManager);
    registerCoreUpdateHandlers();

    // 注册自启动处理器
    registerAutoStartHandlers();

    // 注册订阅处理器
    registerSubscriptionHandlers(subscriptionService, configManager);

    // 注册备份与恢复处理器
    registerBackupHandlers(configManager);

    // 注册提权 helper 处理器（macOS 免提权启停）
    registerHelperHandlers(helperManager);

    // 同步自启动状态
    const autoStartManager = createAutoStartManager();
    const config = await configManager.loadConfig();
    await autoStartManager.setAutoStart(config.autoStart ?? false);

    // 注册更新处理器
    setUpdateService(updateService);
    updateService.setMainWindow(mainWindow);
    // 设置更新前的清理回调，确保在安装更新前停止代理进程
    // 更新流程用非终态的 runCleanup（不消耗退出管线的一次性清理 promise）：安装失败 app 续命后，
    // 后续真正退出仍能完整拆除代理；安装成功则 app.exit 直接退，runCleanup 已先行清理。
    updateService.setCleanupCallback(runCleanup);
    registerUpdateHandlers();

    // 注册测速处理器
    registerSpeedTestHandlers(configManager, speedTestService);

    // 设置托盘状态更新回调
    setTrayStateCallback((isRunning: boolean, hasError?: boolean) => {
      updateTrayMenuState(isRunning, hasError);
    });

    // 监听渲染进程语言同步
    const { ipcMain } = require('electron');
    ipcMain.handle(IPC_CHANNELS.APP_SET_LANGUAGE, (_: any, lang: string) => {
      currentLanguage = lang || currentLanguage;
      if (trayManager) {
        trayManager.setLanguage(lang);
      }
    });

    // 创建托盘图标
    trayManager = new TrayManager(mainWindow, logManager, {
      onStartProxy: async () => {
        try {
          const config = await configManager.loadConfig();
          // helper 引导已收敛到 ProxyManager.start() 单点（promptHelperGate 注入），托盘启动自动覆盖。
          if (proxyManager) {
            await proxyManager.start(config);

            // 系统代理模式：设置系统代理
            const modeType = (config.proxyModeType || 'systemProxy').toLowerCase();
            if (modeType === 'systemproxy') {
              await systemProxyManager.enableProxy(
                '127.0.0.1',
                config.httpPort || 2080,
                config.socksPort || 2081
              );
            }

            logManager.addLog('info', 'Proxy started from tray', 'Main');
            // 更新托盘菜单状态
            updateTrayMenuState(true);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logManager.addLog('error', `Failed to start proxy: ${errorMessage}`, 'Main');
        }
      },
      onStopProxy: async () => {
        try {
          // 先禁用系统代理（不管当前状态如何，都尝试禁用）
          await systemProxyManager.disableProxy();

          if (proxyManager) {
            await proxyManager.stop();
            logManager.addLog('info', 'Proxy stopped from tray', 'Main');
            // 更新托盘菜单状态
            updateTrayMenuState(false);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logManager.addLog('error', `Failed to stop proxy: ${errorMessage}`, 'Main');
        }
      },
      onShowWindow: () => {
        showWindow();
      },
      onQuit: () => {
        // 收敛到单一退出管线：app.quit() → before-quit(置 isQuitting) → close 放行 → will-quit → cleanupResources → exit
        app.quit();
      },
      onSelectServer: async (serverId: string) => {
        try {
          const config = await configManager.loadConfig();
          config.selectedServerId = serverId;
          await configManager.saveConfig(config);
          logManager.addLog('info', `Server selected from tray: ${serverId}`, 'Main');

          // 如果代理正在运行，应用新服务器：切节点走 switchMode（clash_api 热切换、不断流），
          // 失败自动退回重启——与渲染端切换路径行为一致，避免托盘切节点硬重启断流。
          if (proxyManager && proxyManager.getStatus().running) {
            await proxyManager.switchMode(config);
            logManager.addLog('info', 'Applied server switch from tray', 'Main');
          }

          // 更新托盘菜单
          updateTrayMenuState(proxyManager?.getStatus().running ?? false);

          // 通知渲染进程配置已更新
          ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logManager.addLog('error', `Failed to select server: ${errorMessage}`, 'Main');
        }
      },
      onChangeProxyMode: async (mode) => {
        try {
          const config = await configManager.loadConfig();
          config.proxyMode = mode;
          await configManager.saveConfig(config);
          logManager.addLog('info', `Proxy mode changed from tray: ${mode}`, 'Main');

          // 如果代理正在运行，重启以应用新模式
          if (proxyManager && proxyManager.getStatus().running) {
            await proxyManager.stop();
            await proxyManager.start(config);
            logManager.addLog('info', 'Proxy restarted with new mode', 'Main');
          }

          // 更新托盘菜单
          updateTrayMenuState(proxyManager?.getStatus().running ?? false);

          // 通知渲染进程配置已更新
          ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logManager.addLog('error', `Failed to change proxy mode: ${errorMessage}`, 'Main');
          // helper gate 取消等导致 start 中止 → 代理已停，刷新托盘态防显示陈旧「运行中」
          updateTrayMenuState(proxyManager?.getStatus().running ?? false);
        }
      },
      onChangeProxyModeType: async (modeType) => {
        try {
          const config = await configManager.loadConfig();
          config.proxyModeType = modeType;
          await configManager.saveConfig(config);
          logManager.addLog('info', `Takeover mode changed from tray: ${modeType}`, 'Main');

          // 运行中则重启以应用新接管方式（TUN 模式若已装 helper，start 走零提权路径）
          if (proxyManager && proxyManager.getStatus().running) {
            await proxyManager.stop();
            await proxyManager.start(config);
            logManager.addLog('info', 'Proxy restarted with new takeover mode', 'Main');
          }

          updateTrayMenuState(proxyManager?.getStatus().running ?? false);
          ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logManager.addLog('error', `Failed to change takeover mode: ${errorMessage}`, 'Main');
          // helper gate 取消等导致 start 中止 → 代理已停，刷新托盘态防显示陈旧「运行中」
          updateTrayMenuState(proxyManager?.getStatus().running ?? false);
        }
      },
      onOpenSettings: () => {
        showWindow();
        // 发送导航事件到渲染进程
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('navigate', '/settings');
        }
      },
      onCheckUpdate: async () => {
        // 检查更新并显示对话框
        const result = await updateService.checkForUpdate();
        if (result.hasUpdate && result.updateInfo) {
          const action = await updateService.showUpdateDialog(result.updateInfo);
          if (action === 'update') {
            // 使用带进度窗口的下载方法
            const filePath = await updateService.downloadUpdateWithProgress(result.updateInfo);
            if (filePath) {
              await updateService.installUpdate(filePath);
            }
          } else if (action === 'skip') {
            updateService.skipVersion(result.updateInfo.version);
          }
        } else if (!result.error) {
          // 没有更新，显示提示
          if (mainWindow && !mainWindow.isDestroyed()) {
            const { dialog } = require('electron');
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '检查更新',
              message: '当前已是最新版本',
              buttons: ['确定'],
            });
          }
        }
      },
      onManageServers: () => {
        showWindow();
        // 发送导航事件到渲染进程
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('navigate', '/server');
        }
      },
      onSpeedTest: async () => {
        try {
          const config = await configManager.loadConfig();
          if (config.servers.length === 0) {
            logManager.addLog('warn', 'No servers configured for speed test', 'Main');
            return;
          }

          logManager.addLog(
            'info',
            `Starting speed test for ${config.servers.length} servers`,
            'Main'
          );

          // 复用 SpeedTestService，自动处理 TCP 和 UDP 协议
          const results = await speedTestService.testAllServers(config.servers);

          logManager.addLog('info', 'Speed test completed for all servers', 'Main');

          if (trayManager) {
            trayManager.updateSpeedTestResults(results, config.servers);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logManager.addLog('error', `Speed test failed: ${errorMessage}`, 'Main');

          if (trayManager) {
            trayManager.updateSpeedTestResults(new Map(), []);
          }
        }
      },
      onEnterPrivacyMode: () => {
        setPrivacyMode(true); // 置主进程 flag（单一真值）并广播；避免渲染端异步回写竞态/窗口重建丢锁
      },
    });
    trayManager.createTray();

    // 初始化托盘菜单状态
    updateTrayMenuState(false);

    // 启动时自动连接（延迟 2 秒，等待窗口和服务初始化完成）
    setTimeout(async () => {
      try {
        const config = await configManager.loadConfig();

        // 检查 sing-box 内核版本是否发生变化（检测更新是否破坏配置兼容性）
        try {
          const lastKnownVersion = coreUpdateService.getLastKnownGoodVersion();
          const currentVersion = await coreUpdateService.getCurrentVersion();
          if (
            lastKnownVersion &&
            currentVersion !== '未知' &&
            lastKnownVersion !== currentVersion
          ) {
            logManager.addLog(
              'warn',
              `sing-box 内核版本已变更: ${lastKnownVersion} → ${currentVersion}，通知用户`,
              'Main'
            );
            ipcEventEmitter.sendToAll(IPC_CHANNELS.EVENT_CORE_VERSION_CHANGED, {
              previousVersion: lastKnownVersion,
              currentVersion,
              hasBackup: coreUpdateService.hasBackup(),
            });
          }
        } catch (versionCheckError) {
          logManager.addLog('warn', `版本检测失败: ${versionCheckError}`, 'Main');
        }

        // 检查是否启用了启动时自动连接
        if (config.autoConnect && config.selectedServerId) {
          logManager.addLog('info', '启动时自动连接已启用，正在连接...', 'Main');

          if (proxyManager) {
            await proxyManager.start(config);

            // 系统代理模式：设置系统代理
            const modeType = (config.proxyModeType || 'systemProxy').toLowerCase();
            if (modeType === 'systemproxy') {
              await systemProxyManager.enableProxy(
                '127.0.0.1',
                config.httpPort || 2080,
                config.socksPort || 2081
              );
            }

            logManager.addLog('info', '启动时自动连接成功', 'Main');
            // 更新托盘菜单状态
            updateTrayMenuState(true);
          }
        } else if (config.autoConnect && !config.selectedServerId) {
          logManager.addLog('warn', '启动时自动连接已启用，但未选择服务器', 'Main');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logManager.addLog('error', `启动时自动连接失败: ${errorMessage}`, 'Main');
        // 连接失败时更新托盘状态
        updateTrayMenuState(false, true);
      }
    }, 2000);

    // 启动后自动检查更新（延迟 5 秒，避免影响启动体验）
    setTimeout(async () => {
      try {
        const config = await configManager.loadConfig();
        // 检查是否启用了自动检查更新
        if (config.autoCheckUpdate !== false) {
          logManager.addLog('info', '正在自动检查更新...', 'Main');
          const result = await updateService.checkForUpdate();
          if (result.hasUpdate && result.updateInfo) {
            logManager.addLog('info', `发现新版本: ${result.updateInfo.version}`, 'Main');
            // 显示更新对话框
            const action = await updateService.showUpdateDialog(result.updateInfo);
            if (action === 'update') {
              // 使用带进度窗口的下载方法
              const filePath = await updateService.downloadUpdateWithProgress(result.updateInfo);
              if (filePath) {
                await updateService.installUpdate(filePath);
              }
            } else if (action === 'skip') {
              updateService.skipVersion(result.updateInfo.version);
            }
          } else if (result.error) {
            logManager.addLog('warn', `自动检查更新失败: ${result.error}`, 'Main');
          } else {
            logManager.addLog('info', '当前已经是最新版本', 'Main');
          }
        }
      } catch (error) {
        logManager.addLog('error', `自动检查更新异常: ${error}`, 'Main');
      }
    }, 5000);

    // 订阅自动更新由 SubscriptionScheduler 接管（启动补更 + 周期巡检 + 退避 + 不打断连接），
    // 取代旧的「启动后一次性 setTimeout 拉取」。详见 subscriptionScheduler.start() 调用处。

    // 监听配置变更事件，更新托盘菜单并自动重启代理
    mainEventEmitter.on(MAIN_EVENTS.CONFIG_CHANGED, async () => {
      // 1. 更新托盘菜单
      const isRunning = proxyManager?.getStatus().running ?? false;
      updateTrayMenuState(isRunning);

      // 2. 如果代理正在运行，应用新配置：仅切节点走 clash_api 热切换（不断流），其余重启（见 switchMode）
      if (isRunning && proxyManager) {
        try {
          // 重新加载配置以确保使用最新值
          const latestConfig = await configManager.loadConfig();
          await proxyManager.switchMode(latestConfig);
          logManager.addLog('info', 'Applied configuration change', 'Main');

          // 应用后再次更新托盘（以防状态有变）
          updateTrayMenuState(proxyManager.getStatus().running);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logManager.addLog('error', `Failed to apply config change: ${errorMessage}`, 'Main');
          // 应用失败，更新托盘状态为停止
          updateTrayMenuState(false, true);
        }
      }

      // 3. 同步自动换节点服务状态
      if (autoSwitchService) {
        const latestCfg = await configManager.loadConfig().catch(() => null);
        if (latestCfg?.autoSwitchNode) {
          autoSwitchService.enable();
        } else {
          autoSwitchService.disable();
        }
      }

      // 4. 应用「更新检查走代理」总开关（mainSessionViaProxy 切换时热生效；幂等）
      await applyMainSessionProxy();
    });

    // macOS/Linux 关机/重启早期钩子：powerMonitor 'shutdown'（win32 不发此事件，注销/关机走窗口级
    // 'session-end'，见 createWindow）。同步兜底：停代理 + marker 门控关系统代理（syncCleanupOnExit 内），
    // 防关机过快时 SIGTERM→cleanupResources 异步链跑不完导致 networksetup/gsettings 代理残留。
    if (process.platform === 'darwin' || process.platform === 'linux') {
      powerMonitor.on('shutdown', () => {
        logManager.addLog('warn', 'OS shutdown detected (powerMonitor), syncing cleanup', 'Main');
        syncCleanupOnExit();
      });
    }

    // Dock 点击 / Finder·Spotlight 重新打开运行中的 app（macOS 经 activate，非 second-instance）。
    // hasVisibleWindows=false 涵盖窗口隐藏/最小化/已销毁三态；showWindow 已分别处理（show / restore / 重建）。
    // 旧逻辑只判 getAllWindows().length===0，隐藏窗口仍计入 → 关窗后点 Dock 无反应（根因）。
    app.on('activate', (_event, hasVisibleWindows) => {
      if (!hasVisibleWindows) {
        void showWindow();
      }
    });
  });
}

// 退出意图标记：before-quit 早于逐窗口 close 触发，置位后 close 处理器放行销毁（见 createWindow），
// 使 app.quit() 不被 close 的 preventDefault 吞成"隐藏"、will-quit 清理得以执行（根因 A 修复，跨平台）。
let isQuitting = false;
// 清理 memoized promise：多入口（will-quit / SIGTERM / 托盘 app.quit）共享同一次清理。
// 用 promise 而非 boolean：并发的第二入口 await 同一进行中的清理，避免 process.exit 拦腰截断它。
let cleanupPromise: Promise<void> | null = null;
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (!gotTheLock) return;
  // 在 macOS 上，即使所有窗口关闭，应用也应该继续运行（托盘模式）
  // 在其他平台上，如果启用了托盘，也应该继续运行
  // 判「图标真实存在」而非对象引用：createTray 失败被静默吞时 trayManager 非 null 但无图标 →
  // 无窗口 + 无图标仍驻留 = 不可达僵尸。hasTray() 兜住此情形。
  if (process.platform !== 'darwin' && !trayManager?.hasTray()) {
    app.quit();
  }
});

// 使用 will-quit 事件来清理资源
app.on('will-quit', async (_event) => {
  if (!gotTheLock) return;
  // 阻止默认退出，先清理资源
  _event.preventDefault();

  try {
    // 清理资源
    await cleanupResources();

    // 清理托盘图标
    if (trayManager) {
      trayManager.destroyTray();
      trayManager = null;
    }

    // 现在可以安全退出了
    app.exit(0);
  } catch (error) {
    console.error('Error during app quit:', error);
    // 即使清理失败，也要退出
    app.exit(1);
  }
});

// 处理 SIGINT 和 SIGTERM 信号
process.on('SIGINT', async () => {
  console.log('Received SIGINT, cleaning up...');
  await cleanupResources();
  trayManager?.destroyTray(); // 信号退出也显式销毁托盘，与 will-quit 一致（幂等）
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, cleaning up...');
  await cleanupResources();
  trayManager?.destroyTray();
  process.exit(0);
});

// 系统关机/注销 / 进程退出的同步兜底：停代理(fire-and-forget) + 同步关系统代理，防重启后代理残留。
function syncCleanupOnExit(): void {
  if (proxyManager) {
    // 必须传 quitting：否则 stop() 的同步前缀会一路同步拉起 Windows RunAs taskkill 的 UAC 弹框
    // （即便 fire-and-forget / process.exit 语境），违反"退出零弹框"不变量、可能在 app 死后冒孤儿 UAC。
    proxyManager.stop({ quitting: true }).catch(() => {});
  }
  // marker 门控：仅当 marker 存在（FlowZ 设置过系统代理且尚未拆除）才同步强关，
  // 防每次退出无条件 stomp 用户自配/第三方系统代理（设计 通用-E）。
  // 正常退出链 cleanupResources→disableProxy 已删 marker → 此处自然跳过，不重复操作。
  if (!SystemProxyBase.readMarker()) return;
  try {
    const { createSystemProxyManager } = require('./services/SystemProxyManager');
    const sysProxy = createSystemProxyManager();
    sysProxy.disableProxySync();
  } catch {
    /* ignore */
  }
}

// 修复：旧版把关机/注销清理挂在 `app.on('session-end')` —— 但 session-end 是 BrowserWindow 的 win32 事件，
// App 从不发它（死代码 → Windows 注销/关机后系统代理残留、重启断网）。已改挂窗口级（见 createWindow 内 'session-end'）。
// macOS/Linux 关机由 launchd/systemd 发 SIGTERM → SIGTERM handler → cleanupResources 覆盖；
// 另有 powerMonitor 'shutdown' 更早钩子（whenReady 末尾注册）。process'exit'/session-end/shutdown
// 三入口统一经 syncCleanupOnExit 的 marker 门控（通用-E），仅 FlowZ 自己设置的系统代理才被强关。

// 进程退出时的最后兜底（同步执行）
process.on('exit', () => {
  if (!gotTheLock) return;
  syncCleanupOnExit();
});
