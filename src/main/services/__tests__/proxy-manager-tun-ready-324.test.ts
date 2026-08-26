/**
 * ProxyManager 正向 TUN 就绪门 + 持续性失败终态转化单测（issue #324）。
 *
 * 覆盖 waitForCoreReadyOrThrow 的 win32+TUN 编排（A1 硬闸 / A3 dead 文案 / 平台闸 no-op / fail-open）与
 * maybeToTunPersistentError 的终态分类矩阵（A2）。私有方法/字段经 `(svc as any)` 直调注入，不启动 sing-box、
 * 不碰真实网卡/PowerShell——adapterPresenceProbe/coreReadyProbe/isProcessAlive/helperManager 全为桩。
 * 真实 Get-NetAdapter 探测与适配器可见延迟属真机项（无 Windows 环境，不在单测覆盖）。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-tun324-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

import { ProxyManager } from '../ProxyManager';
import {
  CoreStartRetryError,
  CoreStartSupersededError,
  CoreStartTunPersistentError,
} from '../core-readiness';
import type { AdapterPresence, TunAdapterObservation } from '../win-tun-adapter';
import { StartTimeline } from '../start-timeline';
import { withPlatformAsync } from './platform-test-utils';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeSvc(): any {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  const svc: any = new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
  svc.tailscaleApiPort = 9099; // 有管理 API 端口 → 不走 fail-open 早退
  svc.currentConfig = { proxyModeType: 'tun', servers: [], tunConfig: {} };
  svc.helperManager = { stopCore: jest.fn().mockResolvedValue(undefined) };
  // B4：就绪门的探活腿已从 isProcessAlive（execSync，阻塞 event loop）换成异步版。默认委托到同一个同步桩，
  //   使各用例既有的 `svc.isProcessAlive = …` 意图逐字保留；个别用例直接改 isProcessAliveAsync 的照旧覆盖本默认。
  svc.isProcessAliveAsync = async () => svc.isProcessAlive();
  return svc;
}

/** win32+TUN tracker（startInternal 会置；此处直接注入模拟已开观测）。 */
function armTun(svc: any): TunAdapterObservation {
  const obs: TunAdapterObservation = { adapterEverSeen: false, probeEverConclusive: false };
  svc.tunReadyObservation = obs;
  return obs;
}

/** 定序三态 probe（用尽后恒返回末值）。 */
function seqProbe(seq: AdapterPresence[]): () => Promise<AdapterPresence> {
  let i = 0;
  return async () => (i < seq.length ? seq[i++] : (seq[seq.length - 1] ?? 'absent'));
}

describe('issue #324 — waitForCoreReadyOrThrow 正向 TUN 就绪门（win32+TUN 编排）', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('平台/模式闸 no-op：tunReadyObservation=null（非 win32+TUN）→ ready 直放行，探针零调用', async () => {
    const svc = makeSvc();
    svc.tunReadyObservation = null; // 模拟 macOS/Linux/非 TUN
    svc.isProcessAlive = () => true;
    svc.coreReadyProbe = async () => true;
    const probe = jest.fn(async () => 'present' as AdapterPresence);
    svc.adapterPresenceProbe = probe;

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).resolves.toBeUndefined(); // 先挂 handler，防 advance 期未捕获
    await jest.advanceTimersByTimeAsync(20000);
    await assertion;
    expect(probe).not.toHaveBeenCalled(); // 变异「平台闸翻转」→ 此断言失败
  });

  it('ready + 观测窗内适配器出现 → 放行，tracker.adapterEverSeen=true（无需 grace）', async () => {
    const svc = makeSvc();
    const obs = armTun(svc);
    svc.isProcessAlive = () => true;
    svc.coreReadyProbe = async () => true;
    svc.adapterPresenceProbe = seqProbe(['present']);

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(20000);
    await assertion;
    expect(obs.adapterEverSeen).toBe(true);
    expect(svc.helperManager.stopCore).not.toHaveBeenCalled(); // 成功不停核
  });

  it('ready 但适配器确证 absent（探测可用）→ 硬闸 reject CoreStartRetryError + 停核（拒假连接）', async () => {
    const svc = makeSvc();
    const obs = armTun(svc);
    svc.isProcessAlive = () => true;
    svc.coreReadyProbe = async () => true;
    svc.adapterPresenceProbe = async () => 'absent' as AdapterPresence; // 永不出现

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    // 变异「A1 硬闸 throw 改 warn 放行」→ 会 resolve → 此 rejects 断言失败
    const assertion = expect(p).rejects.toBeInstanceOf(CoreStartRetryError);
    await jest.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(svc.helperManager.stopCore).toHaveBeenCalled(); // 停掉「API 通但无 TUN」的半死核
    expect(obs.probeEverConclusive).toBe(true); // clean absent 记入 tracker（供预算耗尽后判持续性）
    expect(obs.adapterEverSeen).toBe(false);
  });

  // review High#1：A1 grace 窗内被更新的 start/stop 接管（#176 高发）→ 静默让位，**绝不 stopCore**（拆接管方核）、不发幻影 started。
  it('ready 后 A1 grace 窗内被接管 → 抛 CoreStartSupersededError，绝不 stopCore', async () => {
    const svc = makeSvc();
    armTun(svc);
    const startGen = svc.lifecycleGeneration;
    svc.isProcessAlive = () => true;
    let readyReturned = false;
    svc.coreReadyProbe = async () => {
      readyReturned = true; // 就绪窗未接管（gen 未变）→ 正常 ready
      return true;
    };
    // 观测窗探测（readyReturned 前）不接管；进入 grace（readyReturned 后）首个探测即模拟接管方 bump 世代。
    svc.adapterPresenceProbe = async () => {
      if (readyReturned) svc.lifecycleGeneration = startGen + 1;
      return 'absent' as AdapterPresence;
    };

    const p = svc.waitForCoreReadyOrThrow(1234, startGen);
    const assertion = expect(p).rejects.toBeInstanceOf(CoreStartSupersededError);
    await jest.advanceTimersByTimeAsync(20000);
    await assertion;
    // 变异「grace 不判 supersede」→ 会走 absent-timeout 分支 stopCore+CoreStartRetryError → 下面两断言失败
    expect(svc.helperManager.stopCore).not.toHaveBeenCalled();
  });

  // review Med#2：A1 每腿独立验证——不吃跨腿 sticky adapterEverSeen（前腿见旧适配器不代表本腿 TUN 已建）。
  it('前腿 sticky adapterEverSeen=true 但本腿探测 absent → A1 仍硬闸 reject（不靠 sticky 免检）', async () => {
    const svc = makeSvc();
    const obs = armTun(svc);
    obs.adapterEverSeen = true; // 模拟前一重试腿曾见（可能是 #159 残留同名旧适配器）
    svc.isProcessAlive = () => true;
    svc.coreReadyProbe = async () => true;
    svc.adapterPresenceProbe = async () => 'absent' as AdapterPresence; // 本腿实际未建

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    // 变异「保留 if(adapterEverSeen)return 免检」→ 会 resolve（假连接漏过）→ 此 rejects 断言失败
    const assertion = expect(p).rejects.toBeInstanceOf(CoreStartRetryError);
    await jest.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(svc.helperManager.stopCore).toHaveBeenCalled();
  });

  it('ready 但适配器探测全 unknown（杀软拦 PS）→ fail-open 放行，不 reject、不停核', async () => {
    const svc = makeSvc();
    const obs = armTun(svc);
    svc.isProcessAlive = () => true;
    svc.coreReadyProbe = async () => true;
    svc.adapterPresenceProbe = async () => 'unknown' as AdapterPresence;

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).resolves.toBeUndefined(); // fail-open：绝不据探测失败判失败
    await jest.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(svc.helperManager.stopCore).not.toHaveBeenCalled();
    expect(obs.probeEverConclusive).toBe(false); // 全 unknown → 不 conclusive → 后续判瞬态
  });

  it('dead + 探测可用却从未见适配器 → A3 文案「TUN 适配器从未创建，疑 wintun 被拦」', async () => {
    const svc = makeSvc();
    armTun(svc);
    svc.isProcessAlive = () => false; // 起核期进程死
    svc.coreReadyProbe = async () => false;
    svc.adapterPresenceProbe = async () => 'absent' as AdapterPresence; // 探测可用、始终无网卡

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).rejects.toThrow(/从未创建/);
    await jest.advanceTimersByTimeAsync(20000);
    await assertion;
    expect(svc.helperManager.stopCore).toHaveBeenCalled();
  });

  it('dead + 曾见适配器（瞬态）→ 保持原「TUN 初始化未完成」文案（不误报 wintun 异常）', async () => {
    const svc = makeSvc();
    const obs = armTun(svc);
    svc.isProcessAlive = () => false;
    svc.coreReadyProbe = async () => false;
    svc.adapterPresenceProbe = seqProbe(['present']); // 观测窗曾见 → 瞬态族

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).rejects.toThrow(/TUN 初始化未完成/);
    await jest.advanceTimersByTimeAsync(20000);
    await assertion;
    expect(obs.adapterEverSeen).toBe(true);
  });
});

