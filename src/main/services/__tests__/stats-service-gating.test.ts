/**
 * StatsService「连接轮询门控」单测：覆盖 P1/P2 两道门控——
 *  1) 窗口可见性谓词（isWindowVisible）：无可见窗口整轮跳过 fetch/parse/广播。
 *  2) 连接页 watcher 引用计数：仅 connectionsWatchers>0 时才 trim + 按 CONNECTIONS_PUSH_DIVIDER(=2) 推连接快照。
 *     addConnectionsWatcher 0→1 把 tick 对齐到 DIVIDER-1，使下一轮 poll 立即满足 divider 即推首帧。
 * poll() 为私有 async，直接经 (service as any).poll() 驱动（跟随 proxy-manager 测试的 (svc as any) 直调私有方法风格），
 * 避免 fake timer 驱动 async poll 的 microtask flush 复杂度。ClashApiClient 用 { getJson: jest.fn() } stub 强转注入。
 */
import { StatsService } from '../StatsService';
import type { TrafficStats, ConnectionsSnapshot } from '../../../shared/types';

// 对照 sing-box clash_api GET /connections 单条连接结构（含隐私/扩展字段，验 trim 字段裁剪）
const RAW_CONN = {
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

/** clash_api /connections 响应体（带累计 totals + 一条连接）。 */
function makeData(connections: unknown[] = [RAW_CONN]) {
  return { uploadTotal: 1000, downloadTotal: 2000, connections };
}

/** ClashApiClient stub：getJson 返回预设响应，记录调用。强转注入（参考 proxy-manager 测试的 client as any 风格）。 */
function makeClashApi(data: unknown = makeData()) {
  return { getJson: jest.fn().mockResolvedValue(data) };
}

/**
 * 组装一个 StatsService 及其回调 spy。
 * @param withVisible 是否注入 isWindowVisible 谓词
 * @param visible      谓词返回值（仅 withVisible 时有效）
 * @param data         getJson 响应体
 */
function setup(opts: { withVisible?: boolean; visible?: boolean; data?: unknown } = {}) {
  const onUpdate = jest.fn<void, [TrafficStats]>();
  const onConnections = jest.fn<void, [ConnectionsSnapshot]>();
  const clashApi = makeClashApi(opts.data ?? makeData());
  const isWindowVisible = opts.withVisible ? jest.fn(() => opts.visible ?? true) : undefined;
  const service = new StatsService(onUpdate, clashApi as any, onConnections, isWindowVisible);
  return { service, onUpdate, onConnections, clashApi, isWindowVisible };
}

/** 直接驱动一轮私有 async poll（替代 fake timer，规避 microtask flush）。 */
async function poll(service: StatsService): Promise<void> {
  await (service as any).poll();
}

describe('StatsService 连接轮询门控', () => {
  describe('可见性门控（isWindowVisible）', () => {
    it('isWindowVisible 返回 false 时，一次 poll 不调 getJson / onUpdate / onConnections', async () => {
      const { service, onUpdate, onConnections, clashApi } = setup({
        withVisible: true,
        visible: false,
      });
      service.addConnectionsWatcher(); // 即便有 watcher，不可见也整轮跳过

      await poll(service);

      expect(clashApi.getJson).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
      expect(onConnections).not.toHaveBeenCalled();
    });

    it('不可见 poll 会把 last 重置为 null（恢复后首轮干净再基线）', async () => {
      const { service } = setup({ withVisible: true, visible: false });
      (service as any).last = { up: 1, down: 1, at: Date.now() };

      await poll(service);

      expect((service as any).last).toBeNull();
    });
  });

  describe('无 watcher（connectionsWatchers===0）', () => {
    it('可见 + 无 watcher：poll 调 onUpdate（totals）但不调 onConnections', async () => {
      const { service, onUpdate, onConnections } = setup({ withVisible: true, visible: true });

      await poll(service);

      expect(onUpdate).toHaveBeenCalledTimes(1);
      const stats = onUpdate.mock.calls[0][0];
      expect(stats.totalUpload).toBe(1000);
      expect(stats.totalDownload).toBe(2000);
      expect(stats.activeConnections).toBe(1); // 取 connections.length，与连接列表门控解耦
      expect(onConnections).not.toHaveBeenCalled();
    });

    it('无 watcher：getConnectionsSnapshot() 返回空 connections', async () => {
      const { service } = setup({ withVisible: true, visible: true });

      await poll(service);

      expect(service.getConnectionsSnapshot().connections).toEqual([]);
    });
  });

  describe('有 watcher（addConnectionsWatcher）', () => {
    it('addConnectionsWatcher 后下一次 poll 立即推 onConnections（0→1 tick 对齐，≤1 次 poll 即推首帧）', async () => {
      const { service, onConnections } = setup({ withVisible: true, visible: true });

      service.addConnectionsWatcher();
      await poll(service); // 因 tick 已对齐到 DIVIDER-1，本轮 ++tick%DIVIDER===0 立即推

      expect(onConnections).toHaveBeenCalledTimes(1);
    });

    it('推送的 snapshot.connections 是 trim 后的（字段裁剪正确：id / metadata.host 等带出）', async () => {
      const { service, onConnections } = setup({ withVisible: true, visible: true });

      service.addConnectionsWatcher();
      await poll(service);

      const snap = onConnections.mock.calls[0][0];
      expect(snap.connections).toHaveLength(1);
      const e = snap.connections[0];
      expect(e.id).toBe('conn-1');
      expect(e.metadata?.host).toBe('example.com');
      expect(e.metadata?.destinationIP).toBe('93.184.216.34');
      expect(e.metadata?.sourceIP).toBe('192.168.1.10');
      expect(e.metadata?.processPath).toBe('/usr/bin/curl');
      expect(e.upload).toBe(12345);
      expect(e.download).toBe(67890);
      expect(e.start).toBe('2026-06-13T10:00:00.000Z');
      // 与 getConnectionsSnapshot 缓存一致
      expect(service.getConnectionsSnapshot().connections).toHaveLength(1);
    });

    it('连续两次 poll 至少推一次连接快照（首帧 ≤1 次 poll 即到）', async () => {
      const { service, onConnections } = setup({ withVisible: true, visible: true });

      service.addConnectionsWatcher();
      await poll(service);
      await poll(service);

      expect(onConnections.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('divider 节奏（CONNECTIONS_PUSH_DIVIDER=2）', () => {
    it('0→1 立即推首帧后，后续按每 2 次 poll 推一次', async () => {
      const { service, onConnections } = setup({ withVisible: true, visible: true });

      service.addConnectionsWatcher();
      await poll(service); // 第1轮：tick 1→2，%2===0 → 推（首帧）         累计 1
      expect(onConnections).toHaveBeenCalledTimes(1);

      await poll(service); // 第2轮：tick 2→3，%2!==0 → 不推                累计 1
      expect(onConnections).toHaveBeenCalledTimes(1);

      await poll(service); // 第3轮：tick 3→4，%2===0 → 推                  累计 2
      expect(onConnections).toHaveBeenCalledTimes(2);

      await poll(service); // 第4轮：tick 4→5，%2!==0 → 不推                累计 2
      expect(onConnections).toHaveBeenCalledTimes(2);
    });
  });

  describe('计数钳制（removeConnectionsWatcher）', () => {
    it('计数为 0 时 remove 后仍为 0（不变负，避免 >0 误判）', () => {
      const { service } = setup({ withVisible: true, visible: true });

      service.removeConnectionsWatcher();
      service.removeConnectionsWatcher();

      expect((service as any).connectionsWatchers).toBe(0);
    });

    it('add 后 remove 归 0，再 poll 不推连接快照（间接断言钳制未误判 >0）', async () => {
      const { service, onConnections } = setup({ withVisible: true, visible: true });

      service.addConnectionsWatcher();
      service.removeConnectionsWatcher(); // 归 0
      service.removeConnectionsWatcher(); // 钳制：仍 0，不应变负
      expect((service as any).connectionsWatchers).toBe(0);

      await poll(service);
      await poll(service);

      expect(onConnections).not.toHaveBeenCalled();
    });
  });

  describe('缺省行为不变（未注入 isWindowVisible 且无 watcher）', () => {
    it('缺省（无谓词 + 无 watcher）：totals 推、连接列表不推', async () => {
      const onUpdate = jest.fn<void, [TrafficStats]>();
      const onConnections = jest.fn<void, [ConnectionsSnapshot]>();
      const clashApi = makeClashApi(makeData());
      // 不注入 isWindowVisible（第 4 参数省略）= 不门控、保持原行为
      const service = new StatsService(onUpdate, clashApi as any, onConnections);

      await poll(service);

      expect(clashApi.getJson).toHaveBeenCalledTimes(1); // 无谓词 → 不跳过 fetch
      expect(onUpdate).toHaveBeenCalledTimes(1); // totals 推
      expect(onConnections).not.toHaveBeenCalled(); // 无 watcher → 连接列表不推
    });

    it('缺省 + 加 watcher：下一轮仍按 0→1 对齐立即推（谓词缺省不影响 watcher 门控）', async () => {
      const onUpdate = jest.fn<void, [TrafficStats]>();
      const onConnections = jest.fn<void, [ConnectionsSnapshot]>();
      const clashApi = makeClashApi(makeData());
      const service = new StatsService(onUpdate, clashApi as any, onConnections);

      service.addConnectionsWatcher();
      await poll(service);

      expect(onConnections).toHaveBeenCalledTimes(1);
    });
  });
});
