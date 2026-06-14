/**
 * 速度测试服务（真实测速）：**所有协议**统一经临时 sing-box 的各自 HTTP 代理出口、GET generate_204 测 urltest TTFB，
 * 验证完整链路（连接+鉴权+中继+响应），等价 mihomo/clash 的 `/proxies/{name}/delay`。
 * 关键:端口通≠代理可用——裸 TCP ping 只测到入口的 RTT、测不出鉴权/协议/中继失败,故不再用于真实测速。
 *
 * 出站由 index.ts 注入 ProxyManager.buildSpeedTestOutbound 构造（全协议）。未注入（单测/兜底）时退回旧的 TCP ping + UDP 代理拆分。
 */

import * as net from 'net';
import * as http from 'http';
import * as tls from 'tls';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn, ChildProcess } from 'child_process';
import type { ServerConfig } from '../../shared/types';
import type { LogManager } from './LogManager';
import { resourceManager } from './ResourceManager';
import { getUserDataPath } from '../utils/paths';
import { resolveSpeedTestTarget, type SpeedTestTarget } from '../../shared/speed-test';

/** 基于 UDP/QUIC 的协议，需要走真实代理测速 */
const UDP_PROTOCOLS = new Set(['hysteria2', 'tuic']);

export interface SpeedTestResult {
  serverId: string;
  latency: number | null; // null 表示超时或失败
  error?: string;
}

export class SpeedTestService {
  private logManager: LogManager;
  private readonly MAX_CONCURRENT = 5; // TCP 并发数（仅兜底裸 ping 路径）
  /** 经代理 urltest 的预热/正式测速并发上限：大订阅时分波，避免 N 路握手同时打出→请求风暴假超时。
   *  小订阅(≤此值)等价全并行、零额外延迟；32=轻量 204 + sing-box 惰性拨号下的舒适区。 */
  private static readonly PROXY_TEST_CONCURRENCY = 32;
  /**
   * 出站构造器（由 index.ts 注入 ProxyManager.buildSpeedTestOutbound）：注入后**所有协议**统一走「临时 sing-box
   * 经代理 urltest」真实测速（端口通≠代理可用，裸 TCP ping 测不出鉴权/中继失败）；返回 null=该节点不可用（如 naive
   * 缺 libcronet）→ 跳过。未注入（兜底/单测）时退回旧的 TCP ping + UDP 代理拆分。
   */
  private buildOutboundFn?: (server: ServerConfig, tag: string) => Record<string, unknown> | null;

  /** 进行中的测速 Promise：双入口（UI/托盘）并发时复用同一次测速，避免起两个临时 sing-box（端口/资源冲突）。
   *  第二个调用方等待同一份最终结果（不收流式 onResult，末尾 results 同步覆盖即可）。 */
  private currentTest: Promise<Map<string, number | null>> | null = null;

  constructor(
    logManager: LogManager,
    buildOutboundFn?: (server: ServerConfig, tag: string) => Record<string, unknown> | null
  ) {
    this.logManager = logManager;
    this.buildOutboundFn = buildOutboundFn;
  }

  /**
   * 测试所有服务器（混合策略）。
   * @param onResult 可选逐节点回调：每测完一个节点即回传（serverId, latency），供 UI 流式增量显示
   *   （惰性、谁有结果谁先显示，等价 mihomo）。不传则仅在末尾用返回的 Map 一次性更新。
   */
  async testAllServers(
    servers: ServerConfig[],
    onResult?: (serverId: string, latency: number | null) => void,
    onProgress?: (tested: number, ok: number, total: number) => void,
    testUrl?: string
  ): Promise<Map<string, number | null>> {
    if (servers.length === 0) {
      return new Map();
    }
    // 双入口（UI/托盘）并发复用同一次测速，避免起两个临时 sing-box（端口/资源冲突）。
    // second caller 拿同一份 final results，但其 onResult/onProgress 不触发（流式只由 first caller 驱动）；
    // 可接受：数据最终正确，且 EVENT_SPEED_TEST_RESULT/PROGRESS 是 IPC broadcast，second caller 的 renderer
    // 订阅仍能收到 first caller 推的事件（latencyMap/进度照常更新）。
    if (this.currentTest) return this.currentTest;
    this.currentTest = this.doTestAllServers(servers, onResult, onProgress, testUrl).finally(() => {
      this.currentTest = null;
    });
    return this.currentTest;
  }

