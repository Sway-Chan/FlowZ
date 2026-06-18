import { isIpv4, ipv4CidrsOverlap, cidrOverlapsAny } from '../ip';

describe('isIpv4 — 严格 IPv4 字面量', () => {
  it('合法 IPv4 → true', () => {
    expect(isIpv4('8.8.8.8')).toBe(true);
    expect(isIpv4('1.1.1.1')).toBe(true);
    expect(isIpv4('192.168.1.1')).toBe(true);
    expect(isIpv4('255.255.255.255')).toBe(true);
    expect(isIpv4('0.0.0.0')).toBe(true);
  });

  it('段越界(>255)→ false（纠正原 isIpv4Host 宽松误判）', () => {
    expect(isIpv4('999.1.1.1')).toBe(false);
    expect(isIpv4('256.1.1.1')).toBe(false);
    expect(isIpv4('1.1.1.256')).toBe(false);
  });

  it('非 IPv4 形态 → false', () => {
    expect(isIpv4('example.com')).toBe(false);
    expect(isIpv4('1.2.3')).toBe(false);
    expect(isIpv4('1.2.3.4.5')).toBe(false);
    expect(isIpv4('8.8.8.8:53')).toBe(false); // 带端口非纯字面量
    expect(isIpv4('::1')).toBe(false);
    expect(isIpv4('')).toBe(false);
  });
});

describe('ipv4CidrsOverlap — IPv4 CIDR 交集', () => {
  it('包含关系 → true（无 /n 视为 /32）', () => {
    expect(ipv4CidrsOverlap('192.168.50.0/24', '192.168.50.10/32')).toBe(true);
    expect(ipv4CidrsOverlap('192.168.50.10', '192.168.50.0/24')).toBe(true); // 顺序无关
    expect(ipv4CidrsOverlap('10.0.0.0/8', '10.5.6.7/24')).toBe(true);
  });
  it('相邻/不相交 → false', () => {
    expect(ipv4CidrsOverlap('192.168.50.0/24', '192.168.51.0/24')).toBe(false);
    expect(ipv4CidrsOverlap('192.168.50.0/24', '10.0.0.0/8')).toBe(false);
  });
  it('0.0.0.0/0 覆盖一切', () => {
    expect(ipv4CidrsOverlap('0.0.0.0/0', '192.168.1.1/32')).toBe(true);
  });
  it('非法/IPv6 → false（best-effort，不误报）', () => {
    expect(ipv4CidrsOverlap('fd00::/8', '192.168.1.0/24')).toBe(false);
    expect(ipv4CidrsOverlap('999.1.1.1/24', '192.168.1.0/24')).toBe(false);
    expect(ipv4CidrsOverlap('192.168.1.0/33', '192.168.1.0/24')).toBe(false);
  });
});

describe('cidrOverlapsAny — target 与候选集任一相交', () => {
  it('命中任一 mesh 段 → true；都不命中 → false', () => {
    const mesh = ['100.64.0.0/10', '192.168.50.0/24'];
    expect(cidrOverlapsAny('192.168.50.128/25', mesh)).toBe(true);
    expect(cidrOverlapsAny('100.64.1.2/32', mesh)).toBe(true);
    expect(cidrOverlapsAny('172.16.0.0/12', mesh)).toBe(false);
    expect(cidrOverlapsAny('10.0.0.0/8', [])).toBe(false);
  });
});
