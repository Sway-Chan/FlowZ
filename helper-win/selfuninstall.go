// selfUninstallCmdLine 与其单测**无 build tag**（纯字符串逻辑、不引 windows 包），故能在非 Windows CI 上跑：
// 这正是先前缺 Go 侧命令行测试、令 cmd 引号 bug 溜过 review 的补强点。其余 helper-win 文件均 //go:build windows。
package main

import (
	"strings"
	"unicode"
)

// selfUninstallCmdLine 构造自卸载旁路的完整命令行（供 spawnSelfUninstall 经 SysProcAttr.CmdLine **原样**下发）。
//
// 为何手工拼 CmdLine 而非 exec.Command("cmd","/c",script)：
//
//	后者经 Go syscall.EscapeArg 把内层 `"` 转义成 `\"`，而 cmd.exe 不识别 `\"` 反转义。命令行含 >2 个引号且夹
//	`&`/`>` 等特殊字符 → cmd 的 /c 走「strip 首尾各一个引号」规则；转义版剥壳后 rmdir 收到 `\"C:\ProgramData\FlowZ\"`
//	→ 实际路径多出前导反斜杠 `\C:\...\` → 语法非法、目录删不掉（外置 helper.exe + token 残留，自卸载白做）。
//	手工 CmdLine 绕开 EscapeArg、写**真双引号**：同样经 strip 首尾后，内层真引号原样保留 → rmdir 收到合法的
//	"C:\ProgramData\FlowZ"。
//
// 前置假设：serviceName / supportDir 非攻击者可控（serviceName 为常量；supportDir 为安装期固定的 SUPPORT_DIR，
// 无引号/cmd 元字符）。若未来 --support 变为可达输入，须先校验/转义其 cmd 元字符——本旁路以 SYSTEM 执行，注入即提权。
func selfUninstallCmdLine(serviceName, supportDir string) string {
	// 纵深防御：本旁路以 SYSTEM 执行 cmd /c。supportDir 当前为安装期固定常量（非可达输入），但若未来
	// --support 变可达，须防 cmd 元字符（" & | < > % ^）注入即提权。校验不过则用安全占位（rmdir 落空，不注入）。
	if !isSafeSupportDir(supportDir) {
		supportDir = `C:\FlowZ\safe-placeholder-nonexistent`
	}
	rmdir := `rmdir /s /q "` + supportDir + `"`
	// 顺序：等 helper 退出解锁 exe → 停服务 → 删服务 → 再等一拍让 SCM 反映 → 删目录（含 exe 自身）→ 兜底再删一次。
	script := strings.Join([]string{
		"ping 127.0.0.1 -n 3 >nul",
		"sc stop " + serviceName + " >nul 2>&1",
		"sc delete " + serviceName + " >nul 2>&1",
		"ping 127.0.0.1 -n 2 >nul",
		rmdir + " >nul 2>&1",
		rmdir + " >nul 2>&1",
	}, " & ")
	return `cmd /c "` + script + `"`
}

// isSafeSupportDir：supportDir 仅允许路径安全字符（字母数字 : \ / . _ - 与空格）。
// 命中 cmd 元字符（" & | < > % ^ 等）即判不安全 → selfUninstallCmdLine 改用占位路径，关闭 SYSTEM 注入窗口。
func isSafeSupportDir(p string) bool {
	if p == "" {
		return false
	}
	for _, c := range p {
		ok := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			c == ':' || c == '\\' || c == '/' || c == '.' || c == '_' || c == '-' || c == ' ' ||
			unicode.IsLetter(c) // 允许中文等 Unicode 字母路径（cmd 元字符 & | < > " % ^ 仍被拒）
		if !ok {
			return false
		}
	}
	return true
}
