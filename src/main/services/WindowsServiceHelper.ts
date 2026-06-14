/**
 * Windows 提权服务客户端（对齐 macOS HelperManager，实现 IPrivilegedHelper）。
 *
 * 解决：未签名应用在 TUN 模式下每次启停 sing-box（含切节点重启）都弹 UAC。
 * 方案：一次性安装一个 LocalSystem Windows 服务（Go 二进制，见 helper-win/），之后普通用户 app 经 token 鉴权的
 *       命名管道零提权驱动 sing-box 启停——切节点/停止/退出/崩溃回收均免再次 UAC。
 *
 * 仅 Windows 有意义；其余平台所有方法安全降级（supported=false / ready=false）。
 * 未安装时由 ProxyManager 回退到 buildWindowsUacLaunchCommand（每次 UAC）。
 *
 * 与 macOS HelperManager 的对应（协议/行协议/token 语义一致，便于共用上层逻辑）：
 *   launchd daemon → Windows 服务（SCM, LocalSystem, start=auto）
 *   unix socket    → 命名管道 \\.\pipe\flowz-helper（ACL：SYSTEM + 交互用户；token 为主鉴权边界）
 *   osascript 授权 → UAC（Start-Process -Verb RunAs）
 *   命令集取子集：ping/version/status/start/stop/cleanup/freeport（无 macOS 专属 install-core）。
 *
 * 服务 start=auto 常驻 → app 全程只对管道发命令、不 start/stop 服务 → 普通用户起核只依赖管道 ACL，
 * 不依赖给普通用户授 SCM 权限（核心卖点的去风险点）。
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { HelperStatus } from '../../shared/types';
import type { ILogManager } from './LogManager';
import type { HelperStartResult } from './HelperManager';
import type { IPrivilegedHelper } from './IPrivilegedHelper';
import { resourceManager } from './ResourceManager';
import { getUserDataPath } from '../utils/paths';

/** SCM 服务名。 */
const SERVICE_NAME = 'FlowZHelper';
/** 命名管道路径（与 helper-win 默认一致）。Node net.connect 支持 \\.\pipe\ 形式。 */
const PIPE_PATH = '\\\\.\\pipe\\flowz-helper';
/** SYSTEM 侧支持目录：服务以 LocalSystem 读 helper.token；安装时 elevated 写入并设 ACL（SYSTEM + Administrators）。 */
const SUPPORT_DIR = path.join(process.env.ProgramData || 'C:\\ProgramData', 'FlowZ');
/** sc query 不存在服务时的退出码（ERROR_SERVICE_DOES_NOT_EXIST）。 */
const ERROR_SERVICE_DOES_NOT_EXIST = 1060;
/** 与 helper-win 的 protoVersion 对应。Windows 独立谱系：v1 = ping/version/status/start/stop/cleanup/freeport。 */
const MIN_USABLE_PROTO = 1;
const EXPECTED_PROTO = 1;

export class WindowsServiceHelper implements IPrivilegedHelper {
  /** 装/卸互斥期返回最近稳定快照，避免 TOCTOU 半态（对齐 HelperManager.lastStableStatus）。 */
  private lastStableStatus: HelperStatus | null = null;
  private mutationInFlight = false;

