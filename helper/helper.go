// FlowZ 提权 helper（生产版）：root LaunchDaemon，监听 token 鉴权的 unix socket，按行协议驱动 sing-box 启停。
// 装一次（osascript 一次授权）后，普通用户 app 经 socket 零提权启停 sing-box —— 切节点/停止/退出/崩溃回收均免再次授权。
//
// 安全边界：
//   - token：仅 root 可读的 helper.token(600)，app 持自身副本鉴权；socket 为 0666，故 token 是主边界。
//   - sing-box 二进制路径在安装时由 --singbox 锁定（改它需 root），客户端不可指定 → 杜绝「持 token 跑任意二进制」。
//   - 配置文件必须落在 --confdir（app 数据目录）内，拒绝越权路径。
//   残余风险：能读到 app 配置目录内 token 的同用户进程可驱动本 helper（FlowZ 未签名，无法做 SMJobBless 客户端校验）。
//     此为「未签名应用 + 免提权 helper」的固有取舍；token + 二进制锁定 + 配置目录约束为现实可行的缓解。
//
// 协议（每行以 \n 结尾，路径整行传递 → 容忍含空格的路径，如 "Application Support/FlowZ"）：
//   行1: <token>
//   行2: <command>           ping | version | start | stop | status
//   start 追加: 行3=<cfg> 行4=<log，可空> 行5=<fwd: 0|1> 行6=<父appPID，可选；缺失/空=不启父死看护（兼容旧客户端）>
//
// 仅依赖 Go 标准库（无第三方依赖，便于交叉编译与审计）。
package main

import (
	"bufio"
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// 协议版本：app 经 `version` 命令读取，与内置期望值不符则提示「修复/重装 helper」。
// v2：start 追加可选父 PID 行（父死看护）+ stop 升级 TERM→等≤5s→KILL。bump → 已装 v1 的机器 needsRepair → 重装一次。
const protoVersion = "2"

var (
	singboxBin string // 安装时锁定的 sing-box 路径
	confDir    string // 允许的配置文件目录
	supportDir string // socket + token 所在目录

	mu        sync.Mutex
	child     *exec.Cmd
	childDone chan struct{} // 与 child 同生命周期：start 时创建，c.Wait() 收割后 close；摘除 child 时同步置 nil
)

func tokenValue() string {
	b, _ := os.ReadFile(filepath.Join(supportDir, "helper.token"))
	return strings.TrimSpace(string(b))
}

func readLine(r *bufio.Reader) string {
	s, _ := r.ReadString('\n')
	return strings.TrimRight(s, "\r\n")
}

// cfg 必须位于 confDir 内（清洗后前缀匹配），防止越权指定任意路径作 root 配置。
func cfgAllowed(cfg string) bool {
	if confDir == "" {
		return true
	}
	clean := filepath.Clean(cfg)
	base := filepath.Clean(confDir) + string(os.PathSeparator)
	return strings.HasPrefix(clean, base)
}

// TERM→等≤5s→KILL 收割 child：先给 sing-box 优雅窗口（拆 utun/路由/DNS），超时未退则强杀。
// 必须不持 mu 调用（最长阻塞 5s，持锁会饿死所有 socket 命令），且调用方须先在持锁状态把 child 摘成 nil（收割权独占）。
// 实际信号只经 c.Process 发出：Wait() 收割后 Signal/Kill 返回 ErrProcessDone 不发信号 → 天然防 PID 复用误杀。
func terminateChild(c *exec.Cmd, done <-chan struct{}) {
	if c == nil || c.Process == nil {
		return
	}
	_ = c.Process.Signal(syscall.SIGTERM)
	select {
	case <-done: // 已被 Wait 收割（优雅退出），免 KILL
	case <-time.After(5 * time.Second):
		_ = c.Process.Kill() // SIGKILL；若恰已退出则 ErrProcessDone，无害
	}
}

// 父死看护：托管 child 期间每秒探测父 app 进程，父消失（GUI 崩溃/kill -9/强退 —— socket stop 够不到的场景）
// → TERM→KILL 收割 child。对齐旧 osascript 看护脚本「父进程死亡→不留孤儿」不变量（修复设计根因 B）。
// 退出条件（防 goroutine 泄漏）：child 正常退出（done 关闭）/ 被 stop·cleanup·新 start 摘除（child != c）/ 父死收割完成。
func watchParent(ppid int, c *exec.Cmd, done <-chan struct{}) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-done:
			return // child 已退出，看护使命结束
		case <-t.C:
		}
		mu.Lock()
		current := child == c
		mu.Unlock()
		if !current {
			return // 已被 stop/cleanup 摘除或被新 start 替换，收割责任已转移
		}
		// kill(ppid,0) 只判存活不发信号：ESRCH=父已死。其余错误（root 不应见 EPERM）按存活处理，宁漏勿误。
		if err := syscall.Kill(ppid, 0); err == syscall.ESRCH {
			mu.Lock()
			if child != c { // 与 stop 竞态：他人已摘除则由他收割
				mu.Unlock()
				return
			}
			child, childDone = nil, nil
			mu.Unlock()
			terminateChild(c, done)
			return
		}
	}
}

