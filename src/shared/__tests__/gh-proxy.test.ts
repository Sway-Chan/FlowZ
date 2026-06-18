import { ghMirrorUrl, applyGhProxy, normalizeGhProxyPrefix, GH_PROXY_PRESETS } from '../gh-proxy';

const GH = 'https://github.com/a/b/releases/download/v1/x.zip';

describe('ghMirrorUrl', () => {
  it('无 ghPrefix → 回落内置 preset[0]+url', () => {
    expect(ghMirrorUrl(GH)).toBe(GH_PROXY_PRESETS[0] + GH);
  });

  it('有 ghPrefix 且命中 GitHub 域 → 用前缀拼接', () => {
    expect(ghMirrorUrl(GH, 'https://my.mirror/')).toBe('https://my.mirror/' + GH);
  });

  it('有 ghPrefix 但非 GitHub 域(applyGhProxy 不改) → 回落 preset[0]', () => {
    const nonGh = 'https://example.com/x.zip';
    expect(ghMirrorUrl(nonGh, 'https://my.mirror/')).toBe(GH_PROXY_PRESETS[0] + nonGh);
  });
});

describe('applyGhProxy', () => {
  it('GitHub 域加前缀；非 GitHub 域原样', () => {
    expect(applyGhProxy('https://m/', GH)).toBe('https://m/' + GH);
    expect(applyGhProxy('https://m/', 'https://example.com/x')).toBe('https://example.com/x');
    expect(applyGhProxy(undefined, GH)).toBe(GH);
  });
});

describe('normalizeGhProxyPrefix', () => {
  it('裸域名 → https://host/；空/非法 → null', () => {
    expect(normalizeGhProxyPrefix('gh-proxy.org')).toBe('https://gh-proxy.org/');
    expect(normalizeGhProxyPrefix('https://gh-proxy.org')).toBe('https://gh-proxy.org/');
    expect(normalizeGhProxyPrefix('')).toBeNull();
    expect(normalizeGhProxyPrefix('http://x.com')).toBeNull(); // 非 https
  });
});
