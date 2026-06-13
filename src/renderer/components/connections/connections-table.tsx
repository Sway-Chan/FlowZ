import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Activity,
  Search,
  Pause,
  Play,
  X,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Ban,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc';
import { toast } from 'sonner';
import { formatBytes } from '@/lib/format';
import type { ConnectionEntry, ConnectionsSnapshot } from '../../../shared/types';
import {
  computeConnSpeeds,
  destOf,
  sourceOf,
  typeOf,
  chainOf,
  durationSec,
  fmtDuration,
  parseRule,
  type ConnSpeed,
  type RateState,
} from './connection-utils';

type SortKey = 'type' | 'source' | 'dest' | 'rule' | 'chain' | 'speed' | 'traffic' | 'time';
type SortDir = 'asc' | 'desc';

/** 规则去向 action → Badge 配色：direct 中性灰 / block 系危险红 / 其它(proxy·具体节点) 主色。 */
function ruleActionVariant(action: string): 'secondary' | 'destructive' | 'default' {
  const a = action.toLowerCase();
  if (a === 'direct') return 'secondary';
  if (a === 'block' || a === 'reject' || a === 'reject-drop' || a === 'drop') return 'destructive';
  return 'default';
}

export function ConnectionsTable() {
  const { t } = useTranslation();
  const proxyRunning = useAppStore((s) => s.connectionStatus?.proxyCore?.running ?? false);

  const [connections, setConnections] = useState<ConnectionEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [speeds, setSpeeds] = useState<Map<string, ConnSpeed>>(new Map());
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const [now, setNow] = useState(Date.now());

  // 暂停态用 ref 让订阅回调读到最新值（订阅只挂一次，不随 paused 重订阅）。
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // per-conn 速率差分的上一帧缓存（不入 state，避免无谓重渲染）。
  const rateRef = useRef<RateState>(new Map());

  // 数据：挂载 CONNECTIONS_GET 回填 + 订阅 EVENT_CONNECTIONS_UPDATED。暂停时冻结（不更新表 + 不推进速率基准）。
  useEffect(() => {
    let mounted = true;
    const apply = (snap: ConnectionsSnapshot) => {
      if (pausedRef.current) return; // 本地冻结：保留当前帧
      const { speeds: s, next } = computeConnSpeeds(snap.connections, rateRef.current, snap.at);
      rateRef.current = next;
      setSpeeds(s);
      setConnections(snap.connections);
    };
    api.connections
      .get()
      .then((snap) => {
        if (mounted) apply(snap);
      })
      .catch(() => {
        /* 静默：核未运行 / 鉴权未就绪，空态由 proxyRunning gate 兜底 */
      });
    const unsub = api.connections.onUpdated((snap) => {
      if (mounted) apply(snap);
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  // 时长列实时刷新与高频快照解耦：每 1s 推进 now（秒级精度足够），暂停时冻结。原随每帧快照 setNow 会把时长
  // 刷新频率绑死在快照频率上、放大整表重渲染（LOW-B）；改为固定 1s tick，配合 filtered 不依赖 now（见上）。
  useEffect(() => {
    const id = setInterval(() => {
      if (!pausedRef.current) setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = connections;
    if (q) {
      list = connections.filter((c) => {
        const m = c.metadata || {};
        const hay = [
          m.host,
          m.destinationIP,
          m.sourceIP,
          c.rule,
          c.rulePayload,
          chainOf(c),
          m.processPath,
          m.network,
          m.type,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    const speedOf = (c: ConnectionEntry) => {
      const s = speeds.get(c.id);
      return s ? s.up + s.down : 0;
    };
    const trafficOf = (c: ConnectionEntry) => (c.upload ?? 0) + (c.download ?? 0);
    // 排序用连接起始时间戳（无/非法 start 垫底）替代 durationSec(c, now)：作差时 now 对所有行相同、完全抵消
    // （durationSec(a,now)-durationSec(b,now) === startMs(b)-startMs(a)），故 time 排序无需 now → filtered 不
    // 再依赖 now，避免每秒时长刷新触发整表重排（LOW-A）。now 仍用于时长列显示（见 fmtDuration(durationSec)）。
    const startMs = (c: ConnectionEntry) => {
      if (!c.start) return Infinity;
      const t = Date.parse(c.start);
      return isNaN(t) ? Infinity : t;
    };
    const cmp = (a: ConnectionEntry, b: ConnectionEntry): number => {
      switch (sortKey) {
        case 'type':
          return typeOf(a).localeCompare(typeOf(b)) * dir;
        case 'source':
          return sourceOf(a).localeCompare(sourceOf(b)) * dir;
        case 'dest':
          return destOf(a).localeCompare(destOf(b)) * dir;
        case 'rule':
          return a.rule.localeCompare(b.rule) * dir;
        case 'chain':
          return chainOf(a).localeCompare(chainOf(b)) * dir;
        case 'speed':
          return (speedOf(a) - speedOf(b)) * dir;
        case 'traffic':
          return (trafficOf(a) - trafficOf(b)) * dir;
        case 'time':
          return (startMs(b) - startMs(a)) * dir;
        default:
          return 0;
      }
    };
    return [...list].sort(cmp);
  }, [connections, search, sortKey, sortDir, speeds]);

  // 大列表渲染保护（LOW-B）：连接数极多时全量 .map 撑爆 DOM + 拖慢每秒重渲染。代理活动连接通常几十到几百，
  // 超过软上限只渲染前 N 行并提示用搜索缩小（shadcn <table> 语义下真虚拟化需破坏表结构、收益有限，取此务实方案）。
  const MAX_VISIBLE_ROWS = 500;
  const visible =
    filtered.length > MAX_VISIBLE_ROWS ? filtered.slice(0, MAX_VISIBLE_ROWS) : filtered;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const handleClose = async (id: string) => {
    try {
      const { ok } = await api.connections.close(id);
      if (ok) {
        // 乐观移除：下一帧快照若仍在会再回填（极少见），但即时反馈更顺手
        setConnections((prev) => prev.filter((c) => c.id !== id));
      } else {
        toast.error(t('connections.closeFailed'));
      }
    } catch {
      toast.error(t('connections.closeFailed'));
    }
  };

  const handleCloseAll = async () => {
    setConfirmCloseAll(false);
    try {
      const { ok } = await api.connections.closeAll();
      if (ok) {
        setConnections([]);
        rateRef.current = new Map();
        setSpeeds(new Map());
        toast.success(t('connections.closeAllDone'));
      } else {
        toast.error(t('connections.closeFailed'));
      }
    } catch {
      toast.error(t('connections.closeFailed'));
    }
  };

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
    return sortDir === 'asc' ? (
      <ArrowUp className="ml-1 inline h-3 w-3" />
    ) : (
      <ArrowDown className="ml-1 inline h-3 w-3" />
    );
  };

  const headerCell = (k: SortKey, label: string, className?: string) => (
    <TableHead
      className={`cursor-pointer select-none whitespace-nowrap ${className ?? ''}`}
      onClick={() => toggleSort(k)}
    >
      {label}
      <SortIcon k={k} />
    </TableHead>
  );

  return (
    <div className="space-y-3">
      {/* 顶栏：连接数 + 搜索 + 暂停/恢复 + 全部关闭 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          {t('connections.count', { count: connections.length })}
        </span>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder={t('connections.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-[200px] pl-8 text-xs"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => setPaused((p) => !p)}>
            {paused ? (
              <>
                <Play className="mr-1 h-4 w-4" />
                {t('connections.resume')}
              </>
            ) : (
              <>
                <Pause className="mr-1 h-4 w-4" />
                {t('connections.pause')}
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmCloseAll(true)}
            disabled={connections.length === 0}
          >
            <Ban className="mr-1 h-4 w-4" />
            {t('connections.closeAll')}
          </Button>
        </div>
      </div>

      {/* 表 / 空态 */}
      <div className="rounded-lg border bg-muted/40">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
            <Activity className="h-8 w-8 opacity-50" />
            <span>
              {connections.length > 0 && search
                ? t('connections.noMatch')
                : proxyRunning
                  ? t('connections.noActive')
                  : t('connections.plsStartProxy')}
            </span>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                {headerCell('type', t('connections.colType'))}
                {headerCell('source', t('connections.colSource'))}
                {headerCell('dest', t('connections.colDest'))}
                {headerCell('rule', t('connections.colRule'))}
                {headerCell('chain', t('connections.colChain'))}
                {headerCell('speed', t('connections.colSpeed'))}
                {headerCell('traffic', t('connections.colTraffic'))}
                {headerCell('time', t('connections.colTime'))}
                <TableHead className="whitespace-nowrap">{t('connections.colProcess')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((c) => {
                const s = speeds.get(c.id) || { up: 0, down: 0 };
                const m = c.metadata || {};
                const proc = m.processPath || '-';
                const procName = proc === '-' ? '-' : proc.split(/[/\\]/).pop() || proc;
                const rv = parseRule(c.rule, c.rulePayload);
                return (
                  <TableRow key={c.id}>
                    <TableCell className="py-2">
                      <button
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        title={t('connections.close')}
                        onClick={() => handleClose(c.id)}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </TableCell>
                    <TableCell className="py-2 text-xs">{typeOf(c)}</TableCell>
                    <TableCell className="py-2 font-mono text-xs">{sourceOf(c)}</TableCell>
                    <TableCell className="max-w-[220px] truncate py-2 text-xs" title={destOf(c)}>
                      {destOf(c)}
                    </TableCell>
                    <TableCell className="max-w-[200px] py-2 text-xs" title={rv.full || undefined}>
                      {rv.action ? (
                        <span className="flex items-center gap-1.5">
                          {rv.type && (
                            <span className="truncate text-muted-foreground">{rv.type}</span>
                          )}
                          <Badge
                            variant={ruleActionVariant(rv.action)}
                            className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
                          >
                            {rv.action}
                          </Badge>
                        </span>
                      ) : (
                        <span className="block truncate">{rv.full || '-'}</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[160px] truncate py-2 text-xs" title={chainOf(c)}>
                      {chainOf(c)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap py-2 text-xs">
                      <span className="text-green-500">↓ {formatBytes(s.down)}/s</span>
                      <span className="ml-2 text-blue-500">↑ {formatBytes(s.up)}/s</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap py-2 text-xs text-muted-foreground">
                      ↓ {formatBytes(c.download ?? 0)} / ↑ {formatBytes(c.upload ?? 0)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap py-2 text-xs">
                      {fmtDuration(durationSec(c, now))}
                    </TableCell>
                    <TableCell className="max-w-[180px] truncate py-2 text-xs" title={proc}>
                      {procName}
                    </TableCell>
                  </TableRow>
                );
              })}
              {filtered.length > MAX_VISIBLE_ROWS && (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="py-2 text-center text-xs text-muted-foreground"
                  >
                    {t('connections.rowsTruncated', {
                      shown: MAX_VISIBLE_ROWS,
                      total: filtered.length,
                    })}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {/* 全部关闭确认弹窗 */}
      <AlertDialog open={confirmCloseAll} onOpenChange={setConfirmCloseAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('connections.closeAllTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('connections.closeAllWarn')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('connections.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleCloseAll}>
              {t('connections.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