describe('issue #324 — maybeToTunPersistentError 终态分类矩阵（A2）', () => {
  const retry = (): CoreStartRetryError => new CoreStartRetryError('TUN 初始化未完成');

  it('从未见 + 探测可用 → 转 CoreStartTunPersistentError + emit TUN_INIT_PERSISTENT', () => {
    const svc = makeSvc();
    svc.tunReadyObservation = { adapterEverSeen: false, probeEverConclusive: true };
    const emit = jest.spyOn(svc, 'sendEventToRenderer').mockImplementation(() => {});
    const out = svc.maybeToTunPersistentError(retry());
    expect(out).toBeInstanceOf(CoreStartTunPersistentError);
    const call = emit.mock.calls.find((c: any[]) => c[1]?.errorCode === 'TUN_INIT_PERSISTENT');
    expect(call).toBeTruthy(); // 结构化 code 上渲染端驱动诊断卡
  });

  it('曾见适配器 → 保持原 CoreStartRetryError（瞬态族，不转终态）', () => {
    const svc = makeSvc();
    svc.tunReadyObservation = { adapterEverSeen: true, probeEverConclusive: true };
    const err = retry();
    expect(svc.maybeToTunPersistentError(err)).toBe(err);
  });

  it('探测全 unknown（!conclusive）→ fail-open 保持原错误（绝不误判终态）', () => {
    const svc = makeSvc();
    svc.tunReadyObservation = { adapterEverSeen: false, probeEverConclusive: false };
    const err = retry();
    // 变异「删 fail-open」→ 会转终态 → 此 toBe 失败
    expect(svc.maybeToTunPersistentError(err)).toBe(err);
  });

  it('obs=null（非 win32+TUN）→ 原样（平台闸）', () => {
    const svc = makeSvc();
    svc.tunReadyObservation = null;
    const err = retry();
    expect(svc.maybeToTunPersistentError(err)).toBe(err);
  });

  it('非 CoreStartRetryError（如普通 Error）→ 原样（只转可重试起核错误）', () => {
    const svc = makeSvc();
    svc.tunReadyObservation = { adapterEverSeen: false, probeEverConclusive: true };
    const err = new Error('权限不足');
    expect(svc.maybeToTunPersistentError(err)).toBe(err);
  });
});

// ============================================================================
// issue #324 P0-1：核 stderr 的 FATAL 真因解析 → 上屏 + 终态转化（dead 分支编排）。
// ============================================================================

const { getSingBoxStartupLogPath } = require('../../utils/paths');
const { startMessageIsNonRetryable } = require('../core-readiness');

const ADDR_CONFLICT_FATAL =
  '\x1b[31mFATAL\x1b[0m[0000] start service: start inbound/tun[tun-in]: configure tun interface: set ipv4 address: The object already exists.';

/** 让 waitForCoreReadyOrThrow 走 dead 分支（进程死 + API 从未绑定）。 */
function armDead(svc: any): void {
  svc.isProcessAlive = () => false;
  svc.coreReadyProbe = async () => false;
  // 必须桩掉：默认实现走真实 PowerShell，而本文件把 child_process.execFile mock 成了永不回调的 jest.fn()
  // → 并行的适配器观测 Promise 永挂 → 整个 waitForCoreReadyOrThrow 超时（不是失败，是挂死）。
  // 用 'unknown' 保持 tracker 中立（monotonic 记录不受影响），让各用例自己决定 obs 的初值。
  svc.adapterPresenceProbe = async () => 'unknown' as AdapterPresence;
}

/** 写 startup log，并把起核锚点设在写入之前（=本腿新写的全部可见）。 */
function writeStartupLog(svc: any, content: string, offset = 0): void {
  fsSync.writeFileSync(getSingBoxStartupLogPath(), content, 'utf-8');
  svc.startupLogOffset = offset;
}

