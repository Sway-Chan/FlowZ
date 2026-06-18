import { findSuitableSingboxAsset } from '../singbox-asset';

const asset = (name: string) => ({ name, browser_download_url: `https://x/${name}` });

describe('findSuitableSingboxAsset', () => {
  it('linux x64 → 匹配 linux+amd64+.tar.gz', () => {
    const a = findSuitableSingboxAsset(
      [
        asset('sing-box-1.13.0-darwin-arm64.tar.gz'),
        asset('sing-box-1.13.0-linux-amd64.tar.gz'),
        asset('sing-box-1.13.0-windows-amd64.zip'),
      ],
      'linux',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-linux-amd64.tar.gz');
  });

  it('darwin arm64 → 匹配 darwin+arm64', () => {
    const a = findSuitableSingboxAsset(
      [asset('sing-box-1.13.0-darwin-amd64.tar.gz'), asset('sing-box-1.13.0-darwin-arm64.tar.gz')],
      'darwin',
      'arm64'
    );
    expect(a.name).toBe('sing-box-1.13.0-darwin-arm64.tar.gz');
  });

  it('优先含 with-naive / full 的构建', () => {
    const a = findSuitableSingboxAsset(
      [
        asset('sing-box-1.13.0-windows-amd64.zip'),
        asset('sing-box-1.13.0-windows-amd64-with-naive.zip'),
      ],
      'win32',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-windows-amd64-with-naive.zip');
  });

  it('with-naive 缺失时排除 legacy 取非 legacy', () => {
    const a = findSuitableSingboxAsset(
      [
        asset('sing-box-1.13.0-linux-amd64-legacy.tar.gz'),
        asset('sing-box-1.13.0-linux-amd64.tar.gz'),
      ],
      'linux',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-linux-amd64.tar.gz');
  });

  it('全为 legacy 时回落首个匹配', () => {
    const a = findSuitableSingboxAsset(
      [asset('sing-box-1.13.0-linux-amd64-legacy.tar.gz')],
      'linux',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-linux-amd64-legacy.tar.gz');
  });

  it('Windows 接受 .zip 后缀', () => {
    const a = findSuitableSingboxAsset(
      [asset('sing-box-1.13.0-windows-amd64.zip')],
      'win32',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-windows-amd64.zip');
  });

  it('无平台/架构匹配 → undefined', () => {
    const a = findSuitableSingboxAsset(
      [asset('sing-box-1.13.0-linux-amd64.tar.gz')],
      'darwin',
      'arm64'
    );
    expect(a).toBeUndefined();
  });

  it('空 assets → undefined', () => {
    expect(findSuitableSingboxAsset([], 'linux', 'x64')).toBeUndefined();
  });
});
