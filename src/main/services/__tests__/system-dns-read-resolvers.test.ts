/**
 * Windows 侧「读接管前 LAN 解析器」（方案B，`getLanResolverForDns` 的取数腿）单测。
 *
 * 为什么单开一组：这段跑在**起核关键路径**上——真机埋点 `lanResolver` 一格 391–873ms，拆格后已证明成本
 * 全在这里（同格里的同步 fs 归一恒 0ms）。它被改成「并行 + execFile」，而这两点都有**只在真机才显形**的
 * 退化方式：改回串行只是变慢（测不出耗时，得按发起形态钉）；改回 `exec` 会多起一个 cmd.exe 且把接口名
 * 重新塞进 shell 命令行（名字可含空格/`&`）。另外并行最容易顺手带进来的错误是**结果乱序**——
 * `pickLanResolverIp` 取第一个私网地址，乱序会让多网卡机器选到别的网卡的解析器，那是行为变化不是提速。
 */
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  const util = jest.requireActual('util');
  const execFile = jest.fn();
  // promisify 认 fn[util.promisify.custom]；真 execFile 自带，jest.fn 不带 → 不补的话 promisify 会退回
  // 「回调首值」语义，`{ stdout }` 解构直接拿到 undefined，测出来的是夹具的毛病而不是被测代码的。
  Object.defineProperty(execFile, util.promisify.custom, {
    value: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        execFile(...args, (err: unknown, stdout: string, stderr: string) =>
          err ? reject(err) : resolve({ stdout, stderr })
        );
      }),
  });
  return { ...actual, execFile, exec: jest.fn() };
});

import { execFile, exec } from 'child_process';
import { WindowsSystemDns } from '../SystemDnsManager';

/** 只替换 listTargets（protected），其余走真实实现——被测的正是 readEffectiveResolvers 本身。 */
class TestWinDns extends WindowsSystemDns {
  constructor(private readonly ifaces: string[]) {
    super();
  }
  protected async listTargets(): Promise<string[]> {
    return this.ifaces;
  }
  public read(): Promise<string[]> {
    return this.readEffectiveResolvers();
  }
}

type Cb = (e: Error | null, stdout: string, stderr: string) => void;

/** 让出到宏任务，等被测代码把 `await listTargets()` 之后的同步发起跑完。 */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** 按接口名给定「netsh 输出 或 抛错」，并记录每次调用的 argv；返回可手动放行的 resolver。 */
function stubExecFile(plan: Record<string, string | Error>): {
  argv: string[][];
  release: () => void;
  pending: () => number;
} {
  const argv: string[][] = [];
  const queued: Array<() => void> = [];
  (execFile as unknown as jest.Mock).mockImplementation(
    (_bin: string, args: string[], _opts: unknown, cb: Cb) => {
      argv.push(args);
      const iface = String(args[args.length - 1]).replace(/^name=/, '');
      const v = plan[iface];
      // 不立即回调：攒住，由用例决定放行时机 → 可据此断言「所有调用在任一结果返回前就已发出」（= 并行）。
      queued.push(() => (v instanceof Error ? cb(v, '', '') : cb(null, String(v ?? ''), '')));
      return undefined as never;
    }
  );
  return {
    argv,
    release: () => {
      // 逆序放行：后发起的先返回，制造「完成顺序 ≠ 发起顺序」，专打乱序合并那条变异。
      const all = queued.splice(0).reverse();
      for (const f of all) f();
    },
    pending: () => queued.length,
  };
}

/** netsh `show dnsservers` 的真机输出形态（本地化文案不影响 IPv4 提取）。 */
function dnsOut(iface: string, ...ips: string[]): string {
  const head = `接口 "${iface}" 的配置`;
  const body = ips.length
    ? [`    静态配置的 DNS 服务器:            ${ips[0]}`, ...ips.slice(1).map((i) => `                                      ${i}`)]
    : ['    静态配置的 DNS 服务器:            无'];
  return [head, ...body, ''].join('\r\n');
}

beforeEach(() => {
  (execFile as unknown as jest.Mock).mockReset();
  (exec as unknown as jest.Mock).mockReset();
});

describe('WindowsSystemDns.readEffectiveResolvers', () => {
  it('逐接口读取并按**接口原序**合并去重（完成顺序不得影响结果顺序）', async () => {
    const h = stubExecFile({
      以太网: dnsOut('以太网', '192.168.10.1', '223.5.5.5'),
      'Wi-Fi': dnsOut('Wi-Fi', '10.0.0.1', '223.5.5.5'),
    });
    const p = new TestWinDns(['以太网', 'Wi-Fi']).read();
    await flush();
    h.release(); // 逆序放行：Wi-Fi 先返回
    // 变异守卫：改成「按完成顺序 push」→ 这里会变成 10.0.0.1 打头，
    // 于是 pickLanResolverIp 在多网卡机器上选到另一张网卡的解析器。
    await expect(p).resolves.toEqual(['192.168.10.1', '223.5.5.5', '10.0.0.1']);
  });

  it('所有接口的查询在任一结果返回前就已发出（并行，不是串行）', async () => {
    const h = stubExecFile({
      a: dnsOut('a', '192.168.1.1'),
      b: dnsOut('b', '192.168.2.1'),
      c: dnsOut('c', '192.168.3.1'),
    });
    const p = new TestWinDns(['a', 'b', 'c']).read();
    await flush(); // 让 map 里的同步发起跑完
    // 变异守卫：改回 `for … await` 串行 → 此刻只会有 1 条在飞
    expect(h.pending()).toBe(3);
    expect(h.argv).toHaveLength(3);
    h.release();
    await p;
  });

  it('走 execFile 且 argv 形态固定；接口名不带引号（无 shell，引号会被 netsh 当字面量）', async () => {
    const h = stubExecFile({ 'Wi-Fi 2': dnsOut('Wi-Fi 2', '192.168.5.1') });
    const p = new TestWinDns(['Wi-Fi 2']).read();
    await flush();
    h.release();
    await p;
    expect(h.argv[0]).toEqual(['interface', 'ipv4', 'show', 'dnsservers', 'name=Wi-Fi 2']);
    // 变异守卫：改回 `exec`（cmd.exe 解析命令行）→ 每接口多一次进程创建，且接口名重回 shell 拼接面
    expect(exec as unknown as jest.Mock).not.toHaveBeenCalled();
  });

  it('单接口读失败不影响其余接口（fail-soft，不整体抛）', async () => {
    const h = stubExecFile({
      坏网卡: new Error('netsh 超时'),
      以太网: dnsOut('以太网', '192.168.10.1'),
    });
    const p = new TestWinDns(['坏网卡', '以太网']).read();
    await flush();
    h.release();
    await expect(p).resolves.toEqual(['192.168.10.1']);
  });

  it('全部接口都失败 → 空数组（调用方据此回落 dns-local，不是抛穿到起核流程）', async () => {
    const h = stubExecFile({ a: new Error('x'), b: new Error('y') });
    const p = new TestWinDns(['a', 'b']).read();
    await flush();
    h.release();
    await expect(p).resolves.toEqual([]);
  });
});
