import { parseWsEarlyData, DEFAULT_EARLY_DATA_HEADER } from '../ws-early-data';

describe('parseWsEarlyData（WS path ?ed=/eh= → 内核早数据字段，#57 L2）', () => {
  it('无 query：原样返回，不设早数据字段', () => {
    expect(parseWsEarlyData('/vless-argo')).toEqual({ path: '/vless-argo' });
  });

  it('?ed=2560（eooce Argo 典型）→ 拆出 maxEarlyData + 默认 Sec-WebSocket-Protocol 头', () => {
    expect(parseWsEarlyData('/vless-argo?ed=2560')).toEqual({
      path: '/vless-argo',
      maxEarlyData: 2560,
      earlyDataHeaderName: 'Sec-WebSocket-Protocol',
    });
  });

  it('?ed=2048&eh=X-Custom → 自定义头名（不硬编码）', () => {
    expect(parseWsEarlyData('/p?ed=2048&eh=X-Custom')).toEqual({
      path: '/p',
      maxEarlyData: 2048,
      earlyDataHeaderName: 'X-Custom',
    });
  });

  it('ed 之外还有其它 query → 保留其它、只剥 ed/eh', () => {
    expect(parseWsEarlyData('/p?ed=2560&foo=bar')).toEqual({
      path: '/p?foo=bar',
      maxEarlyData: 2560,
      earlyDataHeaderName: 'Sec-WebSocket-Protocol',
    });
  });

  it('无 ed 的 query（如纯 path 参数）→ 原样保留、不设字段', () => {
    expect(parseWsEarlyData('/p?foo=bar')).toEqual({ path: '/p?foo=bar' });
  });

  it('eh 但无 ed → 不动（eh 无 ed 无意义）', () => {
    expect(parseWsEarlyData('/p?eh=X')).toEqual({ path: '/p?eh=X' });
  });

  it('ed 非法（0 / 非数）→ 保守不改，避免误伤 path', () => {
    expect(parseWsEarlyData('/p?ed=0')).toEqual({ path: '/p?ed=0' });
    expect(parseWsEarlyData('/p?ed=abc')).toEqual({ path: '/p?ed=abc' });
  });

  it('空 path → 归一为 /', () => {
    expect(parseWsEarlyData('')).toEqual({ path: '/' });
  });

  it('默认头常量值正确（xray 兼容必需）', () => {
    expect(DEFAULT_EARLY_DATA_HEADER).toBe('Sec-WebSocket-Protocol');
  });
});
