/**
 * macOS 提权 helper 管理器
 *
 * 解决：未签名应用在 TUN 模式下每次启停 sing-box（含切节点重启）都弹 osascript 管理员授权框。
 * 方案：一次性安装一个 root LaunchDaemon（Go 二进制，见 helper/helper.go），之后 app 经 token 鉴权的
 *       unix socket 零提权驱动 sing-box 启停。本类负责安装/卸载/状态探测 + socket 客户端（行协议）。
 *
 * 仅 macOS 有意义；其余平台所有方法均安全降级（supported=false / ready=false）。
 * 未安装时由 ProxyManager 回退到 PR-M1 的 root 看护脚本（osascript 启动一次授权）。
 */

import { app } from 'electron';
import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { HelperStatus } from '../../shared/types';
import type { ILogManager } from './LogManager';
import { resourceManager } from './ResourceManager';
import { getUserDataPath } from '../utils/paths';

const LABEL = 'com.flowz.helper';
const HELPER_DEST = `/Library/PrivilegedHelperTools/${LABEL}`;
const PLIST_PATH = `/Library/LaunchDaemons/${LABEL}.plist`;
const SYSTEM_SUPPORT = '/Library/Application Support/FlowZ';
const SOCKET_PATH = `${SYSTEM_SUPPORT}/helper.sock`;
/** 与 helper.go 的 protoVersion 对应；不一致即提示重装修复。v2=父死看护+stop TERM→KILL（bump → 已装 v1 needsRepair → 用户重装一次）。 */
const EXPECTED_PROTO = '2';
/** launchctl 加载态探测缓存 TTL：getStatus 被首页/设置页高频轮询，避免每次都 spawn launchctl。 */
const LOADED_PROBE_TTL_MS = 10_000;

export interface HelperStartResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

export class HelperManager {
  /** 路径不符 warn 仅首次记（getStatus 被设置页/首页高频调用，避免刷屏）。 */
  private pathMismatchWarned = false;

  // ── 「允许在后台」检测状态（仅 macOS）──────────────────────────────────
  /** launchctl 探测结果缓存（TTL 见 LOADED_PROBE_TTL_MS；null=探测不可用）。 */
  private loadedProbe: { value: boolean | null; at: number } | null = null;
  /** 去抖：首次 fresh 探测到 not-loaded 的时刻（连续 ≥2 次、跨 ≥3s 均 not-loaded 才判 backgroundDisabled）。 */
  private firstNotLoadedAt: number | null = null;
  /** 连续 fresh 探测到 not-loaded 的次数（缓存命中不计；探测到已加载/未知即清零）。 */
  private notLoadedProbes = 0;

