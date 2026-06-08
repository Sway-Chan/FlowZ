# FlowZ

原作者大佬开源地址：https://github.com/zhangjh/FlowZ

简洁现代的跨平台代理客户端，基于 sing-box 核心。  
支持 NaïveProxy、VLESS、VMess、Trojan、Shadowsocks、Hysteria2、Anytls、TUIC、Shadows-tls 协议。  

主打：

- 配置简单
- 规则明确
- 所见即所得
- 稳定好用

---

## ✨ 功能特性

- ✅ 支持 NaïveProxy、VLESS、VMess、Trojan、Hysteria2、Shadowsocks、Anytls、TUIC、Shadows-tls协议等。
- ✅ 强大的路由规则系统（支持 geosite / geoip 规则集）
- ✅ 多种代理模式（全局 / 智能 / 直连）
- ✅ 应用分流策略组模块
- ✅ 支持订阅链接
- ✅ TUN 透明代理模式（支持 System / gVisor / Mixed 堆栈）
- ✅ 系统级代理自动接管
- ✅ 支持仅本地代理模式
- ✅ 实时流量统计与测速
- ✅ 支持前置代理，完美实现代理链功能
- ✅ 亮色 / 暗色主题切换
- ✅ 开机自启动与自动连接
- ✅ 现代化 UI（基于 shadcn/ui）
- ✅ 支持连接拓扑展示功能
- ✅ 支持隐私保护模式
- ✅ 支持排除进程代理模式
- ✅ 跨平台支持（Windows / macOS / Linux（测试））
- ✅ 支持中英文语言切换
- ✅ 无缝切换节点（selector + clash_api 热切换，默认优雅不断流；可选「切换时中断现有连接」）
- ✅ Block QUIC（节点无关：reject 代理向 QUIC/UDP 443、逼浏览器回退 TCP，解决节点 UDP relay 不通导致的网页卡顿）
- ✅ 抗封增强：TLS Fragment（全局）/ ECH / Multiplex / httpupgrade / Hysteria2 端口跳跃（订阅自动识别，部分提供手动开关）
---

## 🖼 界面预览

<img src="https://cdn.nodeimage.com/i/YvkiEO6sI7ex8UzWTGobq2U3UCwo7pnv.webp" alt="YvkiEO6sI7ex8UzWTGobq2U3UCwo7pnv.webp">
<img src="https://cdn.nodeimage.com/i/JjgOVR72FVDe8IdenWOvQgYmRmy3XljX.webp" alt="JjgOVR72FVDe8IdenWOvQgYmRmy3XljX.webp">
<img src="https://cdn.nodeimage.com/i/OkMsmCuA4kTzOxpUfI5kbHrctJgou781.webp" alt="OkMsmCuA4kTzOxpUfI5kbHrctJgou781.webp">
<img src="https://cdn.nodeimage.com/i/ZfewzdJUYN3wkLbLL3DieXND5DD63lhT.webp" alt="ZfewzdJUYN3wkLbLL3DieXND5DD63lhT.webp">
<img src="https://cdn.nodeimage.com/i/7Th2DdFQ52V3xNg67ecS88zOfqV5KWJ1.webp" alt="7Th2DdFQ52V3xNg67ecS88zOfqV5KWJ1.webp">
<img src="https://cdn.nodeimage.com/i/eF2PxEG9figyhXJe6EqRbu7TtcucVDLH.webp" alt="eF2PxEG9figyhXJe6EqRbu7TtcucVDLH.webp">
<img src="https://cdn.nodeimage.com/i/ihpRZpWuW3MgQR8kkEKmZl2u6ANrXXcw.webp" alt="ihpRZpWuW3MgQR8kkEKmZl2u6ANrXXcw.webp">
<img src="https://cdn.nodeimage.com/i/sicWxjH9z3ZyVFWPEDNYvYWl0cYMASdR.webp" alt="sicWxjH9z3ZyVFWPEDNYvYWl0cYMASdR.webp">
<img src="https://cdn.nodeimage.com/i/CyL0QX2SvBCPZxonMkVws5pSPGpNtPVm.webp" alt="CyL0QX2SvBCPZxonMkVws5pSPGpNtPVm.webp">

