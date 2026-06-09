/**
 * 核心更新服务
 * 负责检查 Sing-box 核心更新、下载并替换
 */

import { app, net, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { LogManager } from './LogManager';
import { ProxyManager } from './ProxyManager';
import { resourceManager } from './ResourceManager';

import type { UserConfig } from '../../shared/types';
import { encodeMajorMinor } from '../utils/version';

export interface CoreUpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  error?: string;
}

export interface CoreVersionInfo {
  currentVersion: string;
  backupVersion: string | null;
  hasBackup: boolean;
  lastKnownVersion: string | null;
}

/**
 * FlowZ 配置生成器已验证适配的 sing-box 版本带上限，编码为 major*1000+minor（1013 = 1.13）。
 * 跨越此版本带（如 1.14）可能因 sing-box 配置 schema 破坏性变更导致生成的配置无法解析；默认不
 * 自动跨带更新（可在设置关闭）。用整数编码比较，避免 parseFloat 把 "1.20" 误判为 1.2 < 1.13 而
 * 漏放跨带更新。sing-box 升级并验证配置生成兼容后，应调高此常量。
 */
const COMPATIBLE_CEILING = 1013;

export class CoreUpdateService {
  private logManager: LogManager;
  private proxyManager: ProxyManager | null = null;
  private isUpdating: boolean = false;
  // 更新后等待「首次成功运行」验证的新版本号；首启成功→清除并删备份，首启失败→自动回滚
  private pendingUpdateVersion: string | null = null;
  private pendingUpdateAt: number = 0; // 更新落盘时间戳，用于"待验证"过期保护（防陈旧 pending 误回滚）
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  // 兜底计时器：更新后若迟迟无 'started'/'error' 事件来解决待验证态（如更新时代理未运行、用户不重启），
  // 到期解除自动重启抑制，避免抑制闩永久挂起。
  private pendingFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private configProvider: (() => Promise<UserConfig>) | null = null;
  // 新核心首启成功后需"稳定运行"此时长（无 error）才删旧备份——防 'started'(仅1s存活) 假成功删掉回滚网。
  // 不变量：必须 > ProxyManager 健康检查间隔(10s)，否则 TUN 模式下崩溃在轮询检测到之前就被判稳定、误删备份。
  private static readonly STABILITY_DWELL_MS = 30000;
  // "待验证"最长有效期：超过则后续 error 视为与本次更新无关，不再触发回滚（防陈旧 pending 误回滚）
  private static readonly PENDING_MAX_AGE_MS = 5 * 60 * 1000;

  constructor(logManager: LogManager) {
    this.logManager = logManager;
  }

  setProxyManager(proxyManager: ProxyManager): void {
    this.proxyManager = proxyManager;
  }

