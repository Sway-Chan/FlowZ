/**
 * WindowsServiceHelper 纯逻辑单测（无 Windows 机/无命名管道）：
 *  - 平台门控：非 win32 安全降级（supported=false / ready=false），绝不触发 SCM/管道。
 *  - 提权脚本生成（runtime 最脆点）：sc create/start、binPath 锁定 exe+flags、token ACL、卸载脚本。
 *  - PowerShell 单引号转义。
 * 真机行为（UAC、sc 引号语义、管道连通）属 Windows 真机必验清单，不在单测范围。
 */
import { WindowsServiceHelper } from '../WindowsServiceHelper';

describe('WindowsServiceHelper', () => {
  describe('非 Windows 平台安全降级', () => {
    // 测试宿主为 Linux（process.platform !== 'win32'）→ 所有方法降级，不连 SCM/管道。
    const helper = new WindowsServiceHelper();

    it('getStatus 返回 supported=false 的空状态', async () => {
      const s = await helper.getStatus();
      expect(s.supported).toBe(false);
      expect(s.installed).toBe(false);
      expect(s.ready).toBe(false);
      expect(s.needsRepair).toBe(false);
      expect(s.backgroundDisabled).toBe(false);
      expect(s.pathMismatch).toBe(false);
      expect(s.loaded).toBeNull();
    });

    it('isReady 返回 false（不尝试连接管道）', async () => {
      await expect(helper.isReady()).resolves.toBe(false);
    });

    it('install/uninstall 在非 Windows 报「仅 Windows 支持」', async () => {
      const i = await helper.install();
      expect(i.success).toBe(false);
      expect(i.error).toContain('Windows');
      const u = await helper.uninstall();
      expect(u.success).toBe(false);
      expect(u.error).toContain('Windows');
    });
  });

  describe('提权脚本生成', () => {
    const helper = new WindowsServiceHelper() as unknown as {
      buildInstallScript(exe: string, sb: string, conf: string, token: string): string;
      buildUninstallScript(): string;
      psq(s: string): string;
    };

    it('psq 转义单引号（PowerShell 双写规则）', () => {
      expect(helper.psq("a'b")).toBe("a''b");
      expect(helper.psq('plain')).toBe('plain');
    });

    it('install 脚本锁定 exe + flags、设 token ACL、sc create LocalSystem auto-start', () => {
      const script = helper.buildInstallScript(
        'C:\\Program Files\\FlowZ\\com.flowz.helper.exe',
        'C:\\Program Files\\FlowZ\\sing-box.exe',
        'C:\\Users\\doveh\\AppData\\Roaming\\FlowZ',
        'deadbeefdeadbeef'
      );
      // sc create：锁定 binPath（exe + 三参），auto-start，LocalSystem
      expect(script).toContain('sc.exe create FlowZHelper binPath=');
      expect(script).toContain('--singbox');
      expect(script).toContain('--confdir');
      expect(script).toContain('--support');
      expect(script).toContain('start= auto');
      expect(script).toContain('obj= LocalSystem');
      expect(script).toContain('com.flowz.helper.exe');
      expect(script).toContain('sing-box.exe');
      // 启动服务
      expect(script).toContain('sc.exe start FlowZHelper');
      // 幂等：重装先停删旧服务
      expect(script).toContain('sc.exe stop FlowZHelper');
      expect(script).toContain('sc.exe delete FlowZHelper');
      // token ACL：去继承 + 仅 SYSTEM/Administrators 读
      expect(script).toContain('icacls');
      expect(script).toContain('/inheritance:r');
      expect(script).toContain('SYSTEM:(R)');
      expect(script).toContain('Administrators:(R)');
      // token 值写入
      expect(script).toContain('deadbeefdeadbeef');
      // 受保护目录（默认 ProgramData\FlowZ）
      expect(script).toContain('FlowZ');
    });

    it('uninstall 脚本停 + 删服务 + 清受保护目录', () => {
      const script = helper.buildUninstallScript();
      expect(script).toContain('sc.exe stop FlowZHelper');
      expect(script).toContain('sc.exe delete FlowZHelper');
      expect(script).toContain('Remove-Item');
      expect(script).toContain('FlowZ');
    });
  });
});
