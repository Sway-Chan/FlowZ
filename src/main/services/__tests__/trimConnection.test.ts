/**
 * trimConnection 单测：clash_api 原始 connection → ConnectionEntry。
 * 验证连接信息页所需扩展字段（network/type/sourceIP/sourcePort/destinationPort/processPath + upload/download/start）
 * 被带出，且 topology 原有字段（id/chains/rule/rulePayload/metadata.host/destinationIP）保持。
 * 数值字段经 isFinite 兜底（非法 → undefined，避免 NaN 进 UI 差分）。
 */
import { trimConnection } from '../StatsService';

// 对照 sing-box clash_api GET /connections 单条连接结构
const RAW = {
  id: 'conn-1',
  upload: 12345,
  download: 67890,
  start: '2026-06-13T10:00:00.000Z',
  chains: ['proxy-selector', 'hk-node'],
  rule: 'rule_set=>proxy',
  rulePayload: '',
  metadata: {
    network: 'tcp',
    type: 'Tun',
    sourceIP: '192.168.1.10',
    destinationIP: '93.184.216.34',
    sourcePort: '54321',
    destinationPort: '443',
    host: 'example.com',
    processPath: '/usr/bin/curl',
  },
};

describe('trimConnection', () => {
  it('带出连接信息页所需扩展字段', () => {
    const e = trimConnection(RAW);
    expect(e.upload).toBe(12345);
    expect(e.download).toBe(67890);
    expect(e.start).toBe('2026-06-13T10:00:00.000Z');
    expect(e.metadata?.network).toBe('tcp');
    expect(e.metadata?.type).toBe('Tun');
    expect(e.metadata?.sourceIP).toBe('192.168.1.10');
    expect(e.metadata?.sourcePort).toBe('54321');
    expect(e.metadata?.destinationPort).toBe('443');
    expect(e.metadata?.processPath).toBe('/usr/bin/curl');
  });

  it('保持 topology 原有字段（向后兼容）', () => {
    const e = trimConnection(RAW);
    expect(e.id).toBe('conn-1');
    expect(e.chains).toEqual(['proxy-selector', 'hk-node']);
    expect(e.rule).toBe('rule_set=>proxy');
    expect(e.rulePayload).toBe('');
    expect(e.metadata?.host).toBe('example.com');
    expect(e.metadata?.destinationIP).toBe('93.184.216.34');
  });

  it('缺失/非法数值字段兜底为 undefined（不产生 NaN）', () => {
    const e = trimConnection({ id: 'x', chains: [], rule: '', rulePayload: '' });
    expect(e.upload).toBeUndefined();
    expect(e.download).toBeUndefined();
    expect(e.start).toBeUndefined();
    expect(e.metadata).toBeUndefined();

    const bad = trimConnection({ id: 'y', upload: 'oops', download: NaN });
    expect(bad.upload).toBeUndefined();
    expect(bad.download).toBeUndefined();
  });
});
