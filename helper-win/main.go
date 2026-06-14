//go:build windows

package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/sys/windows/svc"
)

const serviceName = "FlowZHelper"

func main() {
	var console bool
	flag.StringVar(&singboxBin, "singbox", "", "path to sing-box binary (locked at install time)")
	flag.StringVar(&confDir, "confdir", "", "allowed config directory")
	flag.StringVar(&supportDir, "support", `C:\ProgramData\FlowZ`, "dir holding helper.token + state (SYSTEM side)")
	flag.StringVar(&coreDir, "coredir", "", "accepted and ignored on Windows (mirrors macOS flag; no install-core)")
	flag.BoolVar(&console, "console", false, "run as a foreground console process (dev/test without SCM)")
	flag.Parse()

	// 确保 supportDir 存在（helper.token 落此目录）。Windows 上权限由安装期 ACL 设定（SYSTEM 私有），此处仅建目录。
	if err := os.MkdirAll(supportDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	if console {
		runConsole()
		return
	}

	// 默认：作为 SCM 服务运行。若被误以交互方式启动（非 SCM），svc.Run 返回错误 —— 退化提示用 --console。
	// （健壮起见也可用 svc.IsWindowsService 探测，这里保持显式 flag 主导，符合任务「--console 作前台 dev/测试」约定。）
	if err := runService(serviceName); err != nil {
		fmt.Fprintf(os.Stderr, "service run failed: %v (use --console to run in foreground)\n", err)
		os.Exit(1)
	}
}

// runConsole：前台普通进程跑（无 SCM 的 dev/测试）。Ctrl+C / Ctrl+Break 时先收割 child 再退出，
// 镜像 macOS main 的 SIGINT 收割器，杜绝 dev 跑测试时残留孤儿 sing-box。
func runConsole() {
	l, err := listen()
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen failed: %v\n", err)
		os.Exit(1)
	}

	sigCh := make(chan os.Signal, 1)
	// Windows 上 os/signal 将控制台 Ctrl+C → os.Interrupt(SIGINT)，Ctrl+Break → SIGBREAK。
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		reapChildOnExit()
		_ = l.Close()
		os.Exit(0)
	}()

	fmt.Printf("FlowZ helper (console) listening on %s, proto v%s\n", pipeName, protoVersion)
	serve(l) // 阻塞，直到 l.Close（由信号 goroutine 触发）
}

// 编译期断言：确保 svc 包被引用（main 的服务路径已用；此引用避免 go vet 在 --console-only 重构时误报未用导入）。
var _ = svc.Run
