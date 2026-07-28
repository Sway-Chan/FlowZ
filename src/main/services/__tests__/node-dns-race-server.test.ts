/**
 * issue #147 本地 race DNS server 集成测（127.0.0.1 UDP loopback + 注入 mock 上游）。
 * loopback bind/send 不碰宿主网络栈（非 netns/iptables/TUN），安全。
 */
import * as dgram from 'dgram';
import { NodeDnsRaceServer } from '../node-dns-race-server';
import { encodeDnsQuery, classifyDnsResponse, decodeDnsQuestion } from '../../../shared/dns-wire';
import type { ResolvedUpstreams } from '../../../shared/node-resolver-upstreams';

const TYPE_A = 1;
const TYPE_AAAA = 28;

function questionEnd(q: Uint8Array): number {
  let off = 12;
  while (off < q.length && q[off] !== 0) {
    if ((q[off] & 0xc0) === 0xc0) return off + 2 + 4;
    off += 1 + q[off];
  }
  return off + 1 + 4;
}
function makeResponse(query: Uint8Array, kind: 'HIT' | 'EMPTY', ip = '1.2.3.4'): Uint8Array {
  const base = query.slice(0, questionEnd(query));
  let answer = new Uint8Array(0);
  let an = 0;
  if (kind === 'HIT') {
    an = 1;
    const p = ip.split('.').map((x) => parseInt(x, 10));
    answer = new Uint8Array([
      0xc0,
      0x0c,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x3c,
      0x00,
      0x04,
      p[0],
      p[1],
      p[2],
      p[3],
    ]);
  }
  const out = new Uint8Array(base.length + answer.length);
  out.set(base, 0);
  out.set(answer, base.length);
  const view = new DataView(out.buffer);
  view.setUint16(2, 0x8180);
  view.setUint16(6, an);
  return out;
}

/**
 * AAAA 查询：encodeDnsQuery 固定发 QTYPE=A，此处把包尾的 QTYPE（QCLASS 前 2 字节）改写为 28。
 * 不改 encodeDnsQuery 本体（它服务的是 #57 resolve-ahead 的 A-only 语义），测试侧构造更贴近「内核发来的
 * 任意 qtype 都要被透传」这一被测对象。
 */
function encodeAaaaQuery(domain: string, id = 0): Uint8Array {
  const q = encodeDnsQuery(domain, id);
  new DataView(q.buffer, q.byteOffset, q.byteLength).setUint16(q.length - 4, TYPE_AAAA);
  return q;
}

/** AAAA 响应：echo question + 一条 AAAA 记录（rdata=16 字节网络序）。 */
function makeAaaaResponse(query: Uint8Array, addrBytes: number[]): Uint8Array {
  const base = query.slice(0, questionEnd(query));
  const answer = Uint8Array.from([
    0xc0,
    0x0c, // name → 压缩指针指向 question qname
    0x00,
    TYPE_AAAA, // type=AAAA(28)
    0x00,
    0x01, // class=IN
    0x00,
    0x00,
    0x00,
    0x3c, // ttl=60
    0x00,
    0x10, // rdlength=16
    ...addrBytes,
  ]);
  const out = new Uint8Array(base.length + answer.length);
  out.set(base, 0);
  out.set(answer, base.length);
  const view = new DataView(out.buffer);
  view.setUint16(2, 0x8180);
  view.setUint16(6, 1);
  return out;
}

function sendQuery(port: number, query: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      c.close();
      reject(new Error('client timeout'));
    }, 3000);
    c.on('message', (msg) => {
      clearTimeout(timer);
      c.close();
      resolve(new Uint8Array(msg));
    });
    c.on('error', (e) => {
      clearTimeout(timer);
      c.close();
      reject(e);
    });
    c.send(query, port, '127.0.0.1');
  });
}

const TIER1: ResolvedUpstreams = {
  tier1: [{ id: 'ali', kind: 'doh', tier: 1, ip: '0.0.0.0' }],
  tier2: [],
  directIps: [],
};