  constructor(private logManager?: ILogManager | null) {}

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.logManager?.addLog(level, message, 'Helper');
  }

  private get supported(): boolean {
    return process.platform === 'darwin';
  }

  // ── token ──────────────────────────────────────────────────────────────
  // 刻意独立成文件（非 UserConfig 字段）：渲染端 saveConfig 整体回写 config.json 时永远碰不到它，
  // 杜绝「装好后 token 被携旧快照的 saveConfig 清零 → 需修复」的竞态；也避免 token 经 IPC 全量下发渲染端。
  private tokenFilePath(): string {
    return path.join(getUserDataPath(), 'helper-client.token');
  }

  /** app 侧持有的 socket 鉴权 token（与 root 侧 helper.token 同值）。 */
  private token(): string {
    try {
      return fs.readFileSync(this.tokenFilePath(), 'utf8').trim();
    } catch {
      return '';
    }
  }

  // ── 状态探测 ─────────────────────────────────────────────────────────────
  private filesPresent(): boolean {
    try {
      return fs.existsSync(HELPER_DEST) && fs.existsSync(PLIST_PATH);
    } catch {
      return false;
    }
  }

  /**
   * daemon 是否被 launchd 加载：`launchctl print system/<LABEL>` 退出码 0=已加载，非零=未加载
   * （「允许在后台」被关 → BTM 阻止 bootstrap → 不在 system 域）。普通用户可读 system 域单服务，无需 root。
   * 返回 null=探测不可用（超时/spawn 失败），调用方不得据此判定 backgroundDisabled。
   * 带 ~10s TTL 缓存（仅 supported && installed && !ready 路径会调用，见 getStatus）。
   * 注意：退出码语义须 Mac 真机验证（macOS 13/14/15 可能有差异），见设计文档必测项 1。
   */
  private probeLoaded(): Promise<boolean | null> {
    const cached = this.loadedProbe;
    if (cached && Date.now() - cached.at < LOADED_PROBE_TTL_MS) {
      return Promise.resolve(cached.value);
    }
    return new Promise((resolve) => {
      execFile('/usr/bin/launchctl', ['print', `system/${LABEL}`], { timeout: 2000 }, (err) => {
        let value: boolean | null;
        if (!err) {
          value = true; // 退出码 0 → 已加载
        } else if (err.killed || typeof (err as { code?: unknown }).code !== 'number') {
          value = null; // 超时被杀 / spawn 失败（如 ENOENT，code 为字符串）→ 未知，不参与判定
        } else {
          value = false; // 非零退出码 → 未加载
        }
        this.loadedProbe = { value, at: Date.now() };
        // 去抖计数仅随 fresh 探测推进：TTL ≥10s 保证两次 fresh 探测天然跨 ≥3s
        if (value === false) {
          if (this.firstNotLoadedAt === null) this.firstNotLoadedAt = Date.now();
          this.notLoadedProbes += 1;
        } else {
          this.firstNotLoadedAt = null;
          this.notLoadedProbes = 0;
        }
        resolve(value);
      });
    });
  }

  /** 完整状态：供设置页展示 + 安装/卸载按钮判态。 */
  async getStatus(): Promise<HelperStatus> {
    if (!this.supported) {
      return {
        supported: false,
        installed: false,
        ready: false,
        version: null,
        loaded: null,
        needsRepair: false,
        backgroundDisabled: false,
        pathMismatch: false,
        installedSingboxPath: null,
      };
    }
    const installed = this.filesPresent();
    let version: string | null = null;
    let ready = false;
    if (installed && this.token()) {
      try {
        const resp = await this.sendCommand(['ping'], 1500);
        const m = resp.match(/^OK pong uid=\d+ v(\S+)/);
        if (m) {
          version = m[1];
          ready = version === EXPECTED_PROTO;
        }
      } catch {
        /* 未就绪 */
      }
    }

    // 「允许在后台」被关检测（macOS 13+ 登录项开关）：daemon 未被 launchd 加载 → launchctl print 非零退出。
    // ready=true 必然已加载（短路免探测）；未安装为 null。干扰项天然排除：未装(installed=false)、
    // 崩溃循环(KeepAlive→loaded=true)、协议不符(ping 通→ready 路径外但 loaded=true)、pathMismatch(daemon 在跑)。
    let loaded: boolean | null = installed ? true : null;
    let backgroundDisabled = false;
    if (installed && !ready) {
      loaded = await this.probeLoaded();
      backgroundDisabled =
        loaded === false &&
        this.notLoadedProbes >= 2 &&
        this.firstNotLoadedAt !== null &&
        Date.now() - this.firstNotLoadedAt >= 3000;
    } else {
      // 就绪或未安装 → 清零去抖状态，避免历史 not-loaded 残留导致下次误判
      this.firstNotLoadedAt = null;
      this.notLoadedProbes = 0;
    }

    // 烧录路径不符检测（仅打包版）：app 被移动后 plist 里烧死的 --singbox 路径会指向旧位置 → TUN
    // 免提权启动静默失败。dev 跑 repo 路径必然与生产安装不同，属预期差异，且 dev「修复」会把 repo
    // 路径烧进生产 plist 弄坏它，故 app.isPackaged 闸门跳过。plist 644 可读，无需 root。
    let installedSingboxPath: string | null = null;
    let pathMismatch = false;
    if (installed && app.isPackaged) {
      installedSingboxPath = this.installedSingboxPath();
      if (installedSingboxPath) {
        const expected = resourceManager.getSingBoxPath();
        // App Translocation：带 quarantine 的未签名 app 从 Downloads 直接打开会被挪到随机临时路径，
        // 每次启动都不同 → 报 mismatch 修复也只会烧进临时路径、下次又不符（死循环）。此时不报 mismatch
        // （真正解法是把 app 移入「应用程序」去 translocation，移好后再正常检测）。
        const translocated = expected.includes('/AppTranslocation/');
        pathMismatch =
          !translocated &&
          path.resolve(installedSingboxPath).toLowerCase() !== path.resolve(expected).toLowerCase();
        if (pathMismatch && !this.pathMismatchWarned) {
          this.pathMismatchWarned = true; // 状态高频刷新，仅首次记日志
          this.log('warn', `helper 烧录路径不符: plist=${installedSingboxPath} 当前=${expected}`);
        }
      }
    }

    return {
      supported: true,
      installed,
      ready,
      version,
      loaded,
      needsRepair: installed && (!ready || pathMismatch),
      backgroundDisabled,
      pathMismatch,
      installedSingboxPath,
    };
  }

  /** 快速判定能否零提权驱动（ProxyManager 启动路由用）。 */
  async isReady(): Promise<boolean> {
    if (!this.supported || !this.filesPresent() || !this.token()) return false;
    try {
      const resp = await this.sendCommand(['ping'], 1500);
      return /^OK pong uid=\d+ v\S+/.test(resp) && resp.endsWith(`v${EXPECTED_PROTO}`);
    } catch {
      return false;
    }
  }

  // ── sing-box 启停（socket，零提权）────────────────────────────────────────
  /** 经 helper 启动 sing-box（root）。logPath 为早期 stdout 重定向目标；forward=allowLan。 */
  async startCore(
    configPath: string,
    logPath: string,
    forward: boolean
  ): Promise<HelperStartResult> {
    try {
      // 起前先停掉可能残留的旧 child（app 上次崩溃 → daemon 仍托管着旧 sing-box），幂等。
      await this.sendCommand(['stop'], 3000).catch(() => '');
      const resp = await this.sendCommand(
        // 行6=父 app PID（helper v2 父死看护：本进程消失 → helper 自行 TERM→KILL 收割 sing-box）。
        // HelperManager 跑在 Electron 主进程内，process.pid 即 GUI 父 PID → ProxyManager 零改动。
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

  /** 经 helper 停止 sing-box（root），零提权。 */
  async stopCore(): Promise<boolean> {
    try {
      const resp = await this.sendCommand(['stop'], 5000);
      return resp.startsWith('OK');
    } catch {
      return false;
    }
  }

  /** 经 helper 以 root 杀掉所有 sing-box（含外部 osascript 路径遗留的孤儿），零提权。 */
  async cleanup(): Promise<boolean> {
    try {
      const resp = await this.sendCommand(['cleanup'], 5000);
      return resp.startsWith('OK');
    } catch {
      return false;
    }
  }

  /** helper 当前是否在托管一个 sing-box（孤儿探测）。 */
  async coreStatus(): Promise<{ running: boolean; pid?: number }> {
    try {
      const resp = await this.sendCommand(['status'], 2000);
      const m = resp.match(/^OK running (\d+)/);
      return m ? { running: true, pid: parseInt(m[1], 10) } : { running: false };
    } catch {
      return { running: false };
    }
  }

  // ── socket 客户端（行协议：token\n cmd\n [args...]）────────────────────────
  private sendCommand(rest: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(SOCKET_PATH);
      let buf = '';
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('helper socket 超时'));
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

  // ── 安装 / 卸载（osascript 一次授权）──────────────────────────────────────
  /** 安装/修复 helper：生成随机 token 并持久化，osascript 以 root 跑安装脚本（弹一次密码框）。 */
  async install(): Promise<{ success: boolean; error?: string; status: HelperStatus }> {
    if (!this.supported) {
      return { success: false, error: '仅 macOS 支持提权 helper', status: await this.getStatus() };
    }
    const srcBinary = resourceManager.getMacHelperPath();
    if (!fs.existsSync(srcBinary)) {
      this.log('error', `helper 二进制缺失: ${srcBinary}`);
      return {
        success: false,
        error: 'helper 二进制缺失（构建未包含）',
        status: await this.getStatus(),
      };
    }

    // token：复用已有，否则生成并写入独立 token 文件(0600)；root 侧安装脚本写同值。
    let token = this.token();
    if (!token) {
      token = randomBytes(16).toString('hex');
      try {
        fs.writeFileSync(this.tokenFilePath(), token, { mode: 0o600 });
      } catch (e) {
        return {
          success: false,
          error: `写入 token 失败: ${e instanceof Error ? e.message : String(e)}`,
          status: await this.getStatus(),
        };
      }
    }

    const singboxPath = resourceManager.getSingBoxPath();
    const confDir = getUserDataPath();
    const script = this.buildInstallScript(srcBinary, singboxPath, confDir, token);

    const result = await this.runRootScript('flowz-helper-install.sh', script);
    if (!result.success) {
      return { success: false, error: result.error, status: await this.getStatus() };
    }
    // 刚 bootstrap 过 → 作废 launchctl 探测缓存与去抖计数（TTL 内的旧 not-loaded 不应再参与判定）
    this.loadedProbe = null;
    this.firstNotLoadedAt = null;
    this.notLoadedProbes = 0;

    // 等 daemon 起来绑定 socket，再确认就绪
    let status = await this.getStatus();
    for (let i = 0; i < 10 && !status.ready; i++) {
      await new Promise((r) => setTimeout(r, 300));
      status = await this.getStatus();
    }
    if (status.ready) this.log('info', 'helper 安装并就绪');
    else this.log('warn', 'helper 已安装但未在预期内就绪');
    return { success: true, status };
  }

  /** 卸载 helper：osascript 以 root 注销 daemon 并删除文件（弹一次密码框）。 */
  async uninstall(): Promise<{ success: boolean; error?: string; status: HelperStatus }> {
    if (!this.supported) {
      return { success: false, error: '仅 macOS 支持提权 helper', status: await this.getStatus() };
    }
    const result = await this.runRootScript(
      'flowz-helper-uninstall.sh',
      this.buildUninstallScript()
    );
    if (!result.success) {
      return { success: false, error: result.error, status: await this.getStatus() };
    }
    // 已 bootout → 作废探测缓存（未安装态 loaded=null，不应复用旧值）
    this.loadedProbe = null;
    this.firstNotLoadedAt = null;
    this.notLoadedProbes = 0;
    // 清掉 app 侧 token 文件（重装会重新生成）
    try {
      fs.unlinkSync(this.tokenFilePath());
    } catch {
      /* 不存在则忽略 */
    }
    this.log('info', 'helper 已卸载');
    return { success: true, status: await this.getStatus() };
  }

  // ── 脚本生成 ─────────────────────────────────────────────────────────────
  /** 单引号包裹并转义，安全嵌入 bash。FlowZ 路径一般不含单引号，仍防御性处理。 */
  private shq(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }

  private xmlEscape(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** xmlEscape 的逆（plist 由本类生成，仅这四个实体；&amp; 最后解，避免二次替换）。 */
  private xmlUnescape(s: string): string {
    return s
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&');
  }

  /** 读已装 plist 中烧录的 --singbox 路径；不存在/解析失败返回 null（视为未知，不报 mismatch）。 */
  private installedSingboxPath(): string | null {
    try {
      const xml = fs.readFileSync(PLIST_PATH, 'utf8');
      const m = xml.match(/<string>--singbox<\/string>\s*<string>([^<]*)<\/string>/);
      return m ? this.xmlUnescape(m[1]) : null;
    } catch {
      return null;
    }
  }

  private buildInstallScript(
    srcBinary: string,
    singboxPath: string,
    confDir: string,
    token: string
  ): string {
    // plist 在 JS 侧完整成形（含转义），脚本用「带引号 heredoc」原样写出，避免 shell 二次展开。
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${this.xmlEscape(HELPER_DEST)}</string>
    <string>--singbox</string><string>${this.xmlEscape(singboxPath)}</string>
    <string>--confdir</string><string>${this.xmlEscape(confDir)}</string>
    <string>--support</string><string>${this.xmlEscape(SYSTEM_SUPPORT)}</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
</dict>
</plist>`;

    return `#!/bin/bash
set -e
umask 077
SRC=${this.shq(srcBinary)}
DEST=${this.shq(HELPER_DEST)}
SUPPORT=${this.shq(SYSTEM_SUPPORT)}
PLIST=${this.shq(PLIST_PATH)}
mkdir -p /Library/PrivilegedHelperTools "$SUPPORT"
# 关键：umask 077 会把新建目录设成 700 → 普通用户 app 无法穿越该目录连接 socket(EACCES)。
# 目录必须 755 可穿越（socket 内部仍靠 token 鉴权 + token 文件 600 保护）。
chmod 755 /Library/PrivilegedHelperTools "$SUPPORT"
cp "$SRC" "$DEST"
chown root:wheel "$DEST"; chmod 755 "$DEST"
printf '%s' ${this.shq(token)} > "$SUPPORT/helper.token"
chown root:wheel "$SUPPORT/helper.token"; chmod 600 "$SUPPORT/helper.token"
cat > "$PLIST" <<'FLOWZ_PLIST_EOF'
${plist}
FLOWZ_PLIST_EOF
chown root:wheel "$PLIST"; chmod 644 "$PLIST"
launchctl bootout system "$PLIST" 2>/dev/null || true
launchctl bootstrap system "$PLIST"
echo installed-ok
`;
  }

  private buildUninstallScript(): string {
    return `#!/bin/bash
PLIST=${this.shq(PLIST_PATH)}
launchctl bootout system "$PLIST" 2>/dev/null || true
rm -f "$PLIST" ${this.shq(HELPER_DEST)}
rm -rf ${this.shq(SYSTEM_SUPPORT)}
echo uninstalled-ok
`;
  }

  /** 写脚本到 userData 后用 osascript 以 root 执行（弹一次密码框）。用户取消(-128)与脚本失败分开判定。 */
  private runRootScript(
    name: string,
    script: string
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      let scriptPath: string;
      try {
        scriptPath = path.join(getUserDataPath(), name);
        fs.writeFileSync(scriptPath, script, { mode: 0o755 });
      } catch (e) {
        resolve({ success: false, error: e instanceof Error ? e.message : String(e) });
        return;
      }
      // 路径单引号包裹以容忍空格；FlowZ 路径不含单/双引号。
      const proc = spawn('/usr/bin/osascript', [
        '-e',
        `do shell script "/bin/bash '${scriptPath}'" with administrator privileges`,
      ]);
      let stderr = '';
      proc.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('exit', (code) => {
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* 忽略 */
        }
        if (code === 0) resolve({ success: true });
        // 用户取消授权 → osascript 报 -128 / "User canceled"；其余非零为脚本/安装失败，透传 stderr。
        else if (/-128|User canceled/i.test(stderr))
          resolve({ success: false, error: '已取消管理员授权' });
        else resolve({ success: false, error: stderr.trim() || `osascript 退出码 ${code}` });
      });
      proc.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    });
  }
}