func handle(conn net.Conn) {
	defer conn.Close()
	// 读超时：防止无 token 进程连上后不发数据耗尽 fd/goroutine，或持 token 客户端发一半卡死、
	// 在 mu.Lock() 之后阻塞读 → 永久持锁拖垮整个 helper。
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	r := bufio.NewReader(conn)
	tok := readLine(r)
	cmd := readLine(r)
	if tok == "" || tok != tokenValue() {
		fmt.Fprintln(conn, "ERR auth")
		return
	}

	mu.Lock()
	defer mu.Unlock()

	switch cmd {
	case "ping":
		fmt.Fprintf(conn, "OK pong uid=%d v%s\n", os.Getuid(), protoVersion)
	case "version":
		fmt.Fprintf(conn, "OK %s\n", protoVersion)
	case "status":
		if child != nil && child.Process != nil {
			fmt.Fprintf(conn, "OK running %d\n", child.Process.Pid)
		} else {
			fmt.Fprintln(conn, "OK stopped")
		}
	case "stop":
		if child != nil && child.Process != nil {
			pid := child.Process.Pid
			c, done := child, childDone
			child, childDone = nil, nil
			// TERM→等≤5s→KILL 放后台：本 handle 持着 mu，同步等待会饿死并发 ping/status，
			// 且客户端 stop 超时仅 3-5s。摘除 child 后由该 goroutine 独占收割权（watchParent 见 child!=c 即退）。
			go terminateChild(c, done)
			fmt.Fprintf(conn, "OK stopped %d\n", pid)
		} else {
			fmt.Fprintln(conn, "OK notrunning")
		}
	case "cleanup":
		// 以 root 杀掉所有「<锁定的 singbox> run …」进程，含外部 osascript 路径遗留的孤儿，让 app 免 osascript 清理。
		// pattern 含 " run"：只匹配真正运行的 sing-box，不会误杀 argv 为「--singbox <path>」的本 daemon。
		_ = exec.Command("/usr/bin/pkill", "-9", "-f", singboxBin+" run").Run()
		child, childDone = nil, nil
		fmt.Fprintln(conn, "OK cleaned")
	case "start":
		cfg := readLine(r)
		logPath := readLine(r)
		fwd := readLine(r)
		// 行6（可选）：父 app PID。旧客户端只发 5 行后即 FIN，此处读到 ""（EOF 不阻塞）→ ppid=0 → 不启看护。
		// 恶意 ppid 无安全增量：看护只会提前杀自家 child，与持 token 者本就有的 stop 权能等价。
		ppid, _ := strconv.Atoi(readLine(r))
		if child != nil && child.Process != nil {
			fmt.Fprintf(conn, "OK already %d\n", child.Process.Pid)
			return
		}
		if cfg == "" {
			fmt.Fprintln(conn, "ERR no-config")
			return
		}
		if !cfgAllowed(cfg) {
			fmt.Fprintln(conn, "ERR config-path-denied")
			return
		}
		// allowLan：开启 IP 转发（macOS 键名，与 Linux 不同）
		if fwd == "1" {
			_ = exec.Command("/usr/sbin/sysctl", "-w", "net.inet.ip.forwarding=1").Run()
			_ = exec.Command("/usr/sbin/sysctl", "-w", "net.inet6.ip6.forwarding=1").Run()
		}
		c := exec.Command(singboxBin, "run", "-c", cfg)
		// sing-box 早期 stdout/stderr 重定向到 app 日志文件（与 osascript 看护脚本一致），便于诊断启动问题。
		var logFile *os.File
		if logPath != "" {
			if lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
				logFile = lf
				c.Stdout = lf
				c.Stderr = lf
			}
		}
		if err := c.Start(); err != nil {
			if logFile != nil {
				logFile.Close()
			}
			fmt.Fprintf(conn, "ERR start %v\n", err)
			return
		}
		// 子进程已在 Start 时 dup 该 fd；父进程（常驻 daemon）立即关副本，避免每次启停泄漏 fd。
		if logFile != nil {
			logFile.Close()
		}
		child = c
		done := make(chan struct{})
		childDone = done
		go func() {
			_ = c.Wait()
			close(done) // 广播子进程已被收割：terminateChild 据此免 KILL、watchParent 据此退出
			mu.Lock()
			if child == c {
				child, childDone = nil, nil
			}
			mu.Unlock()
		}()
		// 父死看护（proto v2）：覆盖 GUI 崩溃/kill -9 后 stopCore 够不到的孤儿场景。
		if ppid > 0 {
			go watchParent(ppid, c, done)
		}
		fmt.Fprintf(conn, "OK started %d\n", c.Process.Pid)
	default:
		fmt.Fprintln(conn, "ERR unknown")
	}
}

func main() {
	flag.StringVar(&singboxBin, "singbox", "", "path to sing-box binary (locked at install time)")
	flag.StringVar(&confDir, "confdir", "", "allowed config directory")
	flag.StringVar(&supportDir, "support", "/Library/Application Support/FlowZ", "dir holding helper.sock + helper.token")
	flag.Parse()

	if err := os.MkdirAll(supportDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// 纵深防御：MkdirAll 对已存在目录不改权限；确保 supportDir 可被普通用户穿越（否则 app 连 socket EACCES）。
	_ = os.Chmod(supportDir, 0o755)
	sockPath := filepath.Join(supportDir, "helper.sock")
	_ = os.Remove(sockPath)
	l, err := net.Listen("unix", sockPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	_ = os.Chmod(sockPath, 0o666) // token 为安全边界

	for {
		conn, err := l.Accept()
		if err != nil {
			continue
		}
		go handle(conn)
	}
}
