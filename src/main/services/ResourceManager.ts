import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * 资源文件管理器
 * 根据平台和架构返回对应的资源文件路径
 */
export class ResourceManager {
  private _isDev?: boolean;
  private readonly platform: string;
  private readonly arch: string;

  constructor() {
    this.platform = process.platform;
    this.arch = process.arch;
  }

  private get isDev(): boolean {
    if (this._isDev === undefined) {
      // Use optional chaining just in case app is undefined during an early evaluation
      this._isDev = !(app?.isPackaged ?? true);
    }
    return this._isDev;
  }

  /**
   * 获取 sing-box 可执行文件路径
   */
  getSingBoxPath(): string {
    // Windows 平台需要 .exe 扩展名
    const filename = this.platform === 'win32' ? 'sing-box.exe' : 'sing-box';

    // Windows Portable 模式特殊处理：优先使用 userData 下的核心
    if (this.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) {
      const fs = require('fs');
      const portableCorePath = path.join(app.getPath('userData'), 'core_update', filename);
      if (fs.existsSync(portableCorePath)) {
        return portableCorePath;
      }
    }

    // Linux 模式特殊处理：优先使用 userData 下的核心，以便支持 setcap 和规避 AppImage EROFS
    if (this.platform === 'linux') {
      const fs = require('fs');
      const linuxCorePath = path.join(app.getPath('userData'), 'core_update', filename);
      if (fs.existsSync(linuxCorePath)) {
        return linuxCorePath;
      }
    }

    const platformDir = this.getPlatformResourceDir();
    const singboxPath = path.join(platformDir, filename);

    return singboxPath;
  }

  /**
   * 获取核心更新时的目标写入路径
   * 专为解决 Portable 版本每次启动清空临时目录导致更新失效的问题
   */
  getSingBoxUpdateTargetPath(): string {
    const filename = this.platform === 'win32' ? 'sing-box.exe' : 'sing-box';

    // Windows Portable 模式特殊处理：更新文件必须写入 userData 才能持久化
    if (this.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) {
      return path.join(app.getPath('userData'), 'core_update', filename);
    }

    // Linux 下特殊处理：AppImage 是只读文件系统 (EROFS)，更新核心必须写入 userData
    if (this.platform === 'linux') {
      return path.join(app.getPath('userData'), 'core_update', filename);
    }

    return this.getSingBoxPath();
  }

  /**
   * 获取应用图标路径（统一使用 app.png）
   */
  getAppIconPath(): string {
    if (this.isDev) {
      return path.join(process.cwd(), 'resources', 'app.png');
    }
    // 生产环境：app.png 在 process.resourcesPath 根目录
    return path.join(process.resourcesPath, 'app.png');
  }

  /**
   * 获取托盘图标路径
   * @param connected 是否已连接，true 返回彩色图标，false 返回灰色图标
   */
  getTrayIconPath(connected: boolean = false): string {
    const filename = connected ? 'app.png' : 'app-gray.png';
    if (this.isDev) {
      return path.join(process.cwd(), 'resources', filename);
    }
    return path.join(process.resourcesPath, filename);
  }

  /**
   * 获取 GeoIP 数据文件路径
   */
  getGeoIPPath(): string {
    const dataDir = this.getDataResourceDir();
    return path.join(dataDir, 'geoip-cn.srs');
  }

  /**
   * 获取 GeoSite 中国数据文件路径
   */
  getGeoSiteCNPath(): string {
    const dataDir = this.getDataResourceDir();
    return path.join(dataDir, 'geosite-cn.srs');
  }

  /**
   * 获取 GeoSite 非中国数据文件路径
   */
  getGeoSiteNonCNPath(): string {
    const dataDir = this.getDataResourceDir();
    return path.join(dataDir, 'geosite-geolocation-!cn.srs');
  }

  /**
   * 检查资源文件是否存在
   */
  async checkResourcesExist(): Promise<{ exists: boolean; missing: string[] }> {
    const missing: string[] = [];

    // 检查 sing-box 可执行文件
    const singboxPath = this.getSingBoxPath();
    if (!(await this.fileExists(singboxPath))) {
      missing.push(`sing-box executable: ${singboxPath}`);
    }

    // 检查 GeoIP/GeoSite 数据文件
    const geoFiles = [
      { name: 'GeoIP CN', path: this.getGeoIPPath() },
      { name: 'GeoSite CN', path: this.getGeoSiteCNPath() },
      { name: 'GeoSite Non-CN', path: this.getGeoSiteNonCNPath() },
    ];

    for (const file of geoFiles) {
      if (!(await this.fileExists(file.path))) {
        missing.push(`${file.name}: ${file.path}`);
      }
    }

    return {
      exists: missing.length === 0,
      missing,
    };
  }