describe('issue #324 P0-1 — dead 分支从 stderr 捞 FATAL 真因', () => {
  // dead 分支要读真实的 startup log 文件，而 fs/promises 的回调派发走 setImmediate——一并 fake 掉会让
  // readLastStartupFatal 永不 settle（测试超时而非失败，最难排查的那种）。故只 fake 定时器、放过 setImmediate。
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    try {
      fsSync.unlinkSync(getSingBoxStartupLogPath());
    } catch {
      /* 文件可能不存在 */
    }
  });

  it('地址冲突 FATAL → 记录分类结果，但错误 message 绝不含 FATAL 原文', async () => {
    const svc = makeSvc();
    armTun(svc);
    armDead(svc);
    const logs: Array<[string, string]> = [];
    svc.logToManager = (level: string, msg: string) => logs.push([level, msg]);
    writeStartupLog(svc, ADDR_CONFLICT_FATAL);

    const captured = svc
      .waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration)
      .catch((e: Error) => e);
    await jest.advanceTimersByTimeAsync(30000);
    const err = await captured;

    expect(err).toBeInstanceOf(CoreStartRetryError);
    expect(svc.lastStartupFatal?.kind).toBe('tun-address-conflict');
    // 真因进日志（用户在日志面板立刻可见）。
    const errLine = logs.find(([lv]) => lv === 'error')?.[1] ?? '';
    expect(errLine).toContain('已被本机其它网络接口占用');
    // **硬约束**：FATAL 原文绝不能拼进 CoreStartRetryError.message。
    expect(err.message).not.toContain('The object already exists');
  });

  it('FATAL 含 permission denied 时，错误 message 不因此变成「不可重试」', async () => {
    // 守门测试：一旦有人把 FATAL 原文拼进 message，NON_RETRYABLE_START_ERROR_PATTERNS 的 'permission'
    // 会命中 → 可重试的起核失败被静默判成终态失败，用户连自动重试都没有了。
    const svc = makeSvc();
    armTun(svc);
    armDead(svc);
    svc.logToManager = () => {};
    writeStartupLog(
      svc,
      'FATAL[0000] start service: start inbound/tun[tun-in]: configure tun interface: create adapter: permission denied'
    );

    const captured = svc
      .waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration)
      .catch((e: Error) => e);
    await jest.advanceTimersByTimeAsync(30000);
    const err = await captured;

    expect(err).toBeInstanceOf(CoreStartRetryError);
    expect(err.message).not.toContain('permission denied');
    expect(startMessageIsNonRetryable(err.message)).toBe(false);
  });

  it('run 边界：锚点之前的上次残留 FATAL 不被当成本次原因', async () => {
    const svc = makeSvc();
    armTun(svc);
    armDead(svc);
    svc.logToManager = () => {};
    const stale = 'FATAL[0000] configure tun interface: create adapter: STALE\n';
    // 锚点 = 残留内容的长度 ⟹ 本腿一个字节都没写。
    writeStartupLog(svc, stale, Buffer.byteLength(stale));

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).rejects.toBeInstanceOf(CoreStartRetryError);
    await jest.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(svc.lastStartupFatal).toBeNull();
  });

  it('P2：拿到非适配器类的 FATAL 真因时，不再输出「疑 wintun 被拦」的推断文案', async () => {
    const svc = makeSvc();
    const obs = armTun(svc);
    obs.probeEverConclusive = true; // 探测可用且从未见适配器 → 旧逻辑会输出 A3 推断文案
    armDead(svc);
    svc.logToManager = () => {};
    writeStartupLog(svc, ADDR_CONFLICT_FATAL);

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).rejects.toThrow(/TUN 初始化未完成/);
    await jest.advanceTimersByTimeAsync(30000);
    await assertion;
    // 变异「删 inferenceContradicted 判定」→ 文案变回「疑 wintun 被拦」，上面的正则失败。
  });

  it('适配器创建类 FATAL 与推断一致时，保留 A3 文案', async () => {
    const svc = makeSvc();
    const obs = armTun(svc);
    obs.probeEverConclusive = true;
    armDead(svc);
    svc.logToManager = () => {};
    writeStartupLog(svc, 'FATAL[0000] configure tun interface: create adapter: Access is denied.');

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).rejects.toThrow(/疑 wintun 被拦/);
    await jest.advanceTimersByTimeAsync(30000);
    await assertion;
  });

  it('startup log 不存在 → 静默降级，不影响原有失败语义', async () => {
    const svc = makeSvc();
    armTun(svc);
    armDead(svc);
    svc.logToManager = () => {};
    svc.startupLogOffset = 0;

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).rejects.toBeInstanceOf(CoreStartRetryError);
    await jest.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(svc.lastStartupFatal).toBeNull();
  });
});

describe('issue #324 P0-1 — 地址冲突转终态（maybeToTunPersistentError）', () => {
  const retryErr = (): Error =>
    new CoreStartRetryError('sing-box 启动期退出（TUN 初始化未完成），正在自动重试');

  it('地址冲突：即便适配器曾出现（adapterEverSeen=true）也转终态', () => {
    // #324 的真实形态：wintun 适配器**创建成功**、卡在配地址 → isPersistentTunFailure 恒 false →
    // 只靠观测判据会永远重试下去。变异「删掉 FATAL 这一路」→ 本例失败。
    const svc = makeSvc();
    svc.tunReadyObservation = { adapterEverSeen: true, probeEverConclusive: true };
    svc.lastStartupFatal = {
      kind: 'tun-address-conflict',
      raw: 'FATAL[0000] ... set ipv4 address: The object already exists.',
      message: 'TUN 地址 172.19.0.1 已被本机其它网络接口占用。',
    };
    svc.sendEventToRenderer = () => {};
    svc.logToManager = () => {};
    const out = svc.maybeToTunPersistentError(retryErr());
    expect(out).toBeInstanceOf(CoreStartTunPersistentError);
    expect((out as Error).message).toContain('172.19.0.1');
    // 文案只能引导当前真做得到的动作（TUN 地址尚未开放配置）。
    expect((out as Error).message).not.toContain('设置');
  });

  it('地址冲突判定跨平台：非 win32（obs=null）同样转终态', () => {
    const svc = makeSvc();
    svc.tunReadyObservation = null; // macOS/Linux
    svc.lastStartupFatal = {
      kind: 'tun-address-conflict',
      raw: 'x',
      message: 'TUN 地址已被占用。',
    };
    svc.sendEventToRenderer = () => {};
    svc.logToManager = () => {};
    expect(svc.maybeToTunPersistentError(retryErr())).toBeInstanceOf(CoreStartTunPersistentError);
  });

  it('非 TUN 模式不转终态（FATAL 可能来自上一次 TUN 会话）', () => {
    const svc = makeSvc();
    svc.currentConfig = { proxyModeType: 'systemProxy', servers: [], tunConfig: {} };
    svc.tunReadyObservation = null;
    svc.lastStartupFatal = { kind: 'tun-address-conflict', raw: 'x', message: 'y' };
    const err = retryErr();
    expect(svc.maybeToTunPersistentError(err)).toBe(err);
  });

  it('适配器创建类 FATAL 不提前转终态（可能是驱动加载竞态，交预算耗尽判）', () => {
    const svc = makeSvc();
    svc.tunReadyObservation = { adapterEverSeen: true, probeEverConclusive: true };
    svc.lastStartupFatal = { kind: 'tun-adapter-create', raw: 'x', message: 'y' };
    const err = retryErr();
    expect(svc.maybeToTunPersistentError(err)).toBe(err);
  });
});

describe('issue #324 P0-1 — 跨重试腿的 FATAL 状态卫生', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    try {
      fsSync.unlinkSync(getSingBoxStartupLogPath());
    } catch {
      /* 文件可能不存在 */
    }
  });

  it('本腿没捞到 FATAL → 清掉上一腿的结论，不留陈旧真因', async () => {
    // 变异守卫：改成「只在捞到时赋值」→ 第 1 腿的地址冲突结论会残留，第 2 腿因别的原因死时，
    // 终态转化会拿着过期结论把可重试错误判成地址冲突终态。
    const svc = makeSvc();
    armTun(svc);
    armDead(svc);
    svc.logToManager = () => {};
    svc.lastStartupFatal = {
      kind: 'tun-address-conflict',
      raw: 'stale',
      message: '上一腿的结论',
    };
    // 本腿：文件里只有锚点之前的旧内容 ⟹ 本腿零写入。
    const stale =
      'FATAL[0000] configure tun interface: set ipv4 address: The object already exists.\n';
    writeStartupLog(svc, stale, Buffer.byteLength(stale));

    const captured = svc
      .waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration)
      .catch((e: Error) => e);
    await jest.advanceTimersByTimeAsync(30000);
    await captured;

    expect(svc.lastStartupFatal).toBeNull();
  });
});