  /** 注入配置读取器（用于读取"仅兼容版本带内更新"开关）。 */
  setConfigProvider(provider: () => Promise<UserConfig>): void {
    this.configProvider = provider;
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
        // 跳过曾预检/启动失败的问题版本（手动更新可绕过）
        if (this.isKnownBad(latestVersion)) {
          this.logManager.addLog(
            'info',
            `最新版本 ${latestVersion} 曾验证失败，已跳过自动更新`,
            'CoreUpdateService'
          );
          return {
            hasUpdate: false,
            currentVersion,
            latestVersion,
            error: `版本 ${latestVersion} 与当前配置不兼容（已跳过）；如需仍可手动更新`,
          };
        }

        // 版本带闸门：默认不自动跨越配置生成器已验证的版本带上限（防 schema 破坏导致无法解析）
        if (await this.isRestrictToCompatibleMinor()) {
          const latest = encodeMajorMinor(latestVersion);
          if (!isNaN(latest) && latest > COMPATIBLE_CEILING) {
            this.logManager.addLog(
              'info',
              `最新版本 ${latestVersion} 跨越兼容版本带(>1.13)，不自动更新`,
              'CoreUpdateService'
            );
            return {
              hasUpdate: false,
              currentVersion,
              latestVersion,
              error: `新版本 ${latestVersion} 跨越兼容版本带，建议随 App 升级（可在设置关闭"仅兼容版本带内更新"以手动尝试）`,
            };
          }
        }

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
    let backupMade = false;

    try {
      // 1. 下载文件
      this.logManager.addLog('info', '开始下载核心文件...', 'CoreUpdateService');
      const tempPath = await this.downloadFile(downloadUrl);

      // 2. 解压文件 (如果需要)
      // Sing-box release 通常是 .tar.gz 或 .zip
      this.logManager.addLog('info', '正在解压核心文件...', 'CoreUpdateService');
      const { corePath, extractDir: tempExtractDir } = await this.extractCore(tempPath);

      // 2.5 预检：新核心可执行 + 可解析当前配置。不通过则不动现役核心（代理继续运行，永不 brick）。
      const preflight = await this.preflightValidate(corePath);
      if (!preflight.ok) {
        if (preflight.version) this.markKnownBad(preflight.version);
        try {
          fs.unlinkSync(tempPath);
          if (tempExtractDir && fs.existsSync(tempExtractDir)) {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
          }
        } catch {
          /* ignore */
        }
        throw new Error(`核心更新预检失败，已放弃（现役核心继续运行）：${preflight.reason}`);
      }

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
      backupMade = true;

      // 5. 替换核心
      this.logManager.addLog('info', '正在替换核心文件...', 'CoreUpdateService');
      const targetPath = resourceManager.getSingBoxUpdateTargetPath();

      // 确保目标目录存在
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // 复制新核心及配套文件到目标位置
      const sourceDir = path.dirname(corePath);
      const files = fs.readdirSync(sourceDir);

      for (const file of files) {
        const srcFile = path.join(sourceDir, file);
        const destFile = path.join(targetDir, file);

        // 只复制文件，不复制目录
        if (fs.statSync(srcFile).isFile()) {
          this.logManager.addLog('info', `正在复制: ${file}`, 'CoreUpdateService');
          if (process.platform === 'win32') {
            await this.copyFileElevatedWindows(srcFile, destFile);
          } else {
            await this.copyFileWithRetry(srcFile, destFile);
          }
        }
      }

      // 设置执行权限 (macOS/Linux)
      if (process.platform !== 'win32') {
        fs.chmodSync(targetPath, 0o755);
      }

      // 核心单独更新后，确保 NaiveProxy 库 libcronet 与新核心同目录（官方 sing-box 包不含 libcronet，
      // naive 仍依赖随 app 打包的那个；purego 从核心同目录加载）。
      await resourceManager.ensureCronetBeside(targetDir);

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

      // naive 依赖随 app 打包的 libcronet（匹配出厂核心的 cronet-go 版本）。单独更新核心——尤其跨版本——
      // 可能与打包库 ABI 漂移；该漂移在 dlopen 前不可见，sing-box check 预检无法发现。有 naive 节点则提示。
      if (this.proxyManager?.hasNaiveNodes()) {
        this.logManager.addLog(
          'warn',
          'naive 节点依赖随 app 打包的 libcronet；本次核心更新后如遇 naive 不可用，请回滚核心或等待 app 整体更新',
          'CoreUpdateService'
        );
      }

      // 标记"待首启验证"：稳定运行→删备份（稳定即弃）；首启失败→自动回滚（见 index 'error' 钩子）。
      // 同时抑制 ProxyManager 自动重启——让新核心首次异常退出立即上报，而非在坏核心上空转重试。
      this.pendingUpdateVersion = preflight.version;
      this.pendingUpdateAt = Date.now();
      this.proxyManager?.setAutoRestartSuppressed(true);
      // 兜底：到期仍未被 'started'/'error' 解决，则清待验证态并解除抑制（避免抑制闩永久挂起）。
      if (this.pendingFallbackTimer) clearTimeout(this.pendingFallbackTimer);
      this.pendingFallbackTimer = setTimeout(() => {
        this.pendingFallbackTimer = null;
        if (this.pendingUpdateVersion) {
          this.logManager.addLog(
            'info',
            '核心更新待验证窗口超时未见首启事件，解除自动重启抑制',
            'CoreUpdateService'
          );
          this.pendingUpdateVersion = null;
          this.proxyManager?.setAutoRestartSuppressed(false);
        }
      }, CoreUpdateService.PENDING_MAX_AGE_MS);

      // 6. 清理临时文件
      try {
        fs.unlinkSync(tempPath);
        // 清理整个临时解压目录
        if (tempExtractDir && fs.existsSync(tempExtractDir)) {
          fs.rmSync(tempExtractDir, { recursive: true, force: true });
          this.logManager.addLog('info', '已清理临时解压目录', 'CoreUpdateService');
        }
      } catch (err) {
        // 忽略清理错误
        console.error('Cleanup failed:', err);
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

      // 尝试恢复备份（仅当本次确已备份；预检阶段失败时尚无新备份，避免误恢复陈旧 .bak 致降级）
      if (backupMade) await this.restoreBackup();

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

  /**
   * 记录成功启动的版本（在代理成功启动后调用）
   */
  async recordSuccessfulVersion(): Promise<void> {
    try {
      const version = await this.getCurrentVersion();
      const versionFilePath = this.getVersionFilePath();
      const data = { version, recordedAt: new Date().toISOString() };
      fs.writeFileSync(versionFilePath, JSON.stringify(data, null, 2), 'utf-8');
      this.logManager.addLog('info', `已记录成功版本: ${version}`, 'CoreUpdateService');

      // 该版本成功运行 → 从问题版本名单移除（曾因瞬时原因误标记的版本恢复自动更新资格）
      this.clearKnownBad(version);

      // 若处于"更新后待验证"窗口：'started' 仅代表存活 1s、可能假成功，不立即删备份；改启动稳定
      // 观察期，期内无 error 才判稳定→删备份（详见 startStabilityWatch / 修 review #3 假成功删备份）
      if (this.pendingUpdateVersion) {
        this.startStabilityWatch();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('warn', `记录版本失败: ${msg}`, 'CoreUpdateService');
    }
  }

  /**
   * 获取上次记录的可用版本
   */
  getLastKnownGoodVersion(): string | null {
    try {
      const versionFilePath = this.getVersionFilePath();
      if (!fs.existsSync(versionFilePath)) return null;
      const data = JSON.parse(fs.readFileSync(versionFilePath, 'utf-8'));
      return data.version || null;
    } catch {
      return null;
    }
  }

  /**
   * 检查是否存在备份版本
   */
  hasBackup(): boolean {
    return fs.existsSync(this.getBackupPath());
  }

  /**
   * 获取备份版本号（运行 sing-box.bak version）
   */
  async getBackupVersion(): Promise<string | null> {
    const backupPath = this.getBackupPath();
    if (!fs.existsSync(backupPath)) return null;
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);
      const { stdout } = await execAsync(`"${backupPath}" version`);
      const match = stdout.match(/version\s+(\S+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * 获取当前核心版本信息（用于 UI 展示）
   */
  async getVersionInfo(): Promise<CoreVersionInfo> {
    const currentVersion = await this.getCurrentVersion();
    const hasBackup = this.hasBackup();
    const backupVersion = hasBackup ? await this.getBackupVersion() : null;
    const lastKnownVersion = this.getLastKnownGoodVersion();
    return { currentVersion, backupVersion, hasBackup, lastKnownVersion };
  }

  /**
   * 用户触发的回滚：将 .bak 恢复为当前核心，并重新签名
   */
  async rollbackCore(): Promise<void> {
    if (!this.hasBackup()) {
      throw new Error('没有可用的备份版本');
    }

    if (this.proxyManager) {
      const status = this.proxyManager.getStatus();
      if (status.running) {
        this.logManager.addLog('info', '回滚前停止代理服务...', 'CoreUpdateService');
        await this.proxyManager.stop();
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    const currentPath = resourceManager.getSingBoxUpdateTargetPath();
    const backupPath = this.getBackupPath();

    this.logManager.addLog(
      'info',
      `正在回滚核心: ${backupPath} → ${currentPath}`,
      'CoreUpdateService'
    );

    if (process.platform === 'win32') {
      await this.copyFileElevatedWindows(backupPath, currentPath);
    } else {
      fs.copyFileSync(backupPath, currentPath);
      fs.chmodSync(currentPath, 0o755);
    }

    // macOS: 重新签名
    if (process.platform === 'darwin') {
      try {
        const { execSync } = require('child_process');
        execSync(`xattr -cr "${currentPath}"`, { stdio: 'pipe' });
        execSync(`codesign --force --deep -s - "${currentPath}"`, { stdio: 'pipe' });
        this.logManager.addLog('info', '回滚：已完成 macOS 签名处理', 'CoreUpdateService');
      } catch (signError: any) {
        this.logManager.addLog(
          'warn',
          `回滚签名处理失败: ${signError.message}`,
          'CoreUpdateService'
        );
      }
    }

    this.logManager.addLog('info', '核心回滚成功', 'CoreUpdateService');

    // 删除备份（回滚后备份不再有意义）
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // ignore
    }

    // 更新版本记录
    await this.recordSuccessfulVersion();
  }

  /**
   * 用户手动选择本地 sing-box 二进制并替换当前核心
   * 通过系统文件选择器让用户选取文件
   */
  async replaceManualCore(): Promise<void> {
    // 打开系统文件选择器
    const result = await dialog.showOpenDialog({
      title: '选择 sing-box 可执行文件',
      filters:
        process.platform === 'win32'
          ? [{ name: 'Executable', extensions: ['exe'] }]
          : [{ name: 'All Files', extensions: ['*'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return; // 用户取消
    }

    const sourcePath = result.filePaths[0];

    // 停止代理（如果正在运行）
    if (this.proxyManager) {
      const status = this.proxyManager.getStatus();
      if (status.running) {
        this.logManager.addLog('info', '手动替换核心：停止代理服务...', 'CoreUpdateService');
        await this.proxyManager.stop();
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    // 备份当前核心
    await this.backupCurrentCore();

    const targetPath = resourceManager.getSingBoxUpdateTargetPath();
    const targetDir = path.dirname(targetPath);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    this.logManager.addLog(
      'info',
      `手动替换核心: ${sourcePath} → ${targetPath}`,
      'CoreUpdateService'
    );

    if (process.platform === 'win32') {
      await this.copyFileElevatedWindows(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
      fs.chmodSync(targetPath, 0o755);
    }

    // 手动替换核心后，确保 libcronet 与新核心同目录（naive 依赖随 app 打包的库；修 review M4，
    // 与自动核心更新路径一致）
    await resourceManager.ensureCronetBeside(targetDir);

    // macOS: 清除隔离标记并重新签名
    if (process.platform === 'darwin') {
      try {
        const { execSync } = require('child_process');
        execSync(`xattr -cr "${targetPath}"`, { stdio: 'pipe' });
        execSync(`codesign --force --deep -s - "${targetPath}"`, { stdio: 'pipe' });
        this.logManager.addLog('info', '手动替换：已完成 macOS 签名处理', 'CoreUpdateService');
      } catch (signError: any) {
        this.logManager.addLog(
          'warn',
          `手动替换签名处理失败: ${signError.message}`,
          'CoreUpdateService'
        );
      }
    }

    // 验证新核心是否可运行，防止用户错选了 .tar.gz 压缩包或者选错了架构 (amd64 vs arm64)
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);
      const { stdout } = await execAsync(`"${targetPath}" version`);
      if (!stdout.includes('version')) {
        throw new Error('执行结果不是有效的 sing-box');
      }
    } catch (e) {
      this.logManager.addLog(
        'error',
        `所选文件无法执行。已自动回滚。错误详情: ${e}`,
        'CoreUpdateService'
      );
      // 恢复备份
      await this.restoreBackup();
      throw new Error(
        '您选择的文件无法被系统执行。Mac 用户请注意：\n1. 请务必先双击解压下载的 .tar.gz 压缩包，然后选择解压出来的名为 sing-box 的 UNIX 可执行文件。\n2. 请确保下载的架构 (arm64/amd64) 与您当前的 Mac 匹配。'
      );
    }

    // 记录新版本
    await this.recordSuccessfulVersion();
    this.logManager.addLog('info', '手动替换核心成功', 'CoreUpdateService');
  }

  // === 核心更新健壮性：预检 / 问题版本跳过 / 备份生命周期 / 自动回滚 ===

  /** 取任意 sing-box 二进制的版本号（执行 `<bin> version` 解析）；不可执行返回 null。 */
  private async getBinaryVersion(binPath: string): Promise<string | null> {
    try {
      const execFileAsync = require('util').promisify(require('child_process').execFile);
      const { stdout } = await execFileAsync(binPath, ['version']);
      const m = String(stdout).match(/(?:version\s+|v)(\d+\.\d+(?:\.\d+)?)/i);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  private getKnownBadPath(): string {
    return path.join(app.getPath('userData'), 'core-known-bad.json');
  }

  private loadKnownBad(): string[] {
    try {
      const p = this.getKnownBadPath();
      if (!fs.existsSync(p)) return [];
      const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return Array.isArray(d?.versions) ? d.versions : [];
    } catch {
      return [];
    }
  }

  /** 标记某版本为"问题版本"（预检/启动失败），自动更新将跳过；手动更新仍可强制安装。 */
  private markKnownBad(version: string): void {
    try {
      const list = this.loadKnownBad();
      if (!list.includes(version)) list.push(version);
      fs.writeFileSync(
        this.getKnownBadPath(),
        JSON.stringify({ versions: list }, null, 2),
        'utf-8'
      );
      this.logManager.addLog(
        'warn',
        `已标记问题版本 ${version}，自动更新将跳过`,
        'CoreUpdateService'
      );
    } catch {
      /* ignore */
    }
  }

  isKnownBad(version: string): boolean {
    return this.loadKnownBad().includes(version);
  }

  /** 从问题版本名单移除某版本（该版本成功运行后调用，使误标记可恢复）。 */
  private clearKnownBad(version: string): void {
    try {
      const list = this.loadKnownBad();
      if (!list.includes(version)) return;
      const next = list.filter((v) => v !== version);
      fs.writeFileSync(
        this.getKnownBadPath(),
        JSON.stringify({ versions: next }, null, 2),
        'utf-8'
      );
    } catch {
      /* ignore */
    }
  }

  private async isRestrictToCompatibleMinor(): Promise<boolean> {
    try {
      if (!this.configProvider) return true;
      const cfg = await this.configProvider();
      return cfg?.restrictCoreUpdateToCompatibleMinor !== false; // 默认 true
    } catch {
      return true;
    }
  }

  /**
   * 核心更新预检：新核心二进制可执行 + 能解析"针对其版本生成的"当前配置（sing-box check）。
   * 在替换现役核心之前调用 —— 不通过则现役核心不动、代理继续运行（永不 brick）。
   */
  private async preflightValidate(
    newCorePath: string
  ): Promise<{ ok: boolean; version: string | null; reason?: string }> {
    const version = await this.getBinaryVersion(newCorePath);
    if (!version) {
      return { ok: false, version: null, reason: '新核心无法执行（架构不符或文件损坏）' };
    }

    const cfgJson = this.proxyManager ? this.proxyManager.buildPreflightConfigJson(version) : null;
    if (!cfgJson) {
      // 无活动配置（代理从未启动）→ 二进制可执行即视为通过
      this.logManager.addLog(
        'info',
        `预检：新核心 ${version} 可执行（无活动配置，跳过 check）`,
        'CoreUpdateService'
      );
      return { ok: true, version };
    }

    const tmpCfg = path.join(app.getPath('temp'), `flowz-preflight-${Date.now()}.json`);
    try {
      fs.writeFileSync(tmpCfg, cfgJson, 'utf-8');
      const execFileAsync = require('util').promisify(require('child_process').execFile);
      await execFileAsync(newCorePath, ['check', '-c', tmpCfg]);
      this.logManager.addLog(
        'info',
        `预检通过：新核心 ${version} 可解析当前配置`,
        'CoreUpdateService'
      );
      return { ok: true, version };
    } catch (e: any) {
      const detail = String(e?.stderr || e?.message || e).split('\n')[0];
      return { ok: false, version, reason: `新核心无法解析当前配置：${detail}` };
    } finally {
      try {
        fs.unlinkSync(tmpCfg);
      } catch {
        /* ignore */
      }
    }
  }

  /** 删除旧核心备份（新核心已稳定运行后调用 —— 稳定即不再回滚，省磁盘）。 */
  private pruneBackup(): void {
    try {
      const bak = this.getBackupPath();
      if (fs.existsSync(bak)) {
        fs.unlinkSync(bak);
        this.logManager.addLog('info', '新核心已稳定运行，已删除旧核心备份', 'CoreUpdateService');
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * 新核心首启成功后启动"稳定观察期"：STABILITY_DWELL_MS 内无 'error' 才判定稳定 → 删旧备份、清待
   * 验证标记、恢复自动重启。期内若 'error' 触发 autoRollback 会先取消本计时器（备份仍在，可回滚）。
   */
  private startStabilityWatch(): void {
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    const watching = this.pendingUpdateVersion;
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      if (this.pendingUpdateVersion !== watching) return; // 已被回滚/其它路径清除
      this.logManager.addLog(
        'info',
        `新核心 ${watching} 已稳定运行 ${CoreUpdateService.STABILITY_DWELL_MS / 1000}s，删除旧核心备份`,
        'CoreUpdateService'
      );
      this.pruneBackup();
      if (this.pendingFallbackTimer) clearTimeout(this.pendingFallbackTimer);
      this.pendingFallbackTimer = null;
      this.pendingUpdateVersion = null;
      this.proxyManager?.setAutoRestartSuppressed(false);
    }, CoreUpdateService.STABILITY_DWELL_MS);
  }

  /**
   * 更新后新核心"首次启动失败"时调用（由上层在 proxy 'error' 事件中触发）：回滚到备份核心并标记
   * 问题版本。返回 true 表示已回滚（调用方应以旧核心重启代理）。先清除待验证标记防重入/回滚循环。
   */
  async autoRollbackIfPendingUpdate(): Promise<boolean> {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    if (this.pendingFallbackTimer) {
      clearTimeout(this.pendingFallbackTimer);
      this.pendingFallbackTimer = null;
    }
    const pending = this.pendingUpdateVersion;
    const pendingAge = Date.now() - this.pendingUpdateAt;
    this.pendingUpdateVersion = null;
    this.proxyManager?.setAutoRestartSuppressed(false); // 回滚后旧核心恢复正常自动重启
    if (!pending) return false;
    // 过期保护：距本次更新过久仍未成功运行，此刻的 error 多半与核心更新无关（如用户改了配置）→ 不回滚
    if (pendingAge > CoreUpdateService.PENDING_MAX_AGE_MS) {
      this.logManager.addLog(
        'info',
        `待验证版本 ${pending} 距更新已超 ${CoreUpdateService.PENDING_MAX_AGE_MS / 60000} 分钟仍未成功运行，本次错误不触发回滚`,
        'CoreUpdateService'
      );
      return false;
    }
    if (!this.hasBackup()) return false;
    this.logManager.addLog(
      'error',
      `新核心 ${pending} 启动失败，自动回滚到备份核心`,
      'CoreUpdateService'
    );
    try {
      await this.rollbackCore(); // 恢复 .bak → 现役（内部停代理 + 删备份 + 记录版本）
      this.markKnownBad(pending);
      return true;
    } catch (e) {
      this.logManager.addLog('error', `自动回滚失败: ${e}`, 'CoreUpdateService');
      return false;
    }
  }

  /**
   * 版本记录文件路径
   */
  private getVersionFilePath(): string {
    return path.join(app.getPath('userData'), 'core-version.json');
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
    // 容忍前导 v 与 prerelease/build 后缀（"v1.13.13"、"1.13.13-beta"、"1.13.13+naive"），
    // 每段 NaN→0，避免 "1.13.13-beta" 这类标签把某段算成 NaN 而误判为相等。
    const norm = (v: string) =>
      v
        .replace(/^v/i, '')
        .split(/[-+]/)[0]
        .split('.')
        .map((p) => parseInt(p, 10) || 0);
    const p1 = norm(v1);
    const p2 = norm(v2);
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
    const filteredAssets = assets.filter(
      (a: any) =>
        a.name.toLowerCase().includes(keyword) &&
        a.name.toLowerCase().includes(archKeyword) &&
        (a.name.endsWith(ext) || a.name.endsWith('.zip'))
    );

    if (filteredAssets.length === 0) return undefined;

    // 优先顺序：
    // 1. 包含 with-naive 或 full 的版本 (针对 Windows)
    // 2. 不含 legacy 的版本
    // 3. 其他匹配项

    const preferred = filteredAssets.find(
      (a: any) =>
        a.name.toLowerCase().includes('with-naive') || a.name.toLowerCase().includes('full')
    );
    if (preferred) return preferred;

    const nonLegacy = filteredAssets.find((a: any) => !a.name.toLowerCase().includes('legacy'));
    if (nonLegacy) return nonLegacy;

    return filteredAssets[0];
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
      const handleError = (err: any) => {
        file.close();
        fs.unlink(tempPath, () => {});

        // 遇到网络错误，且是第一次尝试，并且是 github 链接，尝试使用加速镜像
        if (!isRetry && url.includes('github.com')) {
          this.logManager.addLog(
            'warn',
            `下载出错，尝试使用加速镜像: ${err.message}`,
            'CoreUpdateService'
          );
          const mirrorUrl = `https://mirror.ghproxy.com/${url}`;
          this.downloadFile(mirrorUrl, true).then(resolve).catch(reject);
          return;
        }

        reject(err);
      };

      const request = net.request(url);
      request.setHeader('User-Agent', 'FlowZ-Electron');

      request.on('response', (response) => {
        if (response.statusCode >= 400) {
          file.close();
          fs.unlink(tempPath, () => {});
          reject(new Error(`Download failed: ${response.statusCode}`));
          return;
        }

        // 完整性校验：累计字节与 Content-Length 比对，拦截被截断/中断的下载流入解压
        const lenHeader = response.headers['content-length'];
        const expectedBytes = parseInt(
          (Array.isArray(lenHeader) ? lenHeader[0] : lenHeader) as string,
          10
        );
        let receivedBytes = 0;

        response.on('data', (chunk) => {
          receivedBytes += chunk.length;
          file.write(chunk);
        });

        response.on('end', () => {
          file.close(() => {
            if (!isNaN(expectedBytes) && receivedBytes !== expectedBytes) {
              // 截断的 GitHub 下载会经 handleError 自动换镜像重试一次
              handleError(
                new Error(
                  `下载不完整：收到 ${receivedBytes} 字节，期望 ${expectedBytes}（可能被截断）`
                )
              );
              return;
            }
            resolve(tempPath);
          });
        });

        response.on('error', handleError);
      });

      request.on('error', handleError);

      request.end();
    });
  }

  private async extractCore(filePath: string): Promise<{ corePath: string; extractDir: string }> {
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

      return { corePath, extractDir };
    } catch (error) {
      // 报错时也尝试清理临时目录
      try {
        if (fs.existsSync(extractDir)) {
          fs.rmSync(extractDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup errors during recovery
      }
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
    const currentPath = resourceManager.getSingBoxUpdateTargetPath();
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
      if (directErr.code !== 'EPERM' && directErr.code !== 'EACCES' && directErr.code !== 'EBUSY') {
        throw directErr;
      }

      this.logManager.addLog(
        'info',
        `Direct copy failed (${directErr.code}), attempting elevated PowerShell copy...`,
        'CoreUpdateService'
      );

      // Fall back: use PowerShell with -Verb RunAs to elevate.
      const scriptPath = path.join(app.getPath('temp'), `flowz-copy-${Date.now()}.ps1`);
      // 使用 $ErrorActionPreference = 'Stop' 确保出错时非 0 退出
      // 增加 Stop-Process 防御，防止因为 TUN 模式的高权限占用导致无法覆盖
      fs.writeFileSync(
        scriptPath,
        `$ErrorActionPreference = 'Stop'\nStop-Process -Name "sing-box" -Force -ErrorAction SilentlyContinue\nStart-Sleep -Seconds 1\nCopy-Item -Path '${escapedSrc}' -Destination '${escapedDest}' -Force\n`
      );

      try {
        // 使用 Start-Process -Verb RunAs 触发 UAC 提权并用 -Wait 阻塞直到完成
        execSync(
          `powershell -Command "Start-Process powershell.exe -ArgumentList '-ExecutionPolicy Bypass -WindowStyle Hidden -File \\"${scriptPath}\\"' -Verb RunAs -Wait"`,
          {
            stdio: 'pipe',
            timeout: 60000,
          }
        );
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
