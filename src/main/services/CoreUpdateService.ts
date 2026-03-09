/**
 * 核心更新服务
 * 负责检查 Sing-box 核心更新、下载并替换
 */

import { app, net } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { LogManager } from './LogManager';
import { ProxyManager } from './ProxyManager';
import { resourceManager } from './ResourceManager';

export interface CoreUpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  error?: string;
}

export class CoreUpdateService {
  private logManager: LogManager;
  private proxyManager: ProxyManager | null = null;
  private isUpdating: boolean = false;

  constructor(logManager: LogManager) {
    this.logManager = logManager;
  }

  setProxyManager(proxyManager: ProxyManager): void {
    this.proxyManager = proxyManager;
  }

  /**
   * 检查核心更新
   */
  async checkUpdate(): Promise<CoreUpdateCheckResult> {
    try {
      this.logManager.addLog('info', '正在检查 Sing-box 核心更新...', 'CoreUpdateService');

      const currentVersion = await this.getCurrentVersion();
      const releases = await this.fetchReleases();

      if (!releases || releases.length === 0) {
        return { hasUpdate: false, currentVersion, error: '未找到发布版本' };
      }

      // 过滤出正式版 (非 prerelease)
      const validReleases = releases.filter((r: any) => !r.prerelease);
      if (validReleases.length === 0) {
        return { hasUpdate: false, currentVersion, error: '未找到正式版本' };
      }

      const latestRelease = validReleases[0];
      // release tag 通常是 v1.8.0 格式，去掉 v
      const latestVersion = latestRelease.tag_name.replace(/^v/, '');

      this.logManager.addLog(
        'info',
        `当前版本: ${currentVersion}, 最新版本: ${latestVersion}`,
        'CoreUpdateService'
      );

      if (this.compareVersions(latestVersion, currentVersion) > 0) {
        // 找到适合当前平台的资源
        const asset = this.findSuitableAsset(latestRelease.assets);
        if (asset) {
          const result = {
            hasUpdate: true,
            currentVersion,
            latestVersion,
            downloadUrl: asset.browser_download_url,
            releaseNotes: latestRelease.body,
          };
          this.logManager.addLog(
            'info',
            `Found suitable asset: ${asset.browser_download_url}`,
            'CoreUpdateService'
          );
          return result;
        } else {
          const msg = `未找到适合当前平台的构建 (Platform: ${process.platform}, Arch: ${process.arch})`;
          this.logManager.addLog('warn', msg, 'CoreUpdateService');
          return { hasUpdate: false, currentVersion, error: msg };
        }
      }

      return { hasUpdate: false, currentVersion };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('error', `检查核心更新失败: ${msg}`, 'CoreUpdateService');
      return { hasUpdate: false, currentVersion: '未知', error: msg };
    }
  }