describe('issue #324 M1 — supersede 交错时的 FATAL 状态卫生', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    try {
      fsSync.unlinkSync(getSingBoxStartupLogPath());
    } catch {
      /* 文件可能不存在 */
    }
  });

  it('dead 判定后、drain 观测期间被接管 → 不再读写 FATAL 状态（不错锚、不污染接管方）', async () => {
    // 真实时序：waitForCoreReady 先返回 dead（此刻世代还没变），随后 dead 分支要 await 在途适配器观测
    // （execFile 4s 封顶）。**这个窗口里** start B 接管——B 已清空 lastStartupFatal 并改写 startupLogOffset。
    // A 此刻若继续读，会用 B 的锚点切片（错锚），再把结果写回污染 B 的终态判据。
    // 注意不能在调用前就改世代：那样 waitForCoreReady 首轮 isSuperseded 就早退，根本走不到 dead 分支。
    const svc = makeSvc();
    armTun(svc);
    armDead(svc);
    svc.logToManager = () => {};
    writeStartupLog(svc, ADDR_CONFLICT_FATAL);

    const startGen = svc.lifecycleGeneration;
    svc.lastStartupFatal = null;
    // 接管必须发生在 waitForCoreReady 判出 dead **之后**：它自己每轮先查 isSuperseded，提前改世代只会让它
    // 早退成 'superseded'，根本走不到 dead 分支（那样测的是另一条路径，变异也杀不掉）。isProcessAlive 返回
    // false 正是 dead 的判据，在它里面递增世代即精确落在这个窗口。
    svc.isProcessAlive = () => {
      svc.lifecycleGeneration = startGen + 1;
      return false;
    };

    const captured = svc.waitForCoreReadyOrThrow(1234, startGen).catch((e: Error) => e);
    await jest.advanceTimersByTimeAsync(30000);
    await captured;

    // 变异守卫：去掉世代守卫 → A 会把地址冲突结论写进 lastStartupFatal 污染 B，本例失败。
    expect(svc.lastStartupFatal).toBeNull();
  });

  it('未被接管时照常读写（守卫不误伤正常路径）', async () => {
    const svc = makeSvc();
    armTun(svc);
    armDead(svc);
    svc.logToManager = () => {};
    writeStartupLog(svc, ADDR_CONFLICT_FATAL);

    const captured = svc
      .waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration)
      .catch((e: Error) => e);
    await jest.advanceTimersByTimeAsync(30000);
    await captured;

    expect(svc.lastStartupFatal?.kind).toBe('tun-address-conflict');
  });
});

// ============================================================================
// issue #324 H2：wrapper（Windows UAC 看护 / macOS osascript）路径也要读 FATAL 真因并停止无谓重试。
// 报告者走的正是这条路径——helper 路径的 dead 分支对他完全不生效。
// ============================================================================

describe('issue #324 H2 — wrapper 路径的 FATAL 真因与终态', () => {
  afterEach(() => {
    try {
      fsSync.unlinkSync(getSingBoxStartupLogPath());
    } catch {
      /* 文件可能不存在 */
    }
  });

  it('wrapper 写侧是截断语义：整读文件，不套 offset 差分', () => {
    // 变异守卫：wrapper 路径也走 sliceSinceRunStart(offset) → 重复失败腿写出逐字节相同内容时
    // sizeNow===offset 被误判成「本腿零写入」→ FATAL 系统性丢失，恰好是本路径最常见的形态。
    const svc = makeSvc();
    svc.startedViaWrapper = true;
    const content = ADDR_CONFLICT_FATAL;
    fsSync.writeFileSync(getSingBoxStartupLogPath(), content, 'utf-8');
    svc.startupLogOffset = Buffer.byteLength(content); // 等长：追加语义下会被判成零写入

    expect(svc.readLastStartupFatal()?.kind).toBe('tun-address-conflict');
  });

  it('helper 写侧仍按锚点切（守卫不误伤追加语义）', () => {
    const svc = makeSvc();
    svc.startedViaWrapper = false;
    const stale = ADDR_CONFLICT_FATAL;
    fsSync.writeFileSync(getSingBoxStartupLogPath(), stale, 'utf-8');
    svc.startupLogOffset = Buffer.byteLength(stale);

    expect(svc.readLastStartupFatal()).toBeNull();
  });

  it('地址冲突 FATAL → 终态错误（跳过外层 retry 预算）', () => {
    // 变异守卫：该分支不读 startup log → 返回普通 Error，本例失败。#324 报告者走的就是这条路径。
    const svc = makeSvc();
    svc.startedViaWrapper = true;
    svc.logToManager = () => {};
    svc.sendEventToRenderer = () => {};
    fsSync.writeFileSync(getSingBoxStartupLogPath(), ADDR_CONFLICT_FATAL, 'utf-8');
    svc.startupLogOffset = 0;

    const err = svc.buildWrapperStartFailure(svc.lifecycleGeneration);
    expect(err).toBeInstanceOf(CoreStartTunPersistentError);
    expect(err.message).toContain('172.19.0.1');
    expect(svc.lastStartupFatal?.kind).toBe('tun-address-conflict');
  });

  it('无 FATAL → 保持原有普通 Error 语义（交外层按既有规则判重试）', () => {
    const svc = makeSvc();
    svc.startedViaWrapper = true;
    svc.logToManager = () => {};
    svc.startupLogOffset = 0;

    const err = svc.buildWrapperStartFailure(svc.lifecycleGeneration);
    expect(err).not.toBeInstanceOf(CoreStartTunPersistentError);
    expect(err.message).toContain('无法获取进程 PID');
  });

  it('非 TUN 模式不转终态', () => {
    const svc = makeSvc();
    svc.currentConfig = { proxyModeType: 'systemProxy', servers: [], tunConfig: {} };
    svc.startedViaWrapper = true;
    svc.logToManager = () => {};
    fsSync.writeFileSync(getSingBoxStartupLogPath(), ADDR_CONFLICT_FATAL, 'utf-8');
    svc.startupLogOffset = 0;

    expect(svc.buildWrapperStartFailure(svc.lifecycleGeneration)).not.toBeInstanceOf(
      CoreStartTunPersistentError
    );
  });
});

describe('issue #324 M-2 — buildWrapperStartFailure 的 supersede 守卫', () => {
  afterEach(() => {
    try {
      fsSync.unlinkSync(getSingBoxStartupLogPath());
    } catch {
      /* 文件可能不存在 */
    }
  });

  it('本腿已被接管 → 不读不写不发事件，退回原始语义', () => {
    // waitForPidFile 可空转 60s，是比 dead 分支 drain（≤4s）宽一个量级的接管窗口。变异守卫：去掉世代守卫 →
    // 本腿会对着接管方的会话读错锚、污染 lastStartupFatal、还发一张终态诊断卡，本例失败。
    const svc = makeSvc();
    svc.startedViaWrapper = true;
    svc.logToManager = () => {};
    const events: unknown[] = [];
    svc.sendEventToRenderer = (_ch: string, d: unknown) => events.push(d);
    svc.lastStartupFatal = null;
    fsSync.writeFileSync(getSingBoxStartupLogPath(), ADDR_CONFLICT_FATAL, 'utf-8');
    svc.startupLogOffset = 0;

    const err = svc.buildWrapperStartFailure(svc.lifecycleGeneration - 1); // 本腿世代已过期

    expect(err).not.toBeInstanceOf(CoreStartTunPersistentError);
    expect(svc.lastStartupFatal).toBeNull();
    expect(events).toHaveLength(0);
  });
});

describe('issue #324 L1 — readSync 短读不得把 NUL 带进解析文本', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    try {
      fsSync.unlinkSync(getSingBoxStartupLogPath());
    } catch {
      /* 文件可能不存在 */
    }
  });

  it('stat 与 read 之间文件被截短 → 只解析实际读到的字节', () => {
    // 变异守卫：忽略 readSync 返回值、整块 toString → buf 尾部的 \0 进入 raw 并落日志，本例失败。
    const svc = makeSvc();
    svc.startedViaWrapper = true;
    const content = ADDR_CONFLICT_FATAL;
    fsSync.writeFileSync(getSingBoxStartupLogPath(), content, 'utf-8');
    svc.startupLogOffset = 0;

    const real = fsSync.readSync;
    jest.spyOn(fsSync, 'readSync').mockImplementation((...args: unknown[]) => {
      // 模拟并发缩容：只读到一半，剩余 buf 保持 \0
      const [fd, buf, off, len, pos] = args as [number, Buffer, number, number, number];
      return real(fd, buf, off, Math.floor(len / 2), pos);
    });

    const info = svc.readLastStartupFatal();
    // 半截行仍可能解析不出 FATAL（取决于切点），但无论如何绝不能带 NUL。
    expect(info?.raw ?? '').not.toContain('\0');
  });
});

