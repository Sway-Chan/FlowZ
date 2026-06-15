/**
 * isRemoteRuleSetReachable 单测（M9）：HEAD 预检的 HTTP 状态分类 + 「确定结论」缓存语义。
 *
 * 语义（见 ProxyManager.isRemoteRuleSetReachable）：
 *   - 404/403/410（确定缺失）→ false，**缓存 30min**
 *   - 2xx/3xx（存在）→ true，**缓存 6h**
 *   - 5xx/timeout/error（瞬时）→ true（乐观保留，不剪），**不缓存**（下次仍重发）
 *
 * mock https.request 回调模式；private 方法经 (svc as any).isRemoteRuleSetReachable() 直调（跟随 ruleset-prune 风格）。
 */
jest.mock('https');

import * as https from 'https';
import { ProxyManager } from '../ProxyManager';

function makeSvc(): any {
  return new ProxyManager(
    undefined as any,
    undefined as any,
    '/tmp/flowz-test-cfg.json',
    '/fake/sing-box'
  );
}

/** 配置 https.request mock：number→响应状态码；'timeout'/'error'→触发对应 req 事件。 */
function setupMock(scenario: number | 'timeout' | 'error'): void {
  (https.request as jest.Mock).mockImplementation((_opts: unknown, cb: (res: any) => void) => {
    const req = { on: jest.fn(), destroy: jest.fn(), end: jest.fn() };
    if (scenario === 'timeout') {
      setTimeout(() => req.on.mock.calls.find((c) => c[0] === 'timeout')?.[1](), 0);
    } else if (scenario === 'error') {
      setTimeout(() => req.on.mock.calls.find((c) => c[0] === 'error')?.[1](new Error('net')), 0);
    } else {
      setTimeout(() => cb({ statusCode: scenario, resume: jest.fn() }), 0);
    }
    return req;
  });
}

describe('ProxyManager.isRemoteRuleSetReachable（HEAD 预检 + 缓存）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('200 → true 且缓存（6h 内再调不重发 https）', async () => {
    setupMock(200);
    const svc = makeSvc();
    expect(await svc.isRemoteRuleSetReachable('https://x/a.srs')).toBe(true);
    expect(https.request).toHaveBeenCalledTimes(1);
    // 缓存命中：不再发请求
    expect(await svc.isRemoteRuleSetReachable('https://x/a.srs')).toBe(true);
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  it('404 → false 且缓存（确定缺失，30min 内不重发）', async () => {
    setupMock(404);
    const svc = makeSvc();
    expect(await svc.isRemoteRuleSetReachable('https://x/b.srs')).toBe(false);
    expect(https.request).toHaveBeenCalledTimes(1);
    expect(await svc.isRemoteRuleSetReachable('https://x/b.srs')).toBe(false);
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  it('403/410 → false 且缓存（同 404，确定缺失语义）', async () => {
    for (const code of [403, 410]) {
      setupMock(code);
      const svc = makeSvc();
      expect(await svc.isRemoteRuleSetReachable(`https://x/${code}.srs`)).toBe(false);
      expect(await svc.isRemoteRuleSetReachable(`https://x/${code}.srs`)).toBe(false);
      expect(https.request).toHaveBeenCalledTimes(1);
      jest.clearAllMocks();
    }
  });

  it('500 → true 但不缓存（瞬时，下次仍重发）', async () => {
    setupMock(500);
    const svc = makeSvc();
    expect(await svc.isRemoteRuleSetReachable('https://x/c.srs')).toBe(true);
    expect(await svc.isRemoteRuleSetReachable('https://x/c.srs')).toBe(true);
    expect(https.request).toHaveBeenCalledTimes(2); // 未缓存 → 重发
  });

  it('timeout → true 不缓存', async () => {
    setupMock('timeout');
    const svc = makeSvc();
    expect(await svc.isRemoteRuleSetReachable('https://x/d.srs')).toBe(true);
    expect(await svc.isRemoteRuleSetReachable('https://x/d.srs')).toBe(true);
    expect(https.request).toHaveBeenCalledTimes(2);
  });

  it('error → true 不缓存', async () => {
    setupMock('error');
    const svc = makeSvc();
    expect(await svc.isRemoteRuleSetReachable('https://x/e.srs')).toBe(true);
    expect(await svc.isRemoteRuleSetReachable('https://x/e.srs')).toBe(true);
    expect(https.request).toHaveBeenCalledTimes(2);
  });

  it('不同 URL 独立缓存', async () => {
    setupMock(200);
    const svc = makeSvc();
    await svc.isRemoteRuleSetReachable('https://x/a.srs');
    await svc.isRemoteRuleSetReachable('https://x/b.srs'); // 不同 URL
    expect(https.request).toHaveBeenCalledTimes(2); // 两个 URL 各发一次
  });
});