  private async doTestAllServers(
    servers: ServerConfig[],
    onResult?: (serverId: string, latency: number | null) => void,
    onProgress?: (tested: number, ok: number, total: number) => void,
    testUrl?: string
  ): Promise<Map<string, number | null>> {
    // 生产路径（注入了出站构造器）：**所有协议**统一走临时 sing-box 经代理 urltest，真实测速。
    if (this.buildOutboundFn) {
      this.logManager.addLog(
        'info',
        `开始测速: ${servers.length} 个节点（经代理 urltest）`,
        'SpeedTest'
      );
      const results = await this.testServersViaProxy(servers, onResult, onProgress, testUrl);
      const ok = [...results.values()].filter((v) => v !== null).length;
      // 仅汇总，不逐节点列明（结果由 UI 节点延迟徽标承载）。
      this.logManager.addLog('info', `测速完成：成功 ${ok}/${servers.length}`, 'SpeedTest');
      return results;
    }

    // 兜底路径（未注入构造器，如单测）：旧的 TCP 裸 ping + UDP 代理拆分。
    const tcpServers = servers.filter((s) => !UDP_PROTOCOLS.has(s.protocol.toLowerCase()));
    const udpServers = servers.filter((s) => UDP_PROTOCOLS.has(s.protocol.toLowerCase()));
    const results = new Map<string, number | null>();
    const [tcpResults, udpResults] = await Promise.all([
      this.testTcpServers(tcpServers, onResult),
      udpServers.length > 0
        ? this.testServersViaProxy(udpServers, onResult, undefined, testUrl)
        : new Map<string, number | null>(),
    ]);
    for (const [id, latency] of tcpResults) results.set(id, latency);
    for (const [id, latency] of udpResults) results.set(id, latency);
    this.logManager.addLog('info', '测速完成', 'SpeedTest');
    return results;
  }

  // ═══════════════════════════════════════════════════════════════
  //  TCP Ping（原有逻辑，保持不变）
  // ═══════════════════════════════════════════════════════════════

  private async testTcpServers(
    servers: ServerConfig[],
    onResult?: (serverId: string, latency: number | null) => void
  ): Promise<Map<string, number | null>> {
    const results = new Map<string, number | null>();
    if (servers.length === 0) return results;

    for (let i = 0; i < servers.length; i += this.MAX_CONCURRENT) {
      const batch = servers.slice(i, i + this.MAX_CONCURRENT);
      const batchResults = await Promise.all(batch.map((server) => this.testTcpServer(server)));

      batchResults.forEach((result) => {
        results.set(result.serverId, result.latency);
        onResult?.(result.serverId, result.latency);
        if (result.error) {
          this.logManager.addLog(
            'warn',
            `测速失败 ${result.serverId}: ${result.error}`,
            'SpeedTest'
          );
        }
      });
    }

    return results;
  }