// ============================================================================
// issue #324 H2 修正：wrapper 路径「核死于 started 之后」的**真实通道**是 performHealthCheck，
// 不是 handleProcessExit —— 那种核 detached 由看护脚本托管、不是子进程，死亡不产生 'exit' 事件，
// 且 launcher 退出码 0 时 exit 回调显式早退。R2 复审指出前一版测试直调 handleProcessExit 测的是方法体、
// 生产接线从未被走过（假绿），故改走真实通道。
// ============================================================================

describe('issue #324 H2 — performHealthCheck 才是 wrapper 核死的真实检测通道', () => {
  afterEach(() => {
    try {
      fsSync.unlinkSync(getSingBoxStartupLogPath());
    } catch {
      /* 文件可能不存在 */
    }
  });

  /** 装配一个「核已 started、随后死掉」的健康检查现场。 */
  function armDeadCore(svc: any): {
    autoRestart: jest.Mock;
    events: Array<{ errorCode?: string }>;
    errorPayloads: Array<{ errorCode?: string }>;
  } {
    svc.startedViaWrapper = true;
    svc.singboxPid = 4321;
    svc.pid = 4321;
    svc.logToManager = () => {};
    svc.isProcessAliveAsync = async () => false; // 核已死
    svc.getProcessExitInfo = () => '';
    svc.stopLogFileWatcher = () => {};
    svc.ensureSystemProxyCleared = async () => {};
    svc.cleanup = () => {};
    svc.reconcileLoginFallback = () => {};
    svc.selectedExitBackendState = () => null;
    const autoRestart = jest.fn();
    svc.attemptAutoRestart = autoRestart;
    svc.shouldAutoRestart = () => true;
    const events: Array<{ errorCode?: string }> = [];
    svc.sendEventToRenderer = (_ch: string, d: { errorCode?: string }) => events.push(d);
    // 收集 'error' payload：index.ts 靠它的 errorCode 决定跳过核心自动回滚，契约的生产者侧必须有断言。
    const errorPayloads: Array<{ errorCode?: string }> = [];
    svc.on('error', (e: { errorCode?: string }) => errorPayloads.push(e));
    svc.startupLogOffset = 0;
    return { autoRestart, events, errorPayloads };
  }

  it('地址冲突 → 短路自动重启，发 TUN_INIT_PERSISTENT 终态', async () => {
    // 变异守卫：短路块被删/接回 handleProcessExit → attemptAutoRestart 被调用，本例失败。
    const svc = makeSvc();
    const { autoRestart, events, errorPayloads } = armDeadCore(svc);
    fsSync.writeFileSync(getSingBoxStartupLogPath(), ADDR_CONFLICT_FATAL, 'utf-8');

    await svc.performHealthCheck();

    expect(autoRestart).not.toHaveBeenCalled();
    expect(events.some((e) => e.errorCode === 'TUN_INIT_PERSISTENT')).toBe(true);
    expect(svc.lastStartupFatal?.kind).toBe('tun-address-conflict');
    // 契约生产者侧：'error' payload 必须携 errorCode，index.ts 据此跳过核心自动回滚（地址冲突是环境问题、
    // 与核版本无关，回滚健康的新核纯属误伤）。变异守卫：漏带该字段 → 本断言失败。
    expect(errorPayloads.some((e) => e.errorCode === 'TUN_INIT_PERSISTENT')).toBe(true);
  });

  it('非地址冲突的核死 → 自动重启照旧（不误伤既有崩溃恢复）', async () => {
    const svc = makeSvc();
    const { autoRestart } = armDeadCore(svc);
    fsSync.writeFileSync(
      getSingBoxStartupLogPath(),
      'FATAL[0000] start service: start inbound/mixed[mixed-in]: listen tcp: bind: address already in use',
      'utf-8'
    );

    await svc.performHealthCheck();

    expect(autoRestart).toHaveBeenCalled();
  });

  it('无 FATAL 的核死 → 自动重启照旧', async () => {
    const svc = makeSvc();
    const { autoRestart } = armDeadCore(svc);

    await svc.performHealthCheck();

    expect(autoRestart).toHaveBeenCalled();
  });

  it('非 TUN 模式不短路（FATAL 可能来自上一次 TUN 会话）', async () => {
    const svc = makeSvc();
    svc.currentConfig = { proxyModeType: 'systemProxy', servers: [], tunConfig: {} };
    const { autoRestart } = armDeadCore(svc);
    fsSync.writeFileSync(getSingBoxStartupLogPath(), ADDR_CONFLICT_FATAL, 'utf-8');

    await svc.performHealthCheck();

    expect(autoRestart).toHaveBeenCalled();
  });
});

describe('issue #324 H-2 — 确定性终态绝不进重试循环', () => {
  it('CoreStartTunPersistentError → shouldRetry=false', () => {
    // 变异守卫：删掉 shouldRetryStartError 里的 instanceof 守卫 → 终态被重试：每腿重弹 UAC、空等
    // waitForPidFile 60s、重复发诊断卡，恰是本 issue 要消灭的 UX。R2 复审指出这条当时是活逃逸
    // （3485 例全绿却杀不掉），故必须有专门用例。
    const svc = makeSvc();
    expect(svc.shouldRetryStartError(new CoreStartTunPersistentError())).toBe(false);
  });

  it('终态文案不靠词表匹配（词表命中与否都不影响判定）', () => {
    // 判据是 instanceof，不是文案——终态文案里没有任何 NON_RETRYABLE_START_ERROR_PATTERNS 的词，
    // 若哪天有人把守卫改回文案匹配，这条会挂。
    const svc = makeSvc();
    const terminal = new CoreStartTunPersistentError('TUN 地址 172.19.0.1 已被占用。');
    expect(startMessageIsNonRetryable(terminal.message)).toBe(false);
    expect(svc.shouldRetryStartError(terminal)).toBe(false);
  });

  it('被接管（Superseded）→ 不重试；普通可重试错误 → 重试', () => {
    const svc = makeSvc();
    expect(svc.shouldRetryStartError(new CoreStartSupersededError())).toBe(false);
    expect(
      svc.shouldRetryStartError(
        new CoreStartRetryError('sing-box 启动期退出（TUN 初始化未完成），正在自动重试')
      )
    ).toBe(true);
  });
});