  constructor(private logManager?: ILogManager | null) {}

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.logManager?.addLog(level, message, 'Helper');
  }

  private get supported(): boolean {
    return process.platform === 'win32';
  }

  private notSupportedStatus(): HelperStatus {
    return {
      supported: false,
      installed: false,
      ready: false,
      upgradeable: false,
      version: null,
      loaded: null,
      needsRepair: false,
      backgroundDisabled: false,
      pathMismatch: false,
      installedSingboxPath: null,
    };
  }

  // ── token（app 侧客户端副本，与服务侧 helper.token 同值）─────────────────
  // 独立成文件（非 UserConfig 字段）：渲染端整体回写 config.json 时碰不到它，杜绝竞态（对齐 HelperManager）。
  private tokenFilePath(): string {
    return path.join(getUserDataPath(), 'helper-client.token');
  }

  private token(): string {
    try {
      return fs.readFileSync(this.tokenFilePath(), 'utf8').trim();
    } catch {
      return '';
    }
  }

  // ── 命名管道客户端（行协议：token\n cmd\n [args...]，与 helper.go/HelperManager 同款）────────
  private sendCommand(rest: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(PIPE_PATH);
      let buf = '';
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('helper pipe 超时'));
      }, timeoutMs);
      sock.on('connect', () => {
        sock.end([this.token(), ...rest].join('\n') + '\n');
      });
      sock.on('data', (d) => {
        buf += d.toString();
      });
      sock.on('end', () => {
        clearTimeout(timer);
        resolve(buf.trim());
      });
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // ── SCM 状态探测 ─────────────────────────────────────────────────────────
  /** sc query：服务是否存在 + 是否 RUNNING。不存在（exit 1060）→ {exists:false}。 */
  private queryService(): Promise<{ exists: boolean; running: boolean }> {
    return new Promise((resolve) => {
      execFile(
        'sc.exe',
        ['query', SERVICE_NAME],
        { timeout: 4000, windowsHide: true },
        (err, stdout) => {
          const code = (err as { code?: number } | null)?.code;
          if (code === ERROR_SERVICE_DOES_NOT_EXIST) {
            return resolve({ exists: false, running: false });
          }
          const out = stdout || '';
          // 存在：无错误，或输出含 SERVICE_NAME 段（1060 以外的瞬时错误时尽量按存在处理，宁误判存在不误判缺失）
          const exists = !err || /SERVICE_NAME/i.test(out);
          const running = /STATE\s*:\s*\d+\s+RUNNING/i.test(out);
          resolve({ exists, running });
        }
      );
    });
  }

  /** 快速判定能否零提权驱动（ProxyManager 启动路由用）。 */
  async isReady(): Promise<boolean> {
    if (!this.supported || !this.token()) return false;
    try {
      const resp = await this.sendCommand(['ping'], 1500);
      const m = resp.match(/^OK pong uid=-?\d+ v(\d+)/);
      return !!m && parseInt(m[1], 10) >= MIN_USABLE_PROTO;
    } catch {
      return false;
    }
  }

  /** 完整状态：供设置页展示 + 安装/卸载按钮判态。装/卸互斥期返回最近稳定快照。 */
  async getStatus(force = false): Promise<HelperStatus> {
    if (this.mutationInFlight && this.lastStableStatus) return this.lastStableStatus;
    const s = await this.computeStatus(force);
    if (this.mutationInFlight && this.lastStableStatus) return this.lastStableStatus;
    this.lastStableStatus = s;
    return s;
  }

  private async computeStatus(_force = false): Promise<HelperStatus> {
    if (!this.supported) return this.notSupportedStatus();
    const { exists: installed, running } = await this.queryService();
    let version: string | null = null;
    let ready = false;
    let upgradeable = false;
    if (installed && this.token()) {
      try {
        const resp = await this.sendCommand(['ping'], 1500);
        const m = resp.match(/^OK pong uid=-?\d+ v(\d+)/);
        if (m) {
          version = m[1];
          const pv = parseInt(version, 10);
          ready = !isNaN(pv) && pv >= MIN_USABLE_PROTO;
          upgradeable = ready && pv < EXPECTED_PROTO;
        }
      } catch {
        /* 未就绪 */
      }
    }
    return {
      supported: true,
      installed,
      ready,
      upgradeable,
      version,
      // SCM RUNNING 即「已加载」；未安装为 null（对齐 HelperManager.loaded 语义）。
      loaded: installed ? running : null,
      needsRepair: installed && !ready,
      // 以下为 macOS 专属字段，Windows 恒默认值（消费方契约：先判 backgroundDisabled 再判 needsRepair）。
      backgroundDisabled: false,
      // 已知限制（review TS-H2，待真机/后续）：Windows 核更新（Portable 模式写 userData/core_update）后，服务 binPath
      // 仍指向安装时锁定的 sing-box，此处不检测漂移（恒 false）→ 不触发修复 gate。后续可比对服务 ImagePath 的 --singbox
      // 段 vs 当前 getSingBoxPath() 实现之；当前 Windows 核更新走 app 侧、非 helper，影响有限。
      pathMismatch: false,
      installedSingboxPath: null,
    };
  }

  // ── sing-box 启停（管道，零提权）──────────────────────────────────────────
  /** 经服务以 SYSTEM 启动 sing-box（已提权，无内层 UAC）。行6=父 app PID（父死看护）。 */
  async startCore(
    configPath: string,
    logPath: string,
    forward: boolean
  ): Promise<HelperStartResult> {
    try {
      await this.sendCommand(['stop'], 3000).catch(() => '');
      const resp = await this.sendCommand(
        ['start', configPath, logPath || '', forward ? '1' : '0', String(process.pid)],
        8000
      );
      const m = resp.match(/^OK (?:started|already) (\d+)/);
      if (m) return { ok: true, pid: parseInt(m[1], 10) };
      return { ok: false, error: resp || 'helper 无响应' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 经服务停止 sing-box（SYSTEM），零提权。 */
  async stopCore(): Promise<boolean> {
    try {
      const resp = await this.sendCommand(['stop'], 5000);
      return resp.startsWith('OK');
    } catch {
      return false;
    }
  }

  /** 经服务杀掉所有 sing-box（含孤儿），零提权。 */
  async cleanup(): Promise<boolean> {
    try {
      const resp = await this.sendCommand(['cleanup'], 5000);
      return resp.startsWith('OK');
    } catch {
      return false;
    }
  }

  /** 经服务按端口清占用者：是 sing-box 才杀，否则回报 foreign（不杀无辜，对齐 macOS v4）。 */
  async freePort(port: number): Promise<{ freed?: boolean; foreign?: string; error?: string }> {
    try {
      const resp = await this.sendCommand(['freeport', String(port)], 5000);
      if (resp.startsWith('OK free') || resp.startsWith('OK killed')) return { freed: true };
      const m = resp.match(/^OK foreign (.+)/);
      if (m) return { foreign: m[1].trim() };
      return { error: resp || 'helper 无响应' };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 服务当前是否在托管一个 sing-box（孤儿探测）。 */
  async coreStatus(): Promise<{ running: boolean; pid?: number }> {
    try {
      const resp = await this.sendCommand(['status'], 2000);
      const m = resp.match(/^OK running (\d+)/);
      return m ? { running: true, pid: parseInt(m[1], 10) } : { running: false };
    } catch {
      return { running: false };
    }
  }

  // ── 安装 / 卸载（一次 UAC）─────────────────────────────────────────────────
  /**
   * 安装/修复服务：生成随机 token + UAC 提权跑 sc create/start。
   * ⚠️ 真机必验：sc create binPath= 含空格路径的引号语义、helper.token ACL、UAC 取消回退、非管理员经已装服务起核。
   */
  async install(): Promise<{ success: boolean; error?: string; status: HelperStatus }> {
    if (!this.supported) {
      return {
        success: false,
        error: '仅 Windows 支持提权服务',
        status: await this.computeStatus(),
      };
    }
    this.mutationInFlight = true;
    try {
      const exe = resourceManager.getWinHelperPath();
      if (!fs.existsSync(exe)) {
        this.log('error', `helper 二进制缺失: ${exe}`);
        return {
          success: false,
          error: 'helper 二进制缺失（构建未包含）',
          status: await this.computeStatus(),
        };
      }
      const singboxPath = resourceManager.getSingBoxPath();
      const confDir = getUserDataPath();

      // token：复用已有，否则生成并写入客户端副本；UAC 脚本把同值写 SYSTEM 侧 helper.token。
      let token = this.token();
      if (!token) {
        token = randomBytes(16).toString('hex');
        try {
          fs.writeFileSync(this.tokenFilePath(), token);
        } catch (e) {
          return {
            success: false,
            error: `写入 token 失败: ${e instanceof Error ? e.message : String(e)}`,
            status: await this.computeStatus(),
          };
        }
      }

      const script = this.buildInstallScript(exe, singboxPath, confDir, token);
      const result = await this.runElevatedPowerShell(script);
      if (!result.success) {
        return { success: false, error: result.error, status: await this.computeStatus() };
      }

      // 等服务起来绑定管道，再确认就绪（对齐 macOS install 的 10×300ms 就绪等待）。
      let status = await this.computeStatus();
      for (let i = 0; i < 10 && !status.ready; i++) {
        await new Promise((r) => setTimeout(r, 300));
        status = await this.computeStatus();
      }
      if (status.ready) this.log('info', 'helper 服务安装并就绪');
      else this.log('warn', 'helper 服务已安装但未在预期内就绪');
      this.lastStableStatus = status;
      return { success: true, status };
    } finally {
      this.mutationInFlight = false;
    }
  }

  /** 卸载服务：UAC 提权跑 sc stop + sc delete + 删 token；并删客户端 token 副本。 */
  async uninstall(): Promise<{ success: boolean; error?: string; status: HelperStatus }> {
    if (!this.supported) {
      return {
        success: false,
        error: '仅 Windows 支持提权服务',
        status: await this.computeStatus(),
      };
    }
    this.mutationInFlight = true;
    try {
      const result = await this.runElevatedPowerShell(this.buildUninstallScript());
      if (!result.success) {
        return { success: false, error: result.error, status: await this.computeStatus() };
      }
      try {
        fs.unlinkSync(this.tokenFilePath());
      } catch {
        /* 不存在则忽略 */
      }
      this.log('info', 'helper 服务已卸载');
      const status = await this.computeStatus();
      this.lastStableStatus = status;
      return { success: true, status };
    } finally {
      this.mutationInFlight = false;
    }
  }

  // ── 提权脚本生成 + 执行 ────────────────────────────────────────────────────
  /** PowerShell 单引号字符串转义（'' 转义单引号；防注入）。 */
  private psq(s: string): string {
    return s.replace(/'/g, "''");
  }

  /**
   * 安装脚本体（在 runElevatedPowerShell 的 $ErrorActionPreference=Stop + try/catch 包裹内跑）：写受保护 token
   * （ACL：SYSTEM + Administrators，去继承）→ 幂等清旧服务并**轮询等其真正消失** → New-Service **1072 退避重试**
   * 创建（BinaryPathName 单一 .NET 字符串直达 CreateService，真双引号锁定 exe + 三参，默认 LocalSystem，Automatic
   * 开机自启）→ sc start。
   */
  private buildInstallScript(
    exe: string,
    singboxPath: string,
    confDir: string,
    token: string
  ): string {
    // BinaryPathName(ImagePath)：各含空格路径用**真双引号**包裹，经 New-Service 单一字符串直达 Win32 CreateService。
    // 不可用 `sc.exe create binPath= "\"..\""`：PS 原样把 `\"` 传给 sc → 服务启动经 CommandLineToArgvW 时 `\"`
    // 退化为字面引号 → 含空格安装路径（默认 C:\Program Files\FlowZ）下 argv 碎裂、flag 值带字面引号 → 服务侧
    // singboxBin/confDir/supportDir 全污染（isLockedSingbox/cfgAllowed/tokenValue 全失效）。
    const binPath = `"${exe}" --singbox "${singboxPath}" --confdir "${confDir}" --support "${SUPPORT_DIR}"`;
    const tokenFile = path.join(SUPPORT_DIR, 'helper.token');
    return [
      `$support = '${this.psq(SUPPORT_DIR)}'`,
      `$tokenFile = '${this.psq(tokenFile)}'`,
      `$bp = '${this.psq(binPath)}'`,
      'New-Item -ItemType Directory -Force -Path $support | Out-Null',
      // 写 token（无 BOM ASCII），随后设 ACL：去继承、仅 SYSTEM + Administrators 读
      `Set-Content -Path $tokenFile -Value '${this.psq(token)}' -NoNewline -Encoding ascii`,
      'icacls $tokenFile /inheritance:r | Out-Null',
      'icacls $tokenFile /grant:r "SYSTEM:(R)" "Administrators:(R)" | Out-Null',
      // 幂等重装：停 + 删旧服务（按名）
      `& sc.exe stop ${SERVICE_NAME} 2>$null | Out-Null`,
      `& sc.exe delete ${SERVICE_NAME} 2>$null | Out-Null`,
      // sc delete 是异步「标记删除」（须等所有句柄关闭 + 进程停才移除）→ 轮询等服务真消失，否则 New-Service 撞
      // 1072 ERROR_SERVICE_MARKED_FOR_DELETE（重装真机高概率命中）。
      '$deadline = (Get-Date).AddSeconds(15)',
      `while ((Get-Service -Name ${SERVICE_NAME} -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }`,
      // New-Service 退避重试兜底（删除标记态 1072 窗口期）：BinaryPathName 单一字符串直达 CreateService；
      // 默认账户即 LocalSystem；-StartupType Automatic = 开机自启常驻（app 全程只发管道命令、不 start/stop 服务）。
      '$created = $false',
      'for ($i = 0; $i -lt 10 -and -not $created; $i++) {',
      `  try { New-Service -Name ${SERVICE_NAME} -BinaryPathName $bp -StartupType Automatic | Out-Null; $created = $true }`,
      '  catch { Start-Sleep -Milliseconds 500 }',
      '}',
      "if (-not $created) { throw 'New-Service 失败：服务仍处于删除标记态(1072)，请稍候或重启后重试安装' }",
      `& sc.exe start ${SERVICE_NAME} | Out-Null`,
    ].join('\n');
  }

  /** 卸载脚本体（在 runElevatedPowerShell 的 Stop + try/catch 包裹内跑）：停 + 删服务 + 删受保护 token/目录。
   *  对「服务/目录不存在」容错（sc 外部命令不受 Stop 影响、不抛；Remove-Item 显式 SilentlyContinue）。 */
  private buildUninstallScript(): string {
    return [
      `& sc.exe stop ${SERVICE_NAME} 2>$null | Out-Null`,
      'Start-Sleep -Milliseconds 300',
      `& sc.exe delete ${SERVICE_NAME} 2>$null | Out-Null`,
      `Remove-Item -Recurse -Force -Path '${this.psq(SUPPORT_DIR)}' -ErrorAction SilentlyContinue`,
    ].join('\n');
  }

  /**
   * 以一次 UAC 跑 PowerShell 脚本：写临时 .ps1 → 外层 Start-Process -Verb RunAs -Wait 触发 UAC。
   * 内层以 $ErrorActionPreference=Stop + try/catch 包裹脚本体：成功写 flag "0"；失败把**异常信息**写 .err + flag "1"，
   * 供 app 回传具体失败原因（对齐「失败须带原因」——否则只见「退出码 N」无法区分 1072 竞态 / 路径错 / ACL 失败）。
   * UAC 取消 → Start-Process 抛错 → 外层 exit 1。
   * ⚠️ 真机必验：UAC 弹窗/取消、-Wait 完成语义、flag/err 回写时序、sc delete→New-Service 重装竞态命中率。
   */
  private runElevatedPowerShell(inner: string): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const stamp = randomBytes(6).toString('hex');
      const scriptPath = path.join(os.tmpdir(), `flowz-helper-${stamp}.ps1`);
      const flagPath = path.join(os.tmpdir(), `flowz-helper-${stamp}.done`);
      const errPath = path.join(os.tmpdir(), `flowz-helper-${stamp}.err`);
      const script = [
        "$ErrorActionPreference = 'Stop'",
        'try {',
        inner,
        `  "0" | Out-File -FilePath '${this.psq(flagPath)}' -Encoding ascii`,
        '} catch {',
        `  $_.Exception.Message | Out-File -FilePath '${this.psq(errPath)}' -Encoding utf8`,
        `  "1" | Out-File -FilePath '${this.psq(flagPath)}' -Encoding ascii`,
        '}',
      ].join('\n');
      try {
        fs.writeFileSync(scriptPath, script, 'utf8');
      } catch (e) {
        return resolve({ success: false, error: `写入提权脚本失败: ${String(e)}` });
      }
      const outer =
        `try { Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait ` +
        `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${this.psq(scriptPath)}'; exit 0 } ` +
        `catch { exit 1 }`;
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer],
        { timeout: 120000, windowsHide: true },
        (err) => {
          let success = false;
          let error: string | undefined;
          if (err) {
            error = 'UAC 取消或提权失败';
          } else {
            let code = '';
            try {
              code = fs.readFileSync(flagPath, 'utf8').trim();
            } catch {
              /* 未写回 */
            }
            if (code === '0') {
              success = true;
            } else {
              let detail = '';
              try {
                detail = fs.readFileSync(errPath, 'utf8').trim();
              } catch {
                /* 无具体原因 */
              }
              error =
                detail ||
                (code === '' ? '提权脚本未写回结果（可能被取消）' : `提权脚本失败（码 ${code}）`);
            }
          }
          for (const p of [scriptPath, flagPath, errPath]) {
            try {
              fs.unlinkSync(p);
            } catch {
              /* ignore */
            }
          }
          resolve({ success, error });
        }
      );
    });
  }
}