  /**
   * 测试单个服务器 (TCP Ping)
   */
  private async testTcpServer(server: ServerConfig): Promise<SpeedTestResult> {
    const start = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new net.Socket();
        const timeout = 5000; // 5秒超时

        socket.setTimeout(timeout);

        socket.on('connect', () => {
          socket.destroy();
          resolve();
        });

        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('Timeout'));
        });

        socket.on('error', (err) => {
          socket.destroy();
          reject(err);
        });

        // 如果是 IPv6 且带有中括号，去除中括号以供 net.Socket 使用
        const isIpv6 = server.address.includes(':');
        const connectAddress =
          isIpv6 && server.address.startsWith('[') && server.address.endsWith(']')
            ? server.address.slice(1, -1)
            : server.address;

        socket.connect({
          port: server.port,
          host: connectAddress,
          family: isIpv6 ? 6 : 0,
        });
      });

      const latency = Date.now() - start;
      return {
        serverId: server.id,
        latency,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        serverId: server.id,
        latency: null,
        error: errorMessage,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  UDP/QUIC 测速：通过临时 sing-box HTTP 代理
  // ═══════════════════════════════════════════════════════════════

  /**
   * 经临时 sing-box 真实测速（全协议）：每个可用节点起独立 HTTP 入站 → 该节点出站，GET 测速端点（默认 generate_204，
   * 可经 testUrl 自配，兼容 http/https）测 TTFB。不可用节点（naive 缺 libcronet 等）预先剔除为 null、不进临时核。
   * @param onResult 可选逐节点回调：每测完一个节点即回传（serverId, latency），供 UI 流式增量显示。
   * @param testUrl 可选测速端点 URL（非法回落默认 generate_204）。
   */
  private async testServersViaProxy(
    servers: ServerConfig[],
    onResult?: (serverId: string, latency: number | null) => void,
    onProgress?: (tested: number, ok: number, total: number) => void,
    testUrl?: string
  ): Promise<Map<string, number | null>> {
    const results = new Map<string, number | null>();
    // 进度计数：每个节点得出结果（含 null/不可用/失败）即 tested++，成功 ok++；total 含不可用节点。
    let tested = 0;
    let ok = 0;
    const total = servers.length;
    const report = (id: string, latency: number | null) => {
      onResult?.(id, latency);
      tested++;
      if (latency !== null) ok++;
      onProgress?.(tested, ok, total);
    };
    let singboxProcess: ChildProcess | null = null;
    let configFilePath: string | null = null;

    // 构造各节点出站；不可用（naive 缺 libcronet / 异常）→ 直接 null，不进临时核（避免预初始化 FATAL 拖垮整批）。
    const getOutbound =
      this.buildOutboundFn ?? ((s: ServerConfig, t: string) => this.buildOutbound(s, t));
    const usable: { server: ServerConfig; tag: string; outbound: Record<string, unknown> }[] = [];
    for (const s of servers) {
      const tag = `out-${s.id.slice(0, 8)}`;
      const ob = getOutbound(s, tag);
      if (ob) usable.push({ server: s, tag, outbound: ob });
      else {
        results.set(s.id, null);
        report(s.id, null);
      }
    }
    if (usable.length === 0) return results;

    // 解析测速端点（一次，预热+正式共用）；非法 testUrl 经 resolveSpeedTestTarget 回落默认 generate_204。
    const target = resolveSpeedTestTarget(testUrl);

    try {
      // 1. 为可用节点分配 HTTP 代理端口
      const ports = await this.findFreePorts(usable.length);
      const serverPortMap = new Map<string, number>(); // serverId → HTTP proxy port
      usable.forEach((u, idx) => serverPortMap.set(u.server.id, ports[idx]));

      // 2. 生成临时 sing-box 配置（每节点独立 HTTP 入站 → 该节点出站）
      const config = this.generateProxyTestConfig(usable, serverPortMap);

      // 3. 写入临时配置文件
      const userDataPath = getUserDataPath();
      configFilePath = path.join(userDataPath, `speedtest_${Date.now()}.json`);
      await fs.writeFile(configFilePath, JSON.stringify(config, null, 2));

      // 4. 启动临时 sing-box 进程
      const singboxPath = resourceManager.getSingBoxPath();
      singboxProcess = spawn(singboxPath, ['run', '-c', configFilePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // 收集 stderr 用于调试
      let stderrOutput = '';
      singboxProcess.stderr?.on('data', (data: Buffer) => {
        stderrOutput += data.toString();
      });

      // 监听进程异常退出
      let processExited = false;
      singboxProcess.on('exit', (code) => {
        processExited = true;
        if (code !== null && code !== 0) {
          this.logManager.addLog(
            'warn',
            `临时 sing-box 进程退出 (code=${code}): ${stderrOutput.slice(0, 500)}`,
            'SpeedTest'
          );
        }
      });

      // 5. 等待 sing-box 就绪（连第一个 HTTP 代理端口）。应用分流规则集下载可能耗时，给 10s。
      const ready = await this.waitForPortReady(ports[0], 10000);
      if (!ready || processExited) {
        this.logManager.addLog(
          'warn',
          `sing-box 测速进程未就绪: ${stderrOutput.slice(0, 500)}`,
          'SpeedTest'
        );
        for (const u of usable) {
          results.set(u.server.id, null);
          report(u.server.id, null);
        }
        return results;
      }

      // 6. 预热：建立连接 + DNS 缓存（冷启动开销不计入延迟）。并发上限见 PROXY_TEST_CONCURRENCY。
      await this.runWithLimit(usable, SpeedTestService.PROXY_TEST_CONCURRENCY, async (u) => {
        await this.sendProxyRequest(serverPortMap.get(u.server.id)!, 8000, target);
      });

      // 7. 正式测速：经各自代理出站测 urltest TTFB。并发上限避免大订阅 N 路握手同时打出→请求风暴假超时；
      //    小订阅(≤上限)等价全并行、零额外延迟。每测完一个节点立即回调 onResult（UI 流式显示），不等队列。
      await this.runWithLimit(usable, SpeedTestService.PROXY_TEST_CONCURRENCY, async (u) => {
        const port = serverPortMap.get(u.server.id)!;
        try {
          const latency = await this.sendProxyRequest(port, 5000, target);
          results.set(u.server.id, latency);
          report(u.server.id, latency);
        } catch {
          results.set(u.server.id, null);
          report(u.server.id, null);
        }
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('error', `测速异常: ${msg}`, 'SpeedTest');
      for (const u of usable) {
        if (!results.has(u.server.id)) {
          results.set(u.server.id, null);
          report(u.server.id, null);
        }
      }
    } finally {
      // 清理临时进程
      if (singboxProcess && !singboxProcess.killed) {
        singboxProcess.kill('SIGTERM');
        const forceKillTimer = setTimeout(() => {
          try {
            singboxProcess?.kill('SIGKILL');
          } catch {
            // 进程可能已退出
          }
        }, 2000);
        singboxProcess.on('exit', () => clearTimeout(forceKillTimer));
      }
      // 清理临时配置文件
      if (configFilePath) {
        try {
          await fs.unlink(configFilePath);
        } catch {
          // ignore
        }
      }
    }

    return results;
  }

  /**
   * 生成用于测速的 sing-box 配置：每个可用节点一个独立 HTTP 代理入站 → 该节点（预构造）出站。
   * 出站由 ProxyManager.buildSpeedTestOutbound 预构造（全协议、domain_resolver=dns-direct、已去 detour）。
   */
  private generateProxyTestConfig(
    usable: { server: ServerConfig; tag: string; outbound: Record<string, unknown> }[],
    serverPortMap: Map<string, number>
  ): Record<string, unknown> {
    const inbounds: Record<string, unknown>[] = [];
    const outbounds: Record<string, unknown>[] = [];
    const routeRules: Record<string, unknown>[] = [];

    for (const { server, tag, outbound } of usable) {
      const port = serverPortMap.get(server.id);
      if (!port) continue;
      const inboundTag = `http-in-${server.id.slice(0, 8)}`;
      inbounds.push({ type: 'http', tag: inboundTag, listen: '127.0.0.1', listen_port: port });
      outbounds.push(outbound); // 预构造的全协议出站（tag 已为 out-<id8>）
      routeRules.push({ inbound: [inboundTag], action: 'route', outbound: tag });
    }

    // 必须有 direct 出站（sing-box 启动要求）
    outbounds.push({ type: 'direct', tag: 'direct' });

    return {
      log: { level: 'warn' },
      dns: {
        // sing-box 1.13+ 要求显式 type；出站 domain_resolver 与 default_domain_resolver 均指向本 tag
        servers: [{ tag: 'dns-direct', type: 'udp', server: '223.5.5.5', server_port: 53 }],
      },
      inbounds,
      outbounds,
      route: {
        rules: routeRules,
        auto_detect_interface: true,
        default_domain_resolver: 'dns-direct',
      },
    };
  }

  /**
   * 为单个 UDP 服务器生成 sing-box outbound 配置
   */
  private buildOutbound(server: ServerConfig, tag: string): Record<string, unknown> {
    const protocol = server.protocol.toLowerCase();

    const outbound: Record<string, unknown> = {
      type: protocol,
      tag,
      server: server.address,
      server_port: server.port,
    };

    // ── Hysteria2 ──
    if (protocol === 'hysteria2') {
      outbound.password = server.password;

      if (server.hysteria2Settings?.upMbps) {
        outbound.up_mbps = server.hysteria2Settings.upMbps;
      }
      if (server.hysteria2Settings?.downMbps) {
        outbound.down_mbps = server.hysteria2Settings.downMbps;
      }
      if (server.hysteria2Settings?.obfs?.type && server.hysteria2Settings?.obfs?.password) {
        outbound.obfs = {
          type: server.hysteria2Settings.obfs.type,
          password: server.hysteria2Settings.obfs.password,
        };
      }
      if (server.hysteria2Settings?.network) {
        outbound.network = server.hysteria2Settings.network;
      }
    }

    // ── TUIC ──
    if (protocol === 'tuic') {
      outbound.uuid = server.uuid;
      outbound.password = server.password;

      if (server.tuicSettings) {
        if (server.tuicSettings.congestionControl) {
          outbound.congestion_control = server.tuicSettings.congestionControl;
        }
        if (server.tuicSettings.udpRelayMode) {
          outbound.udp_relay_mode = server.tuicSettings.udpRelayMode;
        }
        if (server.tuicSettings.zeroRttHandshake !== undefined) {
          outbound.zero_rtt_handshake = server.tuicSettings.zeroRttHandshake;
        }
        if (server.tuicSettings.heartbeat) {
          outbound.heartbeat = server.tuicSettings.heartbeat;
        }
      }
    }

    // ── TLS（hysteria2 和 tuic 都强制开启）──
    const tls: Record<string, unknown> = {
      enabled: true,
      server_name: server.tlsSettings?.serverName || server.address,
      insecure: server.tlsSettings?.allowInsecure || false,
    };
    if (server.tlsSettings?.alpn) {
      tls.alpn = server.tlsSettings.alpn;
    }
    outbound.tls = tls;

    return outbound;
  }

  // ═══════════════════════════════════════════════════════════════
  //  工具方法
  // ═══════════════════════════════════════════════════════════════

  /**
   * 通过本地 HTTP 代理（临时 sing-box 各节点入站）请求测速端点，量 TTFB（请求发出 → 收到响应头）。
   * - HTTP 端点：代理绝对 URI GET（`GET http://host/path`，代理按 Host 转发）。
   * - HTTPS 端点：代理 CONNECT 隧道 → TLS 握手 → GET；测速仅量可达性+TTFB，rejectUnauthorized=false（与 HTTP 路径不校验等价）。
   */
  private sendProxyRequest(
    proxyPort: number,
    timeout: number,
    target: SpeedTestTarget
  ): Promise<number | null> {
    return target.https
      ? this.sendHttpsViaProxy(proxyPort, timeout, target)
      : this.sendHttpViaProxy(proxyPort, timeout, target);
  }

  /** HTTP 端点经代理绝对 URI GET。 */
  private sendHttpViaProxy(
    proxyPort: number,
    timeout: number,
    target: SpeedTestTarget
  ): Promise<number | null> {
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setTimeout(() => resolve(null), timeout);
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: target.absoluteUri, // 代理绝对 URI（http://host[:port]/path）
          headers: { Host: target.hostHeader, Connection: 'close' },
          timeout,
        },
        (res) => {
          clearTimeout(timer);
          const latency = Date.now() - start; // 收到响应头即刻计算（不等 body），与 NekoBox urltest 一致
          res.resume(); // 排空响应体，防止内存泄漏
          resolve(latency);
        }
      );
      req.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      req.on('timeout', () => {
        clearTimeout(timer);
        req.destroy();
        resolve(null);
      });
    });
  }

  /** HTTPS 端点经代理 CONNECT 隧道 + TLS GET。 */
  private sendHttpsViaProxy(
    proxyPort: number,
    timeout: number,
    target: SpeedTestTarget
  ): Promise<number | null> {
    return new Promise((resolve) => {
      const start = Date.now();
      // 持有所有已建立句柄，finish 时统一 destroy（防 fd/socket 泄漏：大订阅并发 32 + HTTPS 时累积）。
      let connectReq: http.ClientRequest | null = null;
      let tunnel: net.Socket | null = null;
      let tlsSock: tls.TLSSocket | null = null;
      let done = false;
      const finish = (v: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // 统一清理：destroy 所有已建立的句柄（GET 已拿到 TTFB / 任何错误 / 超时均不应留挂起 socket）
        tlsSock?.destroy();
        tunnel?.destroy();
        connectReq?.destroy();
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), timeout);

      // CONNECT 端口用 target.port（不能用 hostHeader 拼 443——非标端口如 8443 会变成 host:8443:443；
      // 也不能用 hostHeader:443——非标 hostHeader 已含端口会双端口）。CONNECT 始终显式 host:port。
      const connectHost = `${target.host}:${target.port}`;
      // 1. 向代理发 CONNECT 建立到 target 的 TCP 隧道
      connectReq = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: connectHost,
        headers: { Host: connectHost },
        timeout,
      });
      connectReq.on('error', () => finish(null));
      connectReq.on('timeout', () => finish(null));
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          finish(null); // finish 内统一 destroy socket
          return;
        }
        tunnel = socket;
        // 2. 在隧道上 TLS 握手；测速仅量可达性+TTFB，不校验证书（自签/MITM 端点也能测，与 HTTP 路径等价）
        tlsSock = tls.connect(
          { socket, servername: target.host, rejectUnauthorized: false },
          () => {
            // 3. 握手完成，发 GET（首批响应 data 即响应头到达 = TTFB）
            tlsSock?.write(
              `GET ${target.path} HTTP/1.1\r\nHost: ${target.hostHeader}\r\nConnection: close\r\n\r\n`
            );
          }
        );
        let measured = false;
        tlsSock.on('data', () => {
          if (!measured) {
            measured = true;
            finish(Date.now() - start);
          }
        });
        tlsSock.on('error', () => finish(null));
      });
      connectReq.end();
    });
  }

  /**
   * 并发上限执行（固定大小 worker 池）：最多 `limit` 个任务同时进行，其余排队。
   * 用于预热/测速——小订阅(items≤limit)即全并行，大订阅分波，消除请求风暴假超时。
   */
  private async runWithLimit<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>
  ): Promise<void> {
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        await fn(items[i]);
      }
    });
    await Promise.all(workers);
  }

  /**
   * 找到多个系统可用的空闲端口
   */
  private async findFreePorts(count: number): Promise<number[]> {
    const servers: net.Server[] = [];
    const ports: number[] = [];

    try {
      // 同时绑定所有端口，确保不冲突
      for (let i = 0; i < count; i++) {
        const srv = net.createServer();
        await new Promise<void>((resolve, reject) => {
          srv.listen(0, '127.0.0.1', () => resolve());
          srv.on('error', reject);
        });
        ports.push((srv.address() as net.AddressInfo).port);
        servers.push(srv);
      }
    } finally {
      // 关闭所有临时服务器，释放端口给 sing-box 使用
      await Promise.all(
        servers.map((srv) => new Promise<void>((resolve) => srv.close(() => resolve())))
      );
    }

    return ports;
  }

  /**
   * 等待端口可连接（表示 sing-box 已就绪）
   */
  private async waitForPortReady(port: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.connect(port, '127.0.0.1');
      });

      if (ok) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }
}