describe('issue #324 M-2 — performHealthCheck 的世代守卫', () => {
  afterEach(() => {
    try {
      fsSync.unlinkSync(getSingBoxStartupLogPath());
    } catch {
      /* 文件可能不存在 */
    }
  });

  it('探活期间用户手动重连（新 start 接管）→ 本 tick 让位，不清状态不发终态', async () => {
    // isRestarting 只挡自动重启腿，不挡手动重连。变异守卫：去掉世代守卫 → 本 tick 会对着在途的新 start
    // 执行 cleanup + emit 'error'/'stopped'，把一次本可能成功的启动打掉并发终态卡。
    const svc = makeSvc();
    svc.startedViaWrapper = true;
    svc.singboxPid = 4321;
    svc.pid = 4321;
    svc.logToManager = () => {};
    const gen = svc.lifecycleGeneration;
    svc.isProcessAliveAsync = async () => {
      svc.lifecycleGeneration = gen + 1; // 探活期间新 start 接管
      return false;
    };
    const autoRestart = jest.fn();
    svc.attemptAutoRestart = autoRestart;
    svc.shouldAutoRestart = () => true;
    const cleanup = jest.fn();
    svc.cleanup = cleanup;
    const events: unknown[] = [];
    svc.sendEventToRenderer = (_ch: string, d: unknown) => events.push(d);
    svc.on('error', () => {});
    fsSync.writeFileSync(getSingBoxStartupLogPath(), ADDR_CONFLICT_FATAL, 'utf-8');
    svc.startupLogOffset = 0;

    await svc.performHealthCheck();

    expect(autoRestart).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
});

/**
 * 懒预检（`tunAddressAvoidanceArmed`）落地后，`startTunAddressPreflight` 默认直接返回 null。
 * 下面两组验的是**预检自身的语义**（旧核在跑就沿用上次 / prev 的捕获与复位顺序），故一律先武装；
 * 「默认不探」这条闸门本身由后面独立一组守，两者不混。
 */
function armedSvc(): any {
  const svc = makeSvc();
  svc.tunAddressAvoidanceArmed = true;
  return svc;
}

describe('issue #324 M-1 — 旧核仍在跑时跳过地址探测（防 mac/linux 地址漂移）', () => {
  const tunCfg = { proxyModeType: 'tun', servers: [], tunConfig: {} };

  it('旧核在跑 → 跳过探测（不让自家 TUN 地址被探成冲突）', async () => {
    // 变异守卫：去掉这道闸 → supersede 交错（用户连点连接）时自家 utun 上的 172.19.0.1 被探成 in-use →
    // 新腿静默切备选、下次正常重启又切回，R1-H1 的地址乒乓在 mac/linux 复活。
    const svc = armedSvc();
    svc.activeCorePid = () => 4321;
    const probe = jest.fn();
    svc.probeIpv4AddressUsage = probe;

    await svc.startTunAddressPreflight(tunCfg, true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('旧核在跑且上次避让过 → 沿用上次地址，绝不回落默认', async () => {
    // 变异守卫：闸中 return null（回落平台默认）→ 在默认地址真冲突的机器上（#324 报告者型），用户连点重连
    // 就会把已经工作着的避让扔掉、再撞一次同一条 FATAL，还给出「请禁用网卡」的假终态。这是 R2→R3 之间
    // 被 review 抓出的真回归。
    const svc = armedSvc();
    svc.activeCorePid = () => 4321;
    svc.probeIpv4AddressUsage = jest.fn();

    svc.effectiveTunInet4Address = '172.20.0.1'; // 上一次 start 避让到的地址
    const pick = await svc.startTunAddressPreflight(tunCfg, true);
    expect(pick?.address).toBe('172.20.0.1');
    expect(pick?.reason).toBe('default'); // 延续既有选择，不是新决策 → 调用方零日志
  });

  it('旧核在跑但从未避让过 → null（回落平台默认，行为零变化）', async () => {
    const svc = armedSvc();
    svc.activeCorePid = () => 4321;
    svc.probeIpv4AddressUsage = jest.fn();

    await expect(svc.startTunAddressPreflight(tunCfg, true)).resolves.toBeNull();
  });

  it('无旧核 → 正常探测（prev 不干扰重新决策）', async () => {
    const svc = armedSvc();
    svc.activeCorePid = () => null;
    svc.probeIpv4AddressUsage = async () => 'free';

    svc.effectiveTunInet4Address = '172.20.0.1';
    const pick = await svc.startTunAddressPreflight(tunCfg, true);
    expect(pick?.address).toBe('172.19.0.1'); // 探测说默认可用就用默认，不被 prev 钉死
  });

  it('非 TUN / 用户已显式配地址 → 不探测', async () => {
    const svc = armedSvc();
    svc.activeCorePid = () => null;
    const probe = jest.fn();
    svc.probeIpv4AddressUsage = probe;

    await expect(svc.startTunAddressPreflight(tunCfg, false)).resolves.toBeNull();
    await expect(
      svc.startTunAddressPreflight({ ...tunCfg, tunConfig: { inet4Address: '10.7.7.1/24' } }, true)
    ).resolves.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('issue #324 M-1 — prev 的捕获与复位归属预检方法本身（接线可测）', () => {
  const tunCfg = { proxyModeType: 'tun', servers: [], tunConfig: {} };

  it('方法内复位 effectiveTunInet4Address（调用方不必也不该再 reset）', async () => {
    const svc = armedSvc();
    svc.effectiveTunInet4Address = '172.20.0.1';
    svc.activeCorePid = () => null;
    svc.probeIpv4AddressUsage = async () => 'free';

    await svc.startTunAddressPreflight(tunCfg, true);
    // 复位发生在方法入口：本次决策由探测重新给出，不残留上次的值。
    expect(svc.effectiveTunInet4Address).toBeNull();
  });

  it('捕获发生在复位之前 —— 旧核在跑时才能沿用上次地址', async () => {
    // 变异守卫：把捕获挪到复位之后（或写死 null）→ prev 恒 null → 真冲突机器上 supersede 重连回落默认。
    // 这条逃逸在 prev 由调用方传参时无门可拦（测试直调方法体会绕过捕获），故把两步收进本方法。
    const svc = armedSvc();
    svc.effectiveTunInet4Address = '172.31.0.1';
    svc.activeCorePid = () => 4321;
    svc.probeIpv4AddressUsage = jest.fn();

    const pick = await svc.startTunAddressPreflight(tunCfg, true);
    expect(pick?.address).toBe('172.31.0.1');
  });
});

/**
 * B4 的全部收益就是三个接线值：就绪节拍 50ms、探活节拍 500ms、探活走异步腿。
 * 复审实测：这三处在全仓 3786 条测试里**零覆盖**，逐个回退全绿（M1/M2/M3）——门建在了被调函数
 * （`core-readiness` 纯函数层自己传参）上，没建在生产调用点上，典型「两扇门之间的缝」。
 */
describe('B4 接线 — 就绪门必须按这三个值调用（复审 High）', () => {
  it('waitForCoreReadyOrThrow 传给 waitForCoreReady 的 opts 恒为 {12000, 50, 500}', async () => {
    const svc = armedSvc();
    svc.coreReadyProbe = async () => true; // 首轮即就绪，尽快收束
    const mod = require('../core-readiness');
    const spy = jest.spyOn(mod, 'waitForCoreReady');

    try {
      await svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
      expect(spy).toHaveBeenCalledTimes(1);
      // 变异守卫：CORE_READY_POLL_MS 回 500 / CORE_READY_ALIVE_POLL_MS 回 50 / 删 alivePollMs → 任一即红
      expect(spy.mock.calls[0][0]).toEqual({
        timeoutMs: 12000,
        pollMs: 50,
        alivePollMs: 500,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('探活腿必须走异步版 isProcessAliveAsync（同步版会用 execSync 堵住 event loop）', async () => {
    const svc = armedSvc();
    const asyncProbe = jest.fn(async () => true);
    svc.isProcessAliveAsync = asyncProbe;
    svc.isProcessAlive = jest.fn(() => {
      throw new Error('就绪门不得触碰同步探活腿');
    });
    svc.coreReadyProbe = jest
      .fn()
      .mockResolvedValueOnce(false) // 首轮未就绪 → 触发一次探活
      .mockResolvedValue(true);

    await svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);

    // 变异守卫：接线换回 `this.isProcessAlive(pid)` → 同步桩抛错 → 红
    expect(asyncProbe).toHaveBeenCalled();
    expect(svc.isProcessAlive).not.toHaveBeenCalled();
  });
});

/**
 * issue #324 P0-2「懒预检」：默认乐观起核不探测，撞了地址冲突才武装并重跑一遍。
 *
 * 为什么要有这组门：改动把一笔**每台机每次起核都付**的 681–760ms（真机实测的 PowerShell `Get-NetIPAddress`）
 * 换成了「少数机器多起一遍核」。这笔交换只有在**撞了真的会重跑、且只重跑一次**时才成立——两条都失守的话，
 * 表现分别是「#324 的 FATAL 直接回归成终态、避让机制等于删了」和「无限重起循环」，都比原来糟。
 */
describe('issue #324 P0-2 — 懒预检闸门（默认不探）', () => {
  const tunCfg = { proxyModeType: 'tun', servers: [], tunConfig: {} };

  it('未武装 → 不探测、返回 null（这才是省下那 681–760ms 的地方）', async () => {
    const svc = makeSvc();
    svc.activeCorePid = () => null;
    const probe = jest.fn();
    svc.probeIpv4AddressUsage = probe;

    await expect(svc.startTunAddressPreflight(tunCfg, true)).resolves.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('武装后 → 正常探测（闸门只挡「探不探」，不改探测语义）', async () => {
    const svc = makeSvc();
    svc.activeCorePid = () => null;
    svc.tunAddressAvoidanceArmed = true;
    const probe = jest.fn(async () => 'free');
    svc.probeIpv4AddressUsage = probe;

    const pick = await svc.startTunAddressPreflight(tunCfg, true);
    expect(pick?.address).toBe('172.19.0.1');
    expect(probe).toHaveBeenCalled();
  });

  it('闸门在 effectiveTunInet4Address 复位**之后**——上次避让的地址绝不粘到这次', async () => {
    // 变异守卫：把 `if (!armed) return null` 提到复位之前 → 未武装的那一遍会带着上次选的 172.20.0.1 起核。
    // 那不是「行为零变化」，而是把一次性的避让变成了永久粘滞，且没有任何一遍会重新验证它还对不对。
    const svc = makeSvc();
    svc.activeCorePid = () => null;
    svc.probeIpv4AddressUsage = jest.fn();
    svc.effectiveTunInet4Address = '172.20.0.1';

    await svc.startTunAddressPreflight(tunCfg, true);
    expect(svc.effectiveTunInet4Address).toBeNull();
  });
});

describe('issue #324 P0-2 — 撞了才避：startWithTunAddressAvoidance', () => {
  const cfg: any = { proxyModeType: 'tun', servers: [], selectedServerId: '__direct__' };

  /** 让 startInternal 变成可编排的桩：按次序抛/返回，并记录每次进入时的武装状态。 */
  function stubStarts(
    svc: any,
    plan: Array<Error | null>
  ): { armedAt: boolean[]; calls: () => number } {
    const armedAt: boolean[] = [];
    svc.startInternal = jest.fn(async () => {
      const step = plan[armedAt.length];
      armedAt.push(svc.tunAddressAvoidanceArmed);
      if (step) throw step;
    });
    return { armedAt, calls: () => armedAt.length };
  }

  const conflictErr = (): Error => new CoreStartTunPersistentError('TUN 地址已被占用');

  it('地址冲突终态 → 武装后重跑一遍 startInternal，第二遍成功即整体成功', async () => {
    const svc = makeSvc();
    svc.lastStartupFatal = { kind: 'tun-address-conflict', raw: 'set ipv4 address', message: 'x' };
    const h = stubStarts(svc, [conflictErr(), null]);

    await expect(svc.startWithTunAddressAvoidance(cfg, {})).resolves.toBeUndefined();
    expect(h.calls()).toBe(2);
    // 第一遍必须**未**武装（否则那 681–760ms 又回到所有人身上），第二遍必须已武装（否则重跑毫无意义）
    expect(h.armedAt).toEqual([false, true]);
  });

  it('只重跑一次：第二遍再撞照常上抛，不无限重起', async () => {
    const svc = makeSvc();
    svc.lastStartupFatal = { kind: 'tun-address-conflict', raw: 'set ipv4 address', message: 'x' };
    const h = stubStarts(svc, [conflictErr(), conflictErr()]);

    await expect(svc.startWithTunAddressAvoidance(cfg, {})).rejects.toBeInstanceOf(
      CoreStartTunPersistentError
    );
    expect(h.calls()).toBe(2);
  });

  it('同为终态但**不是**地址冲突（如 wintun 创建失败）→ 不重跑', async () => {
    const svc = makeSvc();
    svc.lastStartupFatal = { kind: 'tun-adapter-create', raw: 'create adapter', message: 'x' };
    const h = stubStarts(svc, [new CoreStartTunPersistentError('适配器创建失败'), null]);

    await expect(svc.startWithTunAddressAvoidance(cfg, {})).rejects.toBeInstanceOf(
      CoreStartTunPersistentError
    );
    expect(h.calls()).toBe(1);
  });

  it('瞬态族（CoreStartRetryError）→ 不重跑（它还在起核重试预算里，不该被这条腿抢走）', async () => {
    const svc = makeSvc();
    svc.lastStartupFatal = { kind: 'tun-address-conflict', raw: 'set ipv4 address', message: 'x' };
    const h = stubStarts(svc, [new CoreStartRetryError('起核较慢'), null]);

    await expect(svc.startWithTunAddressAvoidance(cfg, {})).rejects.toBeInstanceOf(
      CoreStartRetryError
    );
    expect(h.calls()).toBe(1);
  });

  it('让位（superseded）→ 不重跑（接管方拥有状态，重入会与它抢适配器/端口）', async () => {
    const svc = makeSvc();
    svc.lastStartupFatal = { kind: 'tun-address-conflict', raw: 'set ipv4 address', message: 'x' };
    const h = stubStarts(svc, [new CoreStartSupersededError(), null]);

    await expect(svc.startWithTunAddressAvoidance(cfg, {})).rejects.toBeInstanceOf(
      CoreStartSupersededError
    );
    expect(h.calls()).toBe(1);
  });

  it('入口复位武装位：上一次 start 遗留的 true 不得让这一次首遍就付探测的钱', async () => {
    const svc = makeSvc();
    svc.tunAddressAvoidanceArmed = true; // 上一次 start 留下的
    const h = stubStarts(svc, [null]);

    await svc.startWithTunAddressAvoidance(cfg, {});
    expect(h.armedAt).toEqual([false]);
  });
});

/**
 * B6：把 `coreReady` 那一格拆细 + 把核日志的清空前移到 spawn 之前。
 *
 * 两件事同一个由来。真机把起核压到 ~4.3s 之后，`L1.coreReady:ready` 剩 2.3–2.8s，占了一半以上；抢救出来的核
 * 日志显示核自报 `sing-box started (0.93s)`，也就是说那一格里**大部分不是核在初始化**。而之所以要「抢救」，
 * 是因为清空日志的动作长在 `startLogFileWatcher()` 里、那又是就绪之后才调的——核自己的启动日志每轮刚写完就被抹掉。
 *
 * 这一组守的就是这两条：新格子确实打得出来（否则下一轮又只能靠外部抢快照），以及清空确实发生在起核之前。
 */
describe('B6：核日志清空前移到 spawn 之前', () => {
  const fsSync = require('fs');

  it('truncateCoreLogFile 清空文件并把 watcher 读游标复位到 0', () => {
    const svc = makeSvc();
    const p = svc.getLogFilePath();
    fsSync.mkdirSync(path.dirname(p), { recursive: true });
    fsSync.writeFileSync(p, '上一轮的残留\n');
    svc.lastLogFileSize = 12345;

    svc.truncateCoreLogFile();

    expect(fsSync.readFileSync(p, 'utf-8')).toBe('');
    expect(svc.lastLogFileSize).toBe(0);
  });

  it('startLogFileWatcher **不再**清空文件——那正是核启动日志被抹掉的原因', async () => {
    const svc = makeSvc();
    const p = svc.getLogFilePath();
    fsSync.mkdirSync(path.dirname(p), { recursive: true });
    // 模拟「核已经把本腿的启动日志写进来了」，此刻 watcher 才启动（真实时序：就绪之后）
    fsSync.writeFileSync(p, '+0800 INFO sing-box started (0.93s)\n');

    svc.startLogFileWatcher();
    try {
      // 变异守卫：把 writeFileSync(logFilePath, '') 放回 startLogFileWatcher → 这里读到空串
      expect(fsSync.readFileSync(p, 'utf-8')).toContain('sing-box started (0.93s)');
      // 且游标从 0 起，本腿启动日志会被完整投递进 app.log（而不是被跳过）
      expect(svc.lastLogFileSize).toBe(0);
    } finally {
      svc.stopLogFileWatcher();
    }
  });

  it('startSingBoxProcess 在交给任何启动支路**之前**就已清空', async () => {
    const order: string[] = [];
    const svc = makeSvc();
    svc.currentConfig = { proxyModeType: 'tun', servers: [], tunConfig: {} };
    svc.truncateCoreLogFile = jest.fn(() => order.push('truncate'));
    svc.waitForOwnTunAdapterReleased = jest.fn(async () => {});
    svc.helperManager = { isReady: jest.fn(async () => true), stopCore: jest.fn() };
    // 直接钉住分支判定，避免本用例依赖 needsRootPrivilege / needsLinuxTun 的内部条件——
    // 它们各有各的门，混进来会让这条「顺序」判据在别人改那些门时莫名其妙地红。
    svc.needsOsascript = () => false;
    svc.needsWindowsUAC = () => true;
    // 哨兵必须用 CoreStartRetryError：helper 分支的 catch 会**吞掉**普通错误并回落 UAC 路径，
    // 用普通 Error 的话本用例会一路跑到后面的支路上去，测出来的就不是「顺序」而是别的东西。
    svc.startViaHelper = jest.fn(async () => {
      order.push('launch');
      throw new CoreStartRetryError('停在这里即可，本用例只看顺序');
    });

    await withPlatformAsync('win32', async () => {
      await expect(svc.startSingBoxProcess(svc.lifecycleGeneration)).rejects.toThrow('停在这里即可');
    });

    // 变异守卫：把 truncateCoreLogFile() 挪回就绪之后（或删掉）→ order 不再是 ['truncate','launch']
    expect(order).toEqual(['truncate', 'launch']);
  });
});

/**
 * B6：`coreReady` 那一格的细分埋点。
 * 要回答的问题是「那两秒里，管理 API 到底是还没开、还是开了没被及时发现」——首次就绪探测的结果就是判据。
 */
describe('B6：首次就绪探测单独一格（readyProbe0）', () => {
  function withTimeline(svc: any): StartTimeline {
    const tl = new StartTimeline();
    svc.startTimeline = tl;
    return tl;
  }

  it('首探即 true → 打 readyProbe0:true（说明门进来时端口早已通，钱花在门之前）', async () => {
    const svc = makeSvc();
    armTun(svc);
    const tl = withTimeline(svc);
    svc.coreReadyProbe = jest.fn(async () => true);
    svc.adapterPresenceProbe = jest.fn(async () => 'present' as AdapterPresence);
    svc.isProcessAliveAsync = async () => true;

    await svc.waitForCoreReadyOrThrow(4321, svc.lifecycleGeneration);

    const labels = tl.phases().map((p: { label: string }) => p.label);
    expect(labels).toContain('readyProbe0:true');
  });

  it('首探 false → 打 readyProbe0:false（coreReady 那一格量的才真是「等端口开」）', async () => {
    const svc = makeSvc();
    armTun(svc);
    const tl = withTimeline(svc);
    let n = 0;
    svc.coreReadyProbe = jest.fn(async () => ++n > 1); // 首探 false，第二探 true
    svc.adapterPresenceProbe = jest.fn(async () => 'present' as AdapterPresence);
    svc.isProcessAliveAsync = async () => true;

    await svc.waitForCoreReadyOrThrow(4321, svc.lifecycleGeneration);

    const labels = tl.phases().map((p: { label: string }) => p.label);
    expect(labels).toContain('readyProbe0:false');
  });

  it('只打一次——后续轮次不再打点（否则病态路径下会把时间轴刷爆）', async () => {
    const svc = makeSvc();
    armTun(svc);
    const tl = withTimeline(svc);
    let n = 0;
    svc.coreReadyProbe = jest.fn(async () => ++n > 5); // 前 5 探 false
    svc.adapterPresenceProbe = jest.fn(async () => 'present' as AdapterPresence);
    svc.isProcessAliveAsync = async () => true;

    await svc.waitForCoreReadyOrThrow(4321, svc.lifecycleGeneration);

    const marks = tl
      .phases()
      .map((p: { label: string }) => p.label)
      .filter((l: string) => l.startsWith('readyProbe0'));
    expect(marks).toEqual(['readyProbe0:false']);
  });
});

/**
 * B6：`aliveCheck` 格（写 PID 文件 + 一次同步探活）。
 * 它原先没有自己的格子，耗时被整片记进 `coreReady` —— 于是那一格看起来像「核起得慢」，
 * 实则掺着主进程被 `execSync`（cmd.exe + tasklist，真机 81–160ms）堵住的时间。
 */
describe('B6：aliveCheck 单独一格', () => {
  it('startViaHelper 在探活之后、就绪门之前打 aliveCheck，且早于 coreReady 那一格', async () => {
    const svc = makeSvc();
    // singboxPath 必须真实存在：startViaHelper 顶部有 existsSync 早退
    const realBin = path.join(TMP, 'fake-sing-box');
    fsSync.writeFileSync(realBin, 'x');
    svc.singboxPath = realBin;
    svc.currentConfig = { proxyModeType: 'tun', servers: [], allowLan: false, tunConfig: {} };
    svc.helperManager = { startCore: jest.fn(async () => ({ ok: true, pid: 4321 })) };
    svc.isProcessAlive = jest.fn(() => true);
    // 就绪门本身在别处测；这里只看它**之前**的那一格确实打了
    svc.waitForCoreReadyOrThrow = jest.fn(async () => {});
    svc.startLogFileWatcher = jest.fn();
    svc.startHealthCheck = jest.fn();
    svc.sendEventToRenderer = jest.fn();

    const tl = new StartTimeline();
    svc.startTimeline = tl;
    await svc.startViaHelper(svc.lifecycleGeneration);

    const labels = tl.phases().map((p: { label: string }) => p.label);
    // 变异守卫：删掉 markStartLeg(startGen, 'aliveCheck') → 这条红
    expect(labels).toContain('aliveCheck');
    expect(labels.indexOf('spawn')).toBeLessThan(labels.indexOf('aliveCheck'));
    expect(svc.isProcessAlive).toHaveBeenCalledWith(4321);
  });
});