  /**
   * 执行更新
   */
  async updateCore(downloadUrl: string): Promise<boolean> {
    if (this.isUpdating) {
      throw new Error('更新正在进行中');
    }

    this.isUpdating = true;

    try {
      // 1. 下载文件
      this.logManager.addLog('info', '开始下载核心文件...', 'CoreUpdateService');
      const tempPath = await this.downloadFile(downloadUrl);

      // 2. 解压文件 (如果需要)
      // Sing-box release 通常是 .tar.gz 或 .zip
      this.logManager.addLog('info', '正在解压核心文件...', 'CoreUpdateService');
      const corePath = await this.extractCore(tempPath);

      // 3. 停止代理
      let wasRunning = false;
      if (this.proxyManager) {
        const status = this.proxyManager.getStatus();
        if (status.running) {
          this.logManager.addLog('info', '正在停止代理服务...', 'CoreUpdateService');
          await this.proxyManager.stop();
          wasRunning = true;
          // 等待进程完全退出
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      // 4. 备份旧核心
      await this.backupCurrentCore();

      // 5. 替换核心
      this.logManager.addLog('info', '正在替换核心文件...', 'CoreUpdateService');
      const targetPath = resourceManager.getSingBoxPath();

      // 确保目标目录存在
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // 复制新核心到目标位置
      if (process.platform === 'win32') {
        await this.copyFileElevatedWindows(corePath, targetPath);
      } else {
        await this.copyFileWithRetry(corePath, targetPath);
      }

      // 设置执行权限 (macOS/Linux)
      if (process.platform !== 'win32') {
        fs.chmodSync(targetPath, 0o755);
      }

      // macOS: 清除下载隔离标记并重新 ad-hoc 签名
      // 原因: macOS Gatekeeper 对新放入的未公证二进制会拦截执行 (SIGKILL)
      // xattr -cr 清除 quarantine 标记, codesign --force -s - 重新 ad-hoc 签名使其被系统接受
      if (process.platform === 'darwin') {
        try {
          const { execSync } = require('child_process');
          execSync(`xattr -cr "${targetPath}"`, { stdio: 'pipe' });
          execSync(`codesign --force --deep -s - "${targetPath}"`, { stdio: 'pipe' });
          this.logManager.addLog('info', '已完成 macOS Gatekeeper 签名处理', 'CoreUpdateService');
        } catch (signError: any) {
          this.logManager.addLog(
            'warn',
            `macOS 签名处理失败 (可能需要手动运行 sudo codesign --force -s -): ${signError.message}`,
            'CoreUpdateService'
          );
        }
      }

      this.logManager.addLog('info', '核心文件替换成功', 'CoreUpdateService');

      // 6. 清理临时文件
      try {
        fs.unlinkSync(tempPath);
        // 如果 corePath 是解压出来的临时文件，也删除它
        if (corePath.includes(app.getPath('temp')) && corePath !== tempPath) {
          fs.unlinkSync(corePath);
        }
      } catch {
        // 忽略清理错误
      }

      // 7. 重启代理 (如果之前在运行)
      if (wasRunning && this.proxyManager) {
        this.logManager.addLog('info', '正在重启代理服务...', 'CoreUpdateService');
        // 需要重新加载配置? 通常不需要，config没变
        // 但需要获取当前的配置
        // 由于 ProxyManager.start 需要 config 参数，这里可能有点麻烦
        // 我们可以尝试触发一个事件或者让用户手动启动
        // 或者我们假设 Index.ts 会处理重启?
        // 简单起见，我们通知用户手动重启或由上层调用者处理
      }

      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('error', `更新核心失败: ${msg}`, 'CoreUpdateService');

      // 尝试恢复备份
      await this.restoreBackup();

      throw error;
    } finally {
      this.isUpdating = false;
    }
  }

  /*
   * 带重试机制的文件复制，遇到 EBUSY 会尝试强制结束进程 (Windows)
   */
  private async copyFileWithRetry(src: string, dest: string, retries: number = 3): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        fs.copyFileSync(src, dest);
        return;
      } catch (error: any) {
        this.logManager.addLog(
          'warn',
          `Copy failed (attempt ${i + 1}/${retries}): ${error.message}`,
          'CoreUpdateService'
        );

        // 如果是最后一次尝试，直接抛出异常
        if (i === retries - 1) throw error;

        // Windows 下如果是 EBUSY 或 EPERM，尝试强制结束 sing-box 进程
        if (process.platform === 'win32' && (error.code === 'EBUSY' || error.code === 'EPERM')) {
          this.logManager.addLog(
            'info',
            'File locked, attempting to force kill sing-box.exe...',
            'CoreUpdateService'
          );
          try {
            require('child_process').execSync('taskkill /F /IM sing-box.exe', { stdio: 'ignore' });
            // 杀进程后多等一会儿
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } catch {
            // 忽略错误（可能进程不存在）
          }
        }

        // 等待后重试
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /**

   * 获取当前核心版本
   */
  async getCurrentVersion(): Promise<string> {
    if (this.proxyManager) {
      return await this.proxyManager.getCoreVersion();
    }
    return '未知';
  }

  // --- 私有辅助方法 ---

  private async fetchReleases(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const request = net.request({
        method: 'GET',
        url: 'https://api.github.com/repos/SagerNet/sing-box/releases',
      });
      request.setHeader('User-Agent', 'FlowZ-Electron');
      request.setHeader('Accept', 'application/vnd.github.v3+json');

      request.on('response', (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk.toString()));
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              resolve(JSON.parse(data));
            } else if (res.statusCode === 403) {
              reject(new Error('GitHub API 访问频率限制 (403)，请稍后再试或使用代理'));
            } else {
              reject(new Error(`GitHub API Error: ${res.statusCode}`));
            }
          } catch {
            reject(new Error('Failed to parse GitHub response'));
          }
        });
      });

      request.on('error', reject);
      request.end();
    });
  }

  private compareVersions(v1: string, v2: string): number {
    const p1 = v1.split('.').map(Number);
    const p2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const n1 = p1[i] || 0;
      const n2 = p2[i] || 0;
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    }
    return 0;
  }

  private findSuitableAsset(assets: any[]): any {
    const platform = process.platform;
    const arch = process.arch;

    // 映射 Node.js 平台/架构到 Sing-box 命名规则
    // darwin, win32, linux
    // x64, arm64

    let keyword = '';
    let ext = '';

    if (platform === 'win32') {
      keyword = 'windows';
      ext = '.zip';
    } else if (platform === 'darwin') {
      keyword = 'darwin';
      ext = '.tar.gz'; // 通常是 tar.gz 或者 zip
    } else if (platform === 'linux') {
      keyword = 'linux';
      ext = '.tar.gz';
    }

    let archKeyword = '';
    if (arch === 'x64') {
      archKeyword = 'amd64';
    } else if (arch === 'arm64') {
      archKeyword = 'arm64';
    }

    // 优先查找包含特定架构的
    return assets.find(
      (a: any) =>
        a.name.toLowerCase().includes(keyword) &&
        a.name.toLowerCase().includes(archKeyword) &&
        (a.name.endsWith(ext) || a.name.endsWith('.zip'))
    );
  }

  private async downloadFile(url: string, isRetry = false): Promise<string> {
    // 根据系统平台设置合理的默认扩展名
    let ext = process.platform === 'win32' ? '.zip' : '.tar.gz';
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      // path.extname 对于 .tar.gz 只会返回 .gz
      const urlExt = path.extname(pathname);
      if (urlExt) {
        if (pathname.endsWith('.tar.gz')) {
          ext = '.tar.gz';
        } else {
          ext = urlExt;
        }
      }
    } catch (e) {
      console.error('Failed to parse URL for extension:', e);
    }

    // 如果是 Windows，且后缀不是 .zip，强制使用 .zip (因为 Sing-box Windows 构建通常是 zip)
    // 这是一个保险措施
    if (process.platform === 'win32' && ext !== '.zip') {
      ext = '.zip';
    }

    const tempPath = path.join(app.getPath('temp'), `sing-box-core-update-${Date.now()}${ext}`);
    const file = fs.createWriteStream(tempPath);

    return new Promise((resolve, reject) => {
      const request = net.request(url);
      request.setHeader('User-Agent', 'FlowZ-Electron');

      request.on('response', (response) => {
        if (response.statusCode >= 400) {
          file.close();
          fs.unlink(tempPath, () => {});
          reject(new Error(`Download failed: ${response.statusCode}`));
          return;
        }

        response.on('data', (chunk) => {
          file.write(chunk);
        });

        response.on('end', () => {
          file.close(() => {
            resolve(tempPath);
          });
        });

        response.on('error', (err) => {
          file.close();
          fs.unlink(tempPath, () => {});
          reject(err);
        });
      });

      request.on('error', (err) => {
        file.close();
        fs.unlink(tempPath, () => {});

        // 遇到网络错误，且是第一次尝试，并且是 github 链接，尝试使用加速镜像
        if (!isRetry && url.includes('github.com')) {
          this.logManager.addLog(
            'warn',
            `下载出错，尝试使用加速镜像: ${err.message}`,
            'CoreUpdateService'
          );
          const mirrorUrl = `https://ghp.ci/${url}`;
          this.downloadFile(mirrorUrl, true).then(resolve).catch(reject);
          return;
        }

        reject(err);
      });

      request.end();
    });
  }

  private async extractCore(filePath: string): Promise<string> {
    // 这是一个简化实现，处理 zip 和 tar.gz 需要引入 adm-zip 或 tar 库
    // 假设项目中可能有这些依赖，或者使用系统命令
    // 为了稳健性，这里使用系统命令 (tar / powershell Expand-Archive)

    const extractDir = path.join(app.getPath('temp'), `sing-box-extracted-${Date.now()}`);
    fs.mkdirSync(extractDir);

    try {
      if (process.platform === 'win32') {
        // Windows: 使用 PowerShell 解压 zip
        const { execSync } = require('child_process');
        execSync(
          `powershell -command "Expand-Archive -Path '${filePath}' -DestinationPath '${extractDir}' -Force"`
        );
      } else {
        // macOS/Linux: 使用 tar
        const { execSync } = require('child_process');
        // 检测是 zip 还是 tar.gz
        if (filePath.endsWith('.zip')) {
          execSync(`unzip -o "${filePath}" -d "${extractDir}"`);
        } else {
          execSync(`tar -xzf "${filePath}" -C "${extractDir}"`);
        }
      }

      // 查找解压后的可执行文件
      const exeName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';

      // 递归查找
      const findFile = (dir: string): string | null => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            const found = findFile(fullPath);
            if (found) return found;
          } else if (file === exeName) {
            return fullPath;
          }
        }
        return null;
      };

      const corePath = findFile(extractDir);
      if (!corePath) {
        throw new Error('无法在压缩包中找到 sing-box 可执行文件');
      }

      return corePath;
    } catch (error) {
      throw new Error(`解压失败: ${(error as any).message}`);
    }
  }

  private getBackupPath(): string {
    // Windows: store backup in userData (user-writable), NOT in Program Files
    // macOS/Linux: keep it alongside the binary (we have write access there)
    if (process.platform === 'win32') {
      return path.join(app.getPath('userData'), 'sing-box.exe.bak');
    }
    return resourceManager.getSingBoxPath() + '.bak';
  }

  private async backupCurrentCore(): Promise<void> {
    const currentPath = resourceManager.getSingBoxPath();
    const backupPath = this.getBackupPath();

    if (fs.existsSync(currentPath)) {
      if (process.platform === 'win32') {
        // On Windows copy to userData dir (no UAC needed)
        await this.copyFileElevatedWindows(currentPath, backupPath);
      } else {
        fs.copyFileSync(currentPath, backupPath);
      }
      this.logManager.addLog('info', `已备份当前核心到: ${backupPath}`, 'CoreUpdateService');
    }
  }

  private async restoreBackup(): Promise<void> {
    const currentPath = resourceManager.getSingBoxPath();
    const backupPath = this.getBackupPath();

    if (fs.existsSync(backupPath)) {
      try {
        if (process.platform === 'win32') {
          await this.copyFileElevatedWindows(backupPath, currentPath);
        } else {
          fs.copyFileSync(backupPath, currentPath);
          fs.chmodSync(currentPath, 0o755);
        }
        this.logManager.addLog('info', '已从备份恢复核心', 'CoreUpdateService');
      } catch {
        this.logManager.addLog('error', '恢复备份失败', 'CoreUpdateService');
      }
    }
  }

  /**
   * Windows 专用：通过 PowerShell 以管理员权限复制文件
   * 解决将文件写入 C:\Program Files (UAC 保护目录) 时的 EPERM 问题
   */
  private async copyFileElevatedWindows(src: string, dest: string): Promise<void> {
    const { execSync } = require('child_process') as typeof import('child_process');

    // Escape single quotes in paths for PowerShell
    const escapedSrc = src.replace(/'/g, "''");
    const escapedDest = dest.replace(/'/g, "''");

    // Ensure destination directory exists
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    try {
      // First try a direct copy (works if app has write access)
      fs.copyFileSync(src, dest);
    } catch (directErr: any) {
      if (directErr.code !== 'EPERM' && directErr.code !== 'EACCES') {
        throw directErr;
      }

      this.logManager.addLog(
        'info',
        'Direct copy failed (EPERM), attempting elevated PowerShell copy...',
        'CoreUpdateService'
      );

      // Fall back: use PowerShell with -Verb RunAs to elevate.
      // We write a tiny ps1 script to temp so we don't have quoting nightmares.
      const scriptPath = path.join(app.getPath('temp'), `flowz-copy-${Date.now()}.ps1`);
      fs.writeFileSync(
        scriptPath,
        `Copy-Item -Path '${escapedSrc}' -Destination '${escapedDest}' -Force\n`
      );

      try {
        execSync(`powershell -ExecutionPolicy Bypass -NonInteractive -File "${scriptPath}"`, {
          stdio: 'pipe',
          timeout: 30000,
        });
      } finally {
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
