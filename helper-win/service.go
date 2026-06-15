//go:build windows

// SCM（Windows 服务）托管 + 命名管道监听。二进制以 LocalSystem、auto-start 服务运行；
// 收到 SERVICE_CONTROL_STOP/SHUTDOWN 时先收割 child sing-box（reapChildOnExit，TERM→KILL 等价）再退出，
// 镜像 macOS helper.go 的 SIGTERM 收割器（proto v3），杜绝孤儿 sing-box。
package main

import (
	"net"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows/svc"
)

// 命名管道名（镜像 macOS 的 helper.sock 命名谱系，flowz-helper）。
const pipeName = `\\.\pipe\flowz-helper`

// 管道 SDDL（纵深防御；token 仍是主鉴权边界）：
//
//	D:(A;;FA;;;SY)(A;;GRGW;;;IU)
//
//	D:          DACL 起始
//	(A;;FA;;;SY)   Allow / FILE_ALL_ACCESS(FA) / SYSTEM(SY)        —— 服务本体（LocalSystem）完全控制管道
//	(A;;GRGW;;;IU) Allow / GENERIC_READ+GENERIC_WRITE / Interactive Users(IU) —— 交互登录用户可读/写/连接
//
// 选 IU（交互登录用户）而非 BU/AU：FlowZ GUI 由当前桌面登录用户运行，IU 精确覆盖「本机交互会话」，
// 不授予服务账户/远程会话/网络登录，最小化攻击面。GENERIC_READ|GENERIC_WRITE 足以连接管道并读写消息
//（命名管道客户端连接 + ReadFile/WriteFile 即需此二者），不授予 FILE_ALL_ACCESS（无需改 ACL/删管道权能）。
// 无显式 owner/group/SACL（前缀仅 D:）→ owner 默认 SYSTEM（创建者），无审计，符合纵深防御定位。
//
// 注意：DACL 一旦显式给出即「拒绝未列明者」（无隐式 Everyone）。故非交互/非 SYSTEM 进程（如远程、服务账户、
// 非交互令牌）连不上管道 —— 真机必验项：确认 FlowZ app 进程令牌带 Interactive SID（标准桌面 GUI 启动满足；
// 若 app 以计划任务/服务等非交互方式启动，需放宽到 AU/BU 或改授权 SID）。
const pipeSDDL = "D:(A;;FA;;;SY)(A;;GRGW;;;IU)"

// listen：创建 token+SDDL 双重防护的命名管道监听器。
func listen() (net.Listener, error) {
	cfg := &winio.PipeConfig{
		SecurityDescriptor: pipeSDDL,
		// MessageMode=false（字节流）：行协议按 \n 分隔，与 macOS unix socket 字节流语义一致，不依赖消息边界。
		MessageMode: false,
	}
	return winio.ListenPipe(pipeName, cfg)
}

// serve：accept 循环，每连接一个 handle goroutine（镜像 macOS main 的 for{Accept;go handle}）。
// 阻塞运行，直到 listener 被 Close（服务停止时 runService 关闭它解阻塞）。
func serve(l net.Listener) {
	for {
		conn, err := l.Accept()
		if err != nil {
			// Accept 在 listener 关闭后持续返回 err；上层（runService/console）负责关闭以退出。
			return
		}
		go handle(conn)
	}
}

// flowzService 实现 svc.Handler。
type flowzService struct{}

// Execute：SCM 调用入口。启动管道监听 + serve goroutine，主循环处理控制请求。
// STOP/SHUTDOWN → 先 reapChildOnExit（收割 child sing-box），再关 listener、回报 Stopped 退出 → 无孤儿。
func (m *flowzService) Execute(args []string, r <-chan svc.ChangeRequest, status chan<- svc.Status) (svcSpecificEC bool, exitCode uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	status <- svc.Status{State: svc.StartPending}

	l, err := listen()
	if err != nil {
		// 监听失败：直接报错退出，SCM 据 exitCode 记录失败（避免「服务在跑但不可用」的假活）。
		return false, 1
	}
	go serve(l)

	status <- svc.Status{State: svc.Running, Accepts: accepted}

	for {
		c := <-r
		switch c.Cmd {
		case svc.Interrogate:
			status <- c.CurrentStatus
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			// 先收割 child（TERM→等≤5s→KILL 等价），杜绝服务退出后 child 变 LocalSystem 孤儿继续占端口/wintun。
			reapChildOnExit()
			_ = l.Close()
			status <- svc.Status{State: svc.Stopped}
			return false, 0
		default:
			// 忽略未声明接受的控制码。
		}
	}
}

// runService：以 SCM 服务身份运行（main 在非 --console 时调用）。serviceName 仅用于 SCM 日志登记。
func runService(serviceName string) error {
	return svc.Run(serviceName, &flowzService{})
}