describe('NodeDnsRaceServer (loopback)', () => {
  // review M1：afterEach 兜底关 server——失败时（try 外的 expect 抛）也不漏 UDP socket，杜绝 jest open-handle。
  let server: NodeDnsRaceServer | undefined;
  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  it('内核 query → race HIT 透传回内核 + id 回填', async () => {
    server = new NodeDnsRaceServer({
      queryFn: async (_up, query) => makeResponse(query, 'HIT', '7.7.7.7'),
    });
    const port = await server.start(TIER1);
    expect(port).toBeGreaterThan(0);
    expect(server.isRunning()).toBe(true);
    try {
      const q = encodeDnsQuery('a.example.com', 0x1234);
      const resp = await sendQuery(port, q);
      expect(classifyDnsResponse(resp, 1)).toBe('HIT');
      expect(decodeDnsQuestion(resp)?.id).toBe(0x1234);
      expect(Array.from(resp.slice(-4))).toEqual([7, 7, 7, 7]);
    } finally {
      server.stop();
    }
    expect(server.isRunning()).toBe(false);
  });

  it('全上游 FAIL → 回 SERVFAIL（不挂死，内核拿得到答案）', async () => {
    server = new NodeDnsRaceServer({
      queryFn: async () => {
        throw new Error('upstream down');
      },
    });
    const port = await server.start(TIER1);
    try {
      const q = encodeDnsQuery('b.example.com', 0x55);
      const resp = await sendQuery(port, q);
      const view = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
      expect(view.getUint16(2) & 0x000f).toBe(2); // SERVFAIL
      expect(decodeDnsQuestion(resp)?.id).toBe(0x55);
    } finally {
      server.stop();
    }
  });

  it('setUpstreams 热更上游（无需重启）', async () => {
    server = new NodeDnsRaceServer({
      queryFn: async (up, query) =>
        makeResponse(query, 'HIT', up.id === 'dnspod' ? '2.2.2.2' : '1.1.1.1'),
    });
    const port = await server.start(TIER1);
    try {
      server.setUpstreams({
        tier1: [{ id: 'dnspod', kind: 'doh', tier: 1, ip: '0.0.0.0' }],
        tier2: [],
        directIps: [],
      });
      const resp = await sendQuery(port, encodeDnsQuery('c.example.com', 0x9));
      expect(Array.from(resp.slice(-4))).toEqual([2, 2, 2, 2]); // 命中热更后的 dnspod
    } finally {
      server.stop();
    }
  });

  // ── AAAA 透传（IPv6-only 域名节点修复的 race 侧半边）─────────────────────────────────────
  // dial 侧结构化 domain_resolver 让内核对节点域名发出 AAAA 查询后，这些查询会落到本 race server；
  // race server 必须原样透传（qtype 不改写、AAAA 答案不丢弃），否则修复在 race-on 档（默认档）失效。
  // 本文件此前**零 AAAA 覆盖**——「顺手把 race server 改成全局拒 AAAA」在补测前无门可挡。
  it('AAAA 查询 → qtype 原样送到上游、AAAA 答案完整透传回内核（16 字节 rdata + id 回填）', async () => {
    const seen: number[] = [];
    // ::1 的 16 字节网络序（AAAA-only 域名的典型答案形态）
    const V6 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    server = new NodeDnsRaceServer({
      queryFn: async (_up, query) => {
        // 断言 race 层未把内核的 AAAA 改写成 A（改写=修复静默失效）
        seen.push(decodeDnsQuestion(query)!.qtype);
        return makeAaaaResponse(query, V6);
      },
    });
    const port = await server.start(TIER1);
    const q = encodeAaaaQuery('v6only.example.com', 0x4321);
    const resp = await sendQuery(port, q);
    expect(seen).toEqual([TYPE_AAAA]);
    // 三态分类按 AAAA 判 → HIT（非 EMPTY/FAIL：答案未被当作「无该 qtype 记录」丢掉）
    expect(classifyDnsResponse(resp, TYPE_AAAA)).toBe('HIT');
    expect(decodeDnsQuestion(resp)?.id).toBe(0x4321);
    expect(decodeDnsQuestion(resp)?.qtype).toBe(TYPE_AAAA);
    expect(Array.from(resp.slice(-16))).toEqual(V6); // rdata 逐字节透传，未被截断/改写
  });

  it('AAAA NODATA（域名只有 A）→ 空 NOERROR 透传，不误判 FAIL 转 SERVFAIL', async () => {
    server = new NodeDnsRaceServer({
      queryFn: async (_up, query) => makeResponse(query, 'EMPTY'),
    });
    const port = await server.start(TIER1);
    const resp = await sendQuery(port, encodeAaaaQuery('v4only.example.com', 0x77));
    const view = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
    expect(view.getUint16(2) & 0x000f).toBe(0); // RCODE=NOERROR（非 SERVFAIL=2）
    expect(classifyDnsResponse(resp, TYPE_AAAA)).toBe('EMPTY');
    expect(decodeDnsQuestion(resp)?.id).toBe(0x77);
  });

  it('A 查询不受 AAAA 补测影响：qtype=A 原样送达（对照组，防「统一改写 qtype」式误修）', async () => {
    const seen: number[] = [];
    server = new NodeDnsRaceServer({
      queryFn: async (_up, query) => {
        seen.push(decodeDnsQuestion(query)!.qtype);
        return makeResponse(query, 'HIT', '9.9.9.9');
      },
    });
    const port = await server.start(TIER1);
    const resp = await sendQuery(port, encodeDnsQuery('a4.example.com', 0x12));
    expect(seen).toEqual([TYPE_A]);
    expect(classifyDnsResponse(resp, TYPE_A)).toBe('HIT');
  });

  it('watchdog：socket 被动 close → 自动重建且端口不变（review #1）', async () => {
    server = new NodeDnsRaceServer({
      queryFn: async (_up, query) => makeResponse(query, 'HIT', '8.8.8.8'),
    });
    const port = await server.start(TIER1);
    // 模拟 socket 被动 close（非主动 stop）→ 'close' 事件触发 watchdog re-listen。
    (server as unknown as { socket: dgram.Socket }).socket.close();
    await new Promise((r) => setTimeout(r, 150)); // 等 re-listen 完成
    expect(server.isRunning()).toBe(true);
    expect(server.getPort()).toBe(port); // 重绑原端口（对内核透明，已烧进 config 的端口仍有效）
    const resp = await sendQuery(port, encodeDnsQuery('d.example.com', 0xab));
    expect(classifyDnsResponse(resp, 1)).toBe('HIT'); // 重建后仍正常服务
  });

  it('watchdog：stop() 后 socket close 不触发重建（closing 守卫，不留孤儿）', async () => {
    server = new NodeDnsRaceServer({
      queryFn: async (_up, query) => makeResponse(query, 'HIT'),
    });
    await server.start(TIER1);
    server.stop(); // closing=true 先于 close()：'close' 事件回调里 onSocketDown 被 closing 守卫挡
    await new Promise((r) => setTimeout(r, 150)); // 等 'close' 事件可能触发 onSocketDown
    expect(server.isRunning()).toBe(false); // 不重建
    expect(server.getPort()).toBe(0);
    expect((server as unknown as { socket: dgram.Socket | null }).socket).toBeNull();
  });
});
