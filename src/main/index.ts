import { app, BrowserWindow, dialog, Menu } from 'electron';
import * as path from 'path';
import { ConfigManager } from './services/ConfigManager';
import { ProtocolParser } from './services/ProtocolParser';
import { LogManager } from './services/LogManager';
import { TrayManager } from './services/TrayManager';
import { ProxyManager } from './services/ProxyManager';
import { createSystemProxyManager } from './services/SystemProxyManager';
import { resourceManager } from './services/ResourceManager';
import { SubscriptionService } from './services/SubscriptionService';
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
} from './ipc/handlers';
import { createAutoStartManager } from './services/AutoStartManager';
import { UpdateService } from './services/UpdateService';
import { CoreUpdateService } from './services/CoreUpdateService';
import { SpeedTestService } from './services/SpeedTestService';
import { AutoSwitchService } from './services/AutoSwitchService';
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
let inactivityTimer: NodeJS.Timeout | null = null;

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

// 10 分钟无操作自动进入轻量模式
const INACTIVITY_TIMEOUT = 10 * 60 * 1000;

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
async function showWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  } else {
    await createWindow();
  }
}

async function createWindow() {
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

  // 读取保存的窗口尺寸（如果启用了记忆窗口大小）
  let windowWidth = 1200;
  let windowHeight = 800;
  try {
    const cfg = await configManager.loadConfig();
    if (cfg.rememberWindowSize && cfg.windowBounds) {
      windowWidth = cfg.windowBounds.width;
      windowHeight = cfg.windowBounds.height;
    }
  } catch {
    // 使用默认尺寸
  }

  // 创建主窗口
  // 注意：transparent 仅在 macOS 上启用，Windows/Linux 上启用会导致
  // 侧边栏透明且鼠标事件无法正常传递（Electron 已知问题）
  const cfg = await configManager.loadConfig();
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
    nativeTheme.on('updated', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const isDark = nativeTheme.shouldUseDarkColors;
        mainWindow.setBackgroundColor(isDark ? '#121217' : '#f1f5f9');
      }
    });
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
    try {
      const cfg = await configManager.loadConfig();
      const isHiddenArg = process.argv.includes('--hidden');
      const isMacHidden =
        process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden;

      if (!cfg.silentStart && !isHiddenArg && !isMacHidden) {
        mainWindow?.show();
        logManager.addLog('info', 'Main window shown', 'Main');
      } else {
        logManager.addLog('info', 'Main window kept hidden (Silent Start)', 'Main');
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

  let privacyTimer: NodeJS.Timeout | null = null;

  const startInactivityTimers = async () => {
    try {
      const config = await configManager.loadConfig();
      if (config.autoLightweightMode) {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          logManager.addLog(
            'info',
            'Inactivity timeout reached, entering lightweight mode',
            'Main'
          );
          if (trayManager) {
            trayManager.enterLightweightMode();
            // TrayManager.enterLightweightMode 内部已包含 GC + 日志清理
          }
          inactivityTimer = null;
        }, INACTIVITY_TIMEOUT);
      }

      if (config.autoPrivacyMode) {
        if (privacyTimer) clearTimeout(privacyTimer);
        // 10 minutes timeout for privacy mode
        privacyTimer = setTimeout(
          () => {
            logManager.addLog('info', 'Inactivity timeout reached, entering privacy mode', 'Main');
            if (mainWindow) {
              setPrivacyMode(true);
            }
            privacyTimer = null;
          },
          10 * 60 * 1000
        );
      }
    } catch {
      // ignore
    }
  };

  // 当窗口失去焦点或隐藏时启动计时器，获取焦点或显示时取消计时器
  mainWindow.on('blur', startInactivityTimers);
  mainWindow.on('hide', startInactivityTimers);

  mainWindow.on('focus', () => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    if (privacyTimer) {
      clearTimeout(privacyTimer);
      privacyTimer = null;
    }
  });

  // 处理窗口关闭事件
  // 注意：必须同步调用 preventDefault()，否则窗口会直接销毁。
  // 任何 await 操作都应该在此之后。
  mainWindow.on('close', (event) => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;

    // 默认先阻止关闭
    event.preventDefault();

    // 异步获取配置并决定是隐藏还是真正销毁
    configManager
      .loadConfig()
      .then((config) => {
        if (window.isDestroyed()) return;

        if (config.minimizeToTray) {
          window.hide();
          logManager.addLog('info', 'Window hidden to tray', 'Main');
        } else {
          // 允许窗口销毁，不再 preventDefault
          // 既然已经调用过 preventDefault，我们需要手动调用 destroy
          logManager.addLog('info', 'Window destroying, app will quit', 'Main');
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
    logManager.addLog('info', 'Main window closed', 'Main');
  });
}

/**
 * 清理应用资源
 * 在应用退出前调用，确保清理系统代理和终止进程
 */
async function cleanupResources(): Promise<void> {
  logManager.addLog('info', 'Cleaning up resources before exit...', 'Main');

  try {
    // 1. 停止代理进程
    if (proxyManager) {
      const status = proxyManager.getStatus();
      if (status.running) {
        logManager.addLog('info', 'Stopping proxy process...', 'Main');
        await proxyManager.stop();
        logManager.addLog('info', 'Proxy process stopped', 'Main');
      }
    }

    // 2. 清理系统代理设置
    try {
      const proxyStatus = await systemProxyManager.getProxyStatus();
      if (proxyStatus.enabled) {
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
      selectedServerId: config.selectedServerId,
      proxyMode: config.proxyMode,
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

    // macOS: 禁用 App Nap，防止系统认为应用"没有响应"
    // 当应用在后台运行代理时，App Nap 会导致系统误判应用状态
    if (process.platform === 'darwin') {
      const { powerSaveBlocker } = require('electron');
      powerSaveBlocker.start('prevent-app-suspension');
    }

    // 设置 macOS Dock 图标
    if (process.platform === 'darwin' && app.dock) {
      const iconPath = resourceManager.getAppIconPath();
      const fs = require('fs');
      if (fs.existsSync(iconPath)) {
        const { nativeImage } = require('electron');
        const icon = nativeImage.createFromPath(iconPath);
        // 调整为标准 Dock 图标尺寸
        const resizedIcon = icon.resize({ width: 128, height: 128 });
        app.dock.setIcon(resizedIcon);
      }
    }

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

    await createWindow();

    // 初始化 ProxyManager（需要在窗口创建后）
    proxyManager = new ProxyManager(logManager, mainWindow || undefined);
    coreUpdateService.setProxyManager(proxyManager);

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

    // 监听代理管理器事件，更新托盘状态
    proxyManager.on('error', async (error: Error) => {
      logManager.addLog('error', `Proxy error: ${error.message}`, 'Main');
      // 发生错误时，更新托盘显示为"连接异常"
      updateTrayMenuState(false, true);

      // 触发自动换节点（如果已启用）
      if (autoSwitchService) {
        autoSwitchService.onProxyError(error.message).catch((e) => {
          logManager.addLog('warn', `自动换节点处理异常: ${e}`, 'Main');
        });
      }

      // 进程意外退出时，清理系统代理设置，避免网络不可用
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
    });

    proxyManager.on('started', async () => {
      try {
        await coreUpdateService.recordSuccessfulVersion();
        logManager.addLog('info', '已记录当前运行的内核版本基线', 'Main');
      } catch (e) {
        logManager.addLog('warn', `记录内核基线版本失败: ${e}`, 'Main');
      }

      try {
        const config = await configManager.loadConfig();
        const proxyUrl = `http://127.0.0.1:${config.httpPort || 2080}`;
        const { session } = require('electron');
        await session.defaultSession.setProxy({
          proxyRules: proxyUrl,
          proxyBypassRules: '127.0.0.1,localhost,::1',
        });
        logManager.addLog(
          'info',
          `已强制 Electron 主进程(更新检查/测速)走代理: ${proxyUrl}`,
          'Main'
        );
      } catch (err) {
        logManager.addLog('warn', `设置 Electron 主进程代理失败: ${err}`, 'Main');
      }
    });

    proxyManager.on('stopped', async () => {
      try {
        const { session } = require('electron');
        await session.defaultSession.setProxy({});
        logManager.addLog('info', '已恢复 Electron 主进程直连状态', 'Main');
      } catch {
        /* ignore */
      }

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
    registerServerHandlers(protocolParser, configManager);
    registerLogHandlers(logManager, proxyManager);
    registerProxyHandlers(proxyManager, systemProxyManager);
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

    // 同步自启动状态
    const autoStartManager = createAutoStartManager();
    const config = await configManager.loadConfig();
    await autoStartManager.setAutoStart(config.autoStart ?? false);

    // 注册更新处理器
    setUpdateService(updateService);
    updateService.setMainWindow(mainWindow);
    // 设置更新前的清理回调，确保在安装更新前停止代理进程
    updateService.setCleanupCallback(cleanupResources);
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
      if (trayManager) {
        trayManager.setLanguage(lang);
      }
    });

    // 创建托盘图标
    trayManager = new TrayManager(mainWindow, logManager, {
      onStartProxy: async () => {
        try {
          const config = await configManager.loadConfig();
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
      onQuit: async () => {
        // 清理资源后退出
        await cleanupResources();
        app.exit(0);
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
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('event:enterPrivacyMode');
        }
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

    // 启动后自动更新订阅（延迟 8 秒，避免干扰启动）
    setTimeout(async () => {
      try {
        const config = await configManager.loadConfig();
        if (config.autoUpdateSubscriptionOnStart) {
          logManager.addLog('info', '启动时自动更新订阅已启用，正在更新...', 'Main');

          if (!config.subscriptions || config.subscriptions.length === 0) {
            logManager.addLog('info', '没有可更新的订阅', 'Main');
            return;
          }

          let updatedCount = 0;
          let failedCount = 0;

          for (const subscription of config.subscriptions) {
            if (!subscription.autoUpdate) continue;
            try {
              const result = await subscriptionService.fetchSubscription(
                subscription.url,
                subscription.id
              );
              const fetchedServers = result.servers;

              const oldServers = config.servers.filter((s) => s.subscriptionId === subscription.id);
              const oldServersMap = new Map<string, (typeof config.servers)[0]>();
              oldServers.forEach((s) => {
                oldServersMap.set(`${s.name}-${s.protocol}-${s.address}-${s.port}`, s);
              });

              const newServersToKeep = [];
              for (const newServer of fetchedServers) {
                const key = `${newServer.name}-${newServer.protocol}-${newServer.address}-${newServer.port}`;
                if (oldServersMap.has(key)) {
                  const old = oldServersMap.get(key)!;
                  newServersToKeep.push({
                    ...newServer,
                    id: old.id,
                    createdAt: old.createdAt,
                    updatedAt: new Date().toISOString(),
                  });
                  oldServersMap.delete(key);
                } else {
                  newServersToKeep.push(newServer);
                }
              }

              const deletedIds = new Set(Array.from(oldServersMap.values()).map((s) => s.id));
              if (config.selectedServerId && deletedIds.has(config.selectedServerId)) {
                config.selectedServerId = null;
              }

              const otherServers = config.servers.filter(
                (s) => s.subscriptionId !== subscription.id
              );
              config.servers = [...otherServers, ...newServersToKeep];
              subscription.lastUpdated = new Date().toISOString();
              if (result.userInfo) subscription.userInfo = result.userInfo;

              updatedCount++;
            } catch (e: any) {
              logManager.addLog(
                'warn',
                `更新订阅 [${subscription.name}] 失败: ${e.message}`,
                'Main'
              );
              failedCount++;
            }
          }

          await configManager.saveConfig(config);
          logManager.addLog(
            'info',
            `启动时自动更新订阅完成。成功：${updatedCount}，失败：${failedCount}`,
            'Main'
          );

          // 广播配置变更事件以更新 UI
          ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
        }
      } catch (error) {
        logManager.addLog('error', `启动时自动更新订阅异常: ${error}`, 'Main');
      }
    }, 8000);

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
    });

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (!gotTheLock) return;
  // 在 macOS 上，即使所有窗口关闭，应用也应该继续运行（托盘模式）
  // 在其他平台上，如果启用了托盘，也应该继续运行
  if (process.platform !== 'darwin' && !trayManager) {
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
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, cleaning up...');
  await cleanupResources();
  process.exit(0);
});

// 核心兜底修复：系统关机/注销时的同步清理
// 解决 Windows 下系统代理在重启后依然残留的问题
(app as any).on('session-end', () => {
  if (!gotTheLock) return;
  console.log('Detected OS session-end, executing synchronous cleanup...');
  if (proxyManager) {
    proxyManager.stop().catch(() => {});
  }
  try {
    const { createSystemProxyManager } = require('./services/SystemProxyManager');
    const sysProxy = createSystemProxyManager();
    sysProxy.disableProxySync();
  } catch {
    /* ignore */
  }
});

// 进程退出时的最后兜底（同步执行）
process.on('exit', () => {
  if (!gotTheLock) return;
  try {
    const { createSystemProxyManager } = require('./services/SystemProxyManager');
    const sysProxy = createSystemProxyManager();
    sysProxy.disableProxySync();
  } catch {
    /* ignore */
  }
});
