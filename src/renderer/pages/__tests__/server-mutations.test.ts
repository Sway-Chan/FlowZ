/**
 * server-mutations 纯函数单测（CRUD 下沉后的离线安全网）：锁编辑保留 subscriptionId/createdAt、克隆脱离订阅。
 */
import { buildSavedServers, buildClonedServer } from '../server-mutations';
import type { ServerConfig } from '../../bridge/types';

const srv = (over: Partial<ServerConfig>): ServerConfig =>
  ({
    id: 'id0',
    name: 'n',
    protocol: 'vless',
    createdAt: 'c0',
    updatedAt: 'u0',
    ...over,
  }) as ServerConfig;

const data = (over: Partial<ServerConfig> = {}) =>
  ({ name: 'new', protocol: 'vless', ...over }) as Omit<
    ServerConfig,
    'id' | 'createdAt' | 'updatedAt'
  >;

describe('buildSavedServers — 新增', () => {
  it('追加新节点（注入 id + 时间戳）', () => {
    const out = buildSavedServers(
      [srv({ id: 'a' })],
      data({ name: 'X' }),
      undefined,
      'newid',
      'NOW'
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ id: 'newid', name: 'X', createdAt: 'NOW', updatedAt: 'NOW' });
    expect(out[0].id).toBe('a'); // 原有不动
  });
});

describe('buildSavedServers — 编辑', () => {
  it('就地替换 + 保留 subscriptionId/createdAt + 更新 updatedAt', () => {
    const editing = srv({
      id: 'b',
      subscriptionId: 'sub1',
      createdAt: 'C_OLD',
      updatedAt: 'U_OLD',
    });
    const servers = [srv({ id: 'a' }), editing];
    const out = buildSavedServers(servers, data({ name: 'EDITED' }), editing, 'IGNORED', 'NOW');
    expect(out).toHaveLength(2);
    const edited = out.find((s) => s.id === 'b')!;
    expect(edited).toMatchObject({
      id: 'b',
      name: 'EDITED',
      subscriptionId: 'sub1', // 保留订阅归属
      createdAt: 'C_OLD', // 保留创建时间
      updatedAt: 'NOW', // 更新修改时间
    });
    // 新 id 不应被使用（编辑保 id）
    expect(out.some((s) => s.id === 'IGNORED')).toBe(false);
    expect(out[0].id).toBe('a'); // 其它项不动
  });

  it('serverData 携带的 subscriptionId 被 editingServer 的覆盖（订阅归属以原节点为准）', () => {
    const editing = srv({ id: 'b', subscriptionId: 'orig' });
    const out = buildSavedServers(
      [editing],
      data({ subscriptionId: 'attacker' }),
      editing,
      'x',
      'NOW'
    );
    expect(out[0].subscriptionId).toBe('orig');
  });
});

describe('buildClonedServer', () => {
  it('新 id + 清 subscriptionId + 改名 + 新时间戳', () => {
    const src = srv({
      id: 'orig',
      subscriptionId: 'sub1',
      name: 'HK',
      createdAt: 'C',
      updatedAt: 'U',
    });
    const out = buildClonedServer(src, 'HK (副本)', 'cloneid', 'NOW');
    expect(out).toMatchObject({
      id: 'cloneid',
      subscriptionId: undefined, // 脱离订阅
      name: 'HK (副本)',
      createdAt: 'NOW',
      updatedAt: 'NOW',
      protocol: 'vless', // 其余字段保留
    });
  });
});