---

## 📋 系统要求

- Windows 10 (1809+) 或 Windows 11
- macOS 12+

---

## 📥 安装

从 Releases 页面下载最新版本。

### Windows
运行 `.exe` 安装包

### macOS (Apple Silicon)
打开 `.dmg` 并拖入 Applications

### macOS (Intel)
需要从源码构建

若 macOS 提示“软件已损坏”：

```bash
xattr -cr /Applications/FlowZ.app
```

---

## 🛠 从源码构建

```bash
git clone https://github.com/zhangjh/FlowZ.git
cd FlowZ

npm install
npm run dev
npm run build
npm run package:win
npm run package:mac
```

macOS Intel 用户需要修改 `electron-builder.json`：

```json
"arch": ["x64"]
```

---

## 🚀 快速开始

### 1. 配置服务器

- 打开应用 → 服务器标签
- 选择协议
- 填写服务器信息
- 保存配置

### 2. 启用代理

- 返回首页
- 点击“启用代理”

### 3. 选择代理模式

默认使用 代理 模式。

可选模式：

- 全局模式：所有流量走代理
- 智能模式：自动分流（推荐）
- 直连模式：不使用代理

如不希望使用 TUN，可在设置中切换为“系统代理模式”。

---

## 🛡 抗封 / 切换 / NaiveProxy 说明

### 无缝切换节点
默认采用 **selector + clash_api 热切换**：切换节点不重启核心、现有连接保留至自然关闭，新连接走新节点（优雅不断流）。高级设置中的「**切换时中断现有连接**」开关（默认关）开启后，切换会强制断开现有连接、立即在新节点重建。跨模式/端口/TUN/规则等改动仍会重启以应用。

### Block QUIC（高级设置）
开启后对**代理向的 QUIC（UDP 443）**执行 reject、逼浏览器回退 TCP，解决「节点 UDP relay 不通导致网页卡顿/断流」。**节点无关**，对所有协议一视同仁；hysteria2/tuic/naive 等以 QUIC 拨号的节点其**自身拨号不受影响**（受 fwmark 保护）。默认关。

### 抗封增强
- **TLS Fragment**（高级设置全局开关）：切分 TLS ClientHello，规避基于 SNI 关键词的 DPI 阻断。对所有 TCP-TLS 节点生效；hysteria2/tuic/naive 自动排除（其 TLS 不在 TCP 层）。
- **ECH / Multiplex / httpupgrade / Hysteria2 端口跳跃**：从 **sing-box JSON 订阅自动识别并生效**（Multiplex 对 reality+vision 节点自动跳过；端口跳跃支持多段范围）。

### ⚠️ NaiveProxy（naive）核心库说明
naive 出站底层走 **Chromium 的 Cronet 网络库** 以获得与浏览器一致的指纹。各平台链接方式不同：

- **Linux / Windows**：cronet 走**动态库**（`libcronet.so` / `libcronet.dll`），需与核心同目录。打包时由 `npm run fetch:cronet` 从 [SagerNet/cronet-go](https://github.com/SagerNet/cronet-go/releases) 拉取并随安装包打入（体积大，不入库、CI/打包时拉取）。
- **macOS（Apple Silicon / arm64）**：cronet **静态编入** sing-box 核心二进制，naive **开箱即用、无需任何外部库**。
- **macOS（Intel / x64）**：当前打包的 x64 核心**未编入 cronet** → naive 暂不可用（需重新构建带 naive 支持的 x64 核心）。

> 在缺少 cronet 的平台/架构上，naive 节点会被**自动跳过**（不影响其它协议节点；若选中的正是 naive 节点会给出明确提示）。

---

## 🔧 技术栈

- Electron
- React 18 + TypeScript
- sing-box
- Tailwind CSS
- shadcn/ui

---

## 📄 开源协议

MIT License

---

## ⚠️ 免责声明

本软件仅供学习与研究使用。  
请遵守当地法律法规。  
使用本软件所产生的任何后果由使用者自行承担。

---

## ⭐ Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=dododook/FlowZ&type=Date)](https://star-history.com/#dododook/FlowZ&Date)
