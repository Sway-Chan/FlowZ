// 无 build tag：在 Linux CI 上即可跑（验证自卸载旁路命令行的 cmd 引号正确性——HIGH bug 的回归护栏）。
package main

import "strings"
import "testing"

func TestSelfUninstallCmdLine(t *testing.T) {
	cl := selfUninstallCmdLine("FlowZHelper", `C:\ProgramData\FlowZ`)

	// 必须用**真双引号**包裹 rmdir 路径（非 EscapeArg 的 \"…\"）：cmd 不识别 \" 反转义，转义版会令 rmdir 收到
	// 非法路径 \C:\…\ → 目录删不掉。断言出现真引号、且绝不出现反斜杠转义引号。
	if !strings.Contains(cl, `rmdir /s /q "C:\ProgramData\FlowZ"`) {
		t.Fatalf("rmdir 路径未用真双引号包裹: %q", cl)
	}
	if strings.Contains(cl, `\"`) {
		t.Fatalf("命令行含 \\\" 转义引号（cmd 不反转义→路径非法）: %q", cl)
	}

	// 整行经 cmd /c 包裹（首尾真引号）：cmd strip 首尾各一引号后内层真引号原样存活。
	if !strings.HasPrefix(cl, `cmd /c "`) || !strings.HasSuffix(cl, `"`) {
		t.Fatalf("未用 cmd /c \"…\" 包裹: %q", cl)
	}

	// 停服务在删服务前、删服务在 rmdir 前（sc delete 要服务先停；rmdir 要 exe 先随 helper 退出解锁）。
	iStop := strings.Index(cl, "sc stop FlowZHelper")
	iDel := strings.Index(cl, "sc delete FlowZHelper")
	iRmdir := strings.Index(cl, "rmdir")
	if iStop < 0 || iDel < 0 || iRmdir < 0 || !(iStop < iDel && iDel < iRmdir) {
		t.Fatalf("命令顺序应为 stop→delete→rmdir: stop=%d del=%d rmdir=%d (%q)", iStop, iDel, iRmdir, cl)
	}

	// rmdir 出现两次（解锁竞态兜底）；删目录前有 ping 延迟（等 exe 解锁，DETACHED 下不能用 timeout）。
	if strings.Count(cl, "rmdir /s /q") != 2 {
		t.Fatalf("rmdir 应出现两次（兜底）: %q", cl)
	}
	if !strings.Contains(cl, "ping 127.0.0.1") {
		t.Fatalf("缺 ping 延迟: %q", cl)
	}
}

// 服务名/路径含空格时仍正确包裹（虽默认无空格，验证不退化）。
func TestSelfUninstallCmdLineSpacedPath(t *testing.T) {
	cl := selfUninstallCmdLine("FlowZHelper", `C:\Program Data\FlowZ`)
	if !strings.Contains(cl, `rmdir /s /q "C:\Program Data\FlowZ"`) {
		t.Fatalf("含空格路径未用真双引号包裹: %q", cl)
	}
	if strings.Contains(cl, `\"`) {
		t.Fatalf("含空格路径出现转义引号: %q", cl)
	}
}

// 恶意 supportDir（含 cmd 元字符）走安全占位，关闭 SYSTEM 注入窗口。
func TestSelfUninstallCmdLineUnsafePath(t *testing.T) {
	cl := selfUninstallCmdLine("FlowZHelper", `C:\evil & calc.exe`)
	// 原恶意片段不得出现在最终命令行（防 & 触发 cmd 注入即提权）。
	if strings.Contains(cl, `evil & calc`) {
		t.Fatalf("恶意 supportDir 未被占位替换，注入面仍开: %q", cl)
	}
	if !strings.Contains(cl, `safe-placeholder-nonexistent`) {
		t.Fatalf("恶意路径应改用安全占位: %q", cl)
	}
}

// isSafeSupportDir 边界用例。
func TestIsSafeSupportDir(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{`C:\ProgramData\FlowZ`, true},
		{`C:\Program Data\FlowZ`, true}, // 空格允许
		{``, false},
		{`C:\evil & calc`, false}, // &
		{`C:\x"y`, false},         // 引号
		{`C:\a|b`, false},         // 管道
		{`D:/path`, true},         // 正斜杠允许
		{`C:\应用\FlowZ`, true},   // 中文 Unicode 允许
	}
	for _, c := range cases {
		if got := isSafeSupportDir(c.in); got != c.want {
			t.Errorf("isSafeSupportDir(%q)=%v, want %v", c.in, got, c.want)
		}
	}
}