  /**
   * 获取平台特定的资源目录
   */
  private getPlatformResourceDir(): string {
    const baseDir = this.getResourcesBaseDir();

    if (this.platform === 'win32') {
      return path.join(baseDir, 'win');
    } else if (this.platform === 'darwin') {
      if (this.isDev) {
        // 开发环境：根据架构选择不同的目录
        if (this.arch === 'arm64') {
          return path.join(baseDir, 'mac-arm64');
        } else {
          return path.join(baseDir, 'mac-x64');
        }
      } else {
        // 生产环境：打包后统一使用 mac 目录
        return path.join(baseDir, 'mac');
      }
    } else if (this.platform === 'linux') {
      if (this.isDev) {
        // 开发环境：优先根据架构选择目录，如果找不到则回退到 linux 目录
        const fs = require('fs');
        const archDir = this.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
        const fullArchDirPath = path.join(baseDir, archDir);

        if (fs.existsSync(fullArchDirPath)) {
          return fullArchDirPath;
        }
        return path.join(baseDir, 'linux');
      } else {
        // 生产环境：打包后统一使用 linux 目录
        return path.join(baseDir, 'linux');
      }
    }

    throw new Error(`Unsupported platform: ${this.platform}`);
  }

  /**
   * 获取数据文件目录
   */
  private getDataResourceDir(): string {
    const baseDir = this.getResourcesBaseDir();
    return path.join(baseDir, 'data');
  }

  /**
   * 获取资源文件基础目录
   * 开发环境和生产环境路径不同
   */
  private getResourcesBaseDir(): string {
    if (this.isDev) {
      // 开发环境：项目根目录下的 resources
      return path.join(process.cwd(), 'resources');
    } else {
      // 生产环境：打包后的 resources 目录
      // process.resourcesPath 指向 app.asar 所在的 resources 目录
      // extraResources 直接复制到 process.resourcesPath 下
      return process.resourcesPath;
    }
  }

  /**
   * 检查文件是否存在
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 确保 Linux 下使用用户目录的可写核心，以解决 AppImage (EROFS) 的权限和更新问题
   */
  async ensureWritableCore(): Promise<string> {
    if (this.platform !== 'linux') {
      return this.getSingBoxPath();
    }

    const userDataPath = app.getPath('userData');
    const updateDir = path.join(userDataPath, 'core_update');
    const targetPath = path.join(updateDir, 'sing-box');

    // 检查是否已经有可写核心
    if (await this.fileExists(targetPath)) {
      // 已有可写核心：仍需确保 libcronet 在旁（naive 出站靠 purego 同目录/系统库路径加载）
      await this.ensureCronetBeside(updateDir);
      return targetPath;
    }

    // 创建目录
    await fs.mkdir(updateDir, { recursive: true });

    // 从应用内置的包中复制
    const platformDir = this.getPlatformResourceDir();
    const sourcePath = path.join(platformDir, 'sing-box');

    if (await this.fileExists(sourcePath)) {
      await fs.copyFile(sourcePath, targetPath);
      await fs.chmod(targetPath, 0o755); // 赋予可执行权限
    }

    // naive 节点需要 libcronet 与 sing-box 同目录（purego 加载），随核心一并放过去
    await this.ensureCronetBeside(updateDir);

    return targetPath;
  }

  /** 各平台 NaiveProxy 核心库文件名（purego 期望的名字） */
  getCronetLibFilename(): string {
    if (this.platform === 'win32') return 'libcronet.dll';
    if (this.platform === 'darwin') return 'libcronet.dylib';
    return 'libcronet.so';
  }

  /** 内置的 libcronet 是否存在（用于 naive 可用性判断） */
  hasCronetLib(): boolean {
    try {
      return require('fs').existsSync(
        path.join(this.getPlatformResourceDir(), this.getCronetLibFilename())
      );
    } catch {
      return false;
    }
  }

  /**
   * 把内置的 libcronet 复制到与（可写/已更新）核心同一目录，供 naive 出站(purego) 加载。
   * 供 ensureWritableCore 与核心更新写盘后调用。内置无 libcronet 或已存在则跳过。
   */
  async ensureCronetBeside(coreDir: string): Promise<void> {
    const name = this.getCronetLibFilename();
    const src = path.join(this.getPlatformResourceDir(), name);
    const dst = path.join(coreDir, name);
    try {
      if ((await this.fileExists(src)) && !(await this.fileExists(dst))) {
        await fs.copyFile(src, dst);
      }
    } catch {
      // 复制失败不应阻断启动；naive 不可用时 sing-box 会自报 cronet 错误
    }
  }

  /**
   * 获取资源信息（用于调试）
   */
  getResourceInfo(): {
    isDev: boolean;
    platform: string;
    arch: string;
    baseDir: string;
    singboxPath: string;
    geoIPPath: string;
    geoSiteCNPath: string;
    geoSiteNonCNPath: string;
  } {
    return {
      isDev: this.isDev,
      platform: this.platform,
      arch: this.arch,
      baseDir: this.getResourcesBaseDir(),
      singboxPath: this.getSingBoxPath(),
      geoIPPath: this.getGeoIPPath(),
      geoSiteCNPath: this.getGeoSiteCNPath(),
      geoSiteNonCNPath: this.getGeoSiteNonCNPath(),
    };
  }
}

// 导出单例实例
export const resourceManager = new ResourceManager();
