import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CoreUpdateStateStore } from '../core-update-state-store';

const log = { addLog: () => {} } as any;

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-cstore-'));
  return { store: new CoreUpdateStateStore(log, dir), dir };
}

describe('CoreUpdateStateStore — autoState', () => {
  it('缺失 → 空对象', () => {
    const { store } = makeStore();
    expect(store.loadAutoState()).toEqual({});
  });

  it('save 合并字段 + load 回读', () => {
    const { store } = makeStore();
    store.saveAutoState({ lastCheckAt: 123 });
    store.saveAutoState({ verifiedCeiling: 1013 });
    expect(store.loadAutoState()).toEqual({ lastCheckAt: 123, verifiedCeiling: 1013 });
  });

  it('损坏 JSON → 失败安全空对象', () => {
    const { store, dir } = makeStore();
    fs.writeFileSync(path.join(dir, 'core-update-state.json'), '{ broken', 'utf-8');
    expect(store.loadAutoState()).toEqual({});
  });

  it('原子写：成功后无 .tmp 残留', () => {
    const { store, dir } = makeStore();
    store.saveAutoState({ lastCheckAt: 1 });
    expect(fs.existsSync(path.join(dir, 'core-update-state.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'core-update-state.json.tmp'))).toBe(false);
  });
});

describe('CoreUpdateStateStore — knownBad', () => {
  it('mark / is / clear（含幂等）', () => {
    const { store } = makeStore();
    expect(store.isKnownBad('1.2.3')).toBe(false);
    store.markKnownBad('1.2.3');
    store.markKnownBad('1.2.3'); // 幂等：不重复追加
    expect(store.isKnownBad('1.2.3')).toBe(true);
    store.clearKnownBad('1.2.3');
    expect(store.isKnownBad('1.2.3')).toBe(false);
  });

  it('损坏名单 → 失败安全（视为空）', () => {
    const { store, dir } = makeStore();
    fs.writeFileSync(path.join(dir, 'core-known-bad.json'), 'not json', 'utf-8');
    expect(store.isKnownBad('x')).toBe(false);
  });
});
