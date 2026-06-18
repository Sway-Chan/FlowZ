import { isIpv4 } from '../ip';

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
