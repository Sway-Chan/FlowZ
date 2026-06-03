import { useState, useMemo, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Plus,
  Edit,
  Trash2,
  Server,
  ChevronDown,
  LayoutGrid,
  List,
  Search,
  ArrowUpDown,
  CheckSquare,
  Square,
  Copy,
  Zap,
  Link,
} from 'lucide-react';
import { ImportUrlDialog } from './import-url-dialog';
import { generateShareUrl } from '@/bridge/api-wrapper';
import { api } from '@/ipc/api-client';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';

type ServerConfigWithId = ServerConfig;
type ViewMode = 'card' | 'list';
type SortKey = 'name' | 'protocol' | 'latency' | 'address';
type SortOrder = 'asc' | 'desc';

const ALL_PROTOCOLS = [
  'vless',
  'trojan',
  'hysteria2',
  'shadowsocks',
  'anytls',
  'tuic',
  'naive',
  'socks',
  'http',
  'ssh',
] as const;

const getCountryCode = (name: string): string | null => {
  const lowerName = name.toLowerCase();
  if (/香港|hk|hong kong|🇭🇰/.test(lowerName)) return 'hk';
  if (/台湾|tw|taiwan|🇹🇼|台北|新北/.test(lowerName)) return 'cn';
  if (/日本|jp|japan|🇯🇵|东京|大阪/.test(lowerName)) return 'jp';
  if (/新加坡|sg|singapore|🇸🇬|狮城/.test(lowerName)) return 'sg';
  if (/美国|us|america|usa|🇺🇸|洛杉矶|硅谷|西雅图/.test(lowerName)) return 'us';
  if (/韩国|kr|korea|🇰🇷|首尔/.test(lowerName)) return 'kr';
  if (/英国|uk|gb|🇬🇧|伦敦/.test(lowerName)) return 'gb';
  if (/德国|de|germany|🇩🇪|法兰克福/.test(lowerName)) return 'de';
  if (/法国|fr|france|🇫🇷|巴黎/.test(lowerName)) return 'fr';
  if (/澳洲|澳大利亚|au|australia|🇦🇺|悉尼/.test(lowerName)) return 'au';
  if (/加拿大|ca|canada|🇨🇦|多伦多|温哥华/.test(lowerName)) return 'ca';
  if (/印度|in|india|🇮🇳|孟买/.test(lowerName)) return 'in';
  if (/俄罗斯|ru|russia|🇷🇺|莫斯科/.test(lowerName)) return 'ru';
  if (/荷兰|nl|netherlands|🇳🇱|阿姆斯特丹/.test(lowerName)) return 'nl';
  if (/土耳其|tr|turkey|🇹🇷|伊斯坦布尔/.test(lowerName)) return 'tr';
  if (/阿根廷|ar|argentina|🇦🇷/.test(lowerName)) return 'ar';
  if (/意大利|it|italy|🇮🇹|罗马|米兰/.test(lowerName)) return 'it';
  if (/巴西|br|brazil|🇧🇷|圣保罗/.test(lowerName)) return 'br';
  if (/西班牙|es|spain|🇪🇸|马德里/.test(lowerName)) return 'es';
  if (/瑞士|ch|switzerland|🇨🇭|苏黎世/.test(lowerName)) return 'ch';
  if (/瑞典|se|sweden|🇸🇪|斯德哥尔摩/.test(lowerName)) return 'se';
  if (/印尼|印度尼西亚|id|indonesia|🇮🇩|雅加达/.test(lowerName)) return 'id';
  if (/马来西亚|my|malaysia|🇲🇾|吉隆坡/.test(lowerName)) return 'my';
  return null;
};

interface ServerListProps {
  servers: ServerConfigWithId[];
  subscriptions?: import('@/bridge/types').SubscriptionConfig[];
  selectedServerId?: string;
  showAddButton?: boolean;
  onAddServer: () => void;
  onEditServer: (server: ServerConfigWithId) => void;
  onDeleteServer: (serverId: string) => void;
  onDeleteServers?: (serverIds: string[]) => void;
  onSelectServer: (serverId: string) => void;
  onImportSuccess?: () => void;
}

export function ServerList({
  servers,
  selectedServerId,
  showAddButton = true,
  onAddServer,
  onEditServer,
  onDeleteServer,
  onDeleteServers,
  onSelectServer,
  onImportSuccess,
}: ServerListProps) {
  const latencyMap = useAppStore((state) => state.latencyMap);
  const setLatencyMap = useAppStore((state) => state.setLatencyMap);
  const [isTestingSpeed, setIsTestingSpeed] = useState(false);
  const [testingServerIds, setTestingServerIds] = useState<Set<string>>(new Set());
  const { t } = useTranslation();

  // 记住用户的视图偏好
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('flowz_server_view_mode');
    return saved === 'card' || saved === 'list' ? saved : 'card';
  });

  useEffect(() => {
    localStorage.setItem('flowz_server_view_mode', viewMode);
  }, [viewMode]);

  // 搜索 / 过滤 / 排序
  const [searchQuery, setSearchQuery] = useState('');
  const [filterProtocol, setFilterProtocol] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  // 批量选择
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSelecting, setIsSelecting] = useState(false);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);

  const handleSpeedTest = async () => {
    setIsTestingSpeed(true);
    try {
      toast.info(t('servers.speedTestStart'));
      const serverIdsToTest = servers.map((s) => s.id);
      const results = await api.server.speedTest(serverIdsToTest);
      setLatencyMap(results);
      toast.success(t('servers.speedTestDone'));
      setSortKey('latency');
      setSortOrder('asc');
    } catch (error) {
      toast.error(t('servers.speedTestFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsTestingSpeed(false);
    }
  };

  const handleSingleSpeedTest = async (serverId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTestingServerIds((prev) => {
      const s = new Set(prev);
      s.add(serverId);
      return s;
    });
    try {
      const results = await api.server.speedTest([serverId]);

      // Update only this specific node's latency in the store
      const newLatencyMap = { ...latencyMap, ...results };
      setLatencyMap(newLatencyMap);

      if (results[serverId] !== undefined) {
        toast.success(t('servers.speedTestDone'));
      }
    } catch (error) {
      toast.error(t('servers.speedTestFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTestingServerIds((prev) => {
        const s = new Set(prev);
        s.delete(serverId);
        return s;
      });
    }
  };

  const getLatencyColor = (latency: number | undefined) => {
    if (latency === undefined) return 'text-muted-foreground';
    if (latency === -1) return 'text-destructive';
    if (latency < 100) return 'text-green-500';
    if (latency < 300) return 'text-yellow-500';
    return 'text-destructive';
  };

  const getLatencyBg = (latency: number | undefined) => {
    if (latency === undefined) return '';
    if (latency === -1) return 'bg-destructive/10';
    if (latency < 100) return 'bg-green-500/10';
    if (latency < 300) return 'bg-yellow-500/10';
    return 'bg-destructive/10';
  };

  const handleDelete = (serverId: string) => {
    onDeleteServer(serverId);
    setSelectedIds((prev) => {
      const s = new Set(prev);
      s.delete(serverId);
      return s;
    });
  };

  const handleBatchDelete = () => {
    if (onDeleteServers) {
      onDeleteServers(Array.from(selectedIds));
    } else {
      selectedIds.forEach((id) => onDeleteServer(id));
    }
    setSelectedIds(new Set());
    setIsSelecting(false);
  };

  const handleCopyShareUrl = async (server: ServerConfigWithId, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const response = await generateShareUrl(server);
      if (response.success && response.data) {
        await navigator.clipboard.writeText(response.data);
        toast.success(t('servers.shareUrlCopied'));
      } else {
        toast.error(response.error || t('servers.shareUrlFail'));
      }
    } catch {
      toast.error(t('common.copyFail'));
    }
  };

  const handleBatchCopy = async () => {
    try {
      const selectedServersList = servers.filter((s) => selectedIds.has(s.id));
      const urls: string[] = [];
      let successCount = 0;

      for (const server of selectedServersList) {
        const response = await generateShareUrl(server);
        if (response.success && response.data) {
          urls.push(response.data);
          successCount++;
        }
      }

      if (urls.length > 0) {
        await navigator.clipboard.writeText(urls.join('\n'));
        toast.success(t('servers.batchCopySuccess', { count: successCount }));
      } else {
        toast.error(t('servers.shareUrlFail'));
      }
    } catch (error) {
      toast.error(
        t('servers.batchCopyFail', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    } finally {
      setIsSelecting(false);
      setSelectedIds(new Set());
    }
  };

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) {
        s.delete(id);
      } else {
        s.add(id);
      }
      return s;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredServers.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredServers.map((s) => s.id)));
    }
  };

  // 过滤 + 排序
  const filteredServers = useMemo(() => {
    let list = servers;

    // 搜索
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.address.toLowerCase().includes(q) ||
          s.protocol.toLowerCase().includes(q)
      );
    }

    // 协议过滤
    if (filterProtocol !== 'all') {
      list = list.filter((s) => s.protocol.toLowerCase() === filterProtocol);
    }

    // 排序
    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') {
        cmp = a.name.localeCompare(b.name);
      } else if (sortKey === 'protocol') {
        cmp = a.protocol.localeCompare(b.protocol);
      } else if (sortKey === 'address') {
        cmp = a.address.localeCompare(b.address);
      } else if (sortKey === 'latency') {
        const getVal = (v: number | undefined) =>
          v === undefined ? Infinity : v === -1 ? Infinity - 1 : v;
        const la = getVal(latencyMap[a.id]);
        const lb = getVal(latencyMap[b.id]);
        cmp = la - lb;
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [servers, searchQuery, filterProtocol, sortKey, sortOrder, latencyMap]);

  const getProtocolBadgeVariant = (protocol: string) => {
    const colors: Record<string, string> = {
      vless: 'bg-blue-500/15 text-blue-600 border-blue-300/30',
      trojan: 'bg-purple-500/15 text-purple-600 border-purple-300/30',
      hysteria2: 'bg-orange-500/15 text-orange-600 border-orange-300/30',
      shadowsocks: 'bg-green-500/15 text-green-600 border-green-300/30',
      anytls: 'bg-teal-500/15 text-teal-600 border-teal-300/30',
      tuic: 'bg-indigo-500/15 text-indigo-600 border-indigo-300/30',
      naive: 'bg-rose-500/15 text-rose-600 border-rose-300/30',
      socks: 'bg-slate-500/15 text-slate-600 border-slate-300/30',
      http: 'bg-sky-500/15 text-sky-600 border-sky-300/30',
      ssh: 'bg-amber-500/15 text-amber-600 border-amber-300/30',
    };
    return colors[protocol.toLowerCase()] || 'bg-muted text-muted-foreground';
  };

  // 操作按钮（卡片和列表模式共用）
  const renderActions = (server: ServerConfigWithId, stopPropagation = true) => (
    <div className="flex items-center gap-1 flex-shrink-0">
      <Button
        variant="ghost"
        size="sm"
        title={t('servers.speedTest')}
        className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
        disabled={testingServerIds.has(server.id) || isTestingSpeed}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          handleSingleSpeedTest(server.id, e);
        }}
      >
        <Zap
          className={`h-3.5 w-3.5 ${testingServerIds.has(server.id) ? 'animate-pulse text-primary fill-primary/20' : ''}`}
        />
      </Button>

      {latencyMap[server.id] !== undefined && (
        <span
          className={`text-xs font-medium mr-1 px-1.5 py-0.5 rounded ${getLatencyColor(latencyMap[server.id])} ${getLatencyBg(latencyMap[server.id])}`}
        >
          {latencyMap[server.id] === -1 ? t('servers.timeout') : `${latencyMap[server.id]} ms`}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        title={t('servers.copyShareUrl')}
        className="h-7 w-7 p-0"
        onClick={(e) => handleCopyShareUrl(server, e)}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        title={server.subscriptionId ? t('servers.copyAndEdit', 'Copy and Edit') : t('common.edit')}
        className="h-7 w-7 p-0"
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          onEditServer(server);
        }}
      >
        <Edit className="h-3.5 w-3.5" />
      </Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={!!server.subscriptionId}
            onClick={(e) => {
              if (stopPropagation) e.stopPropagation();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('servers.deleteServerTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('servers.deleteServerDesc', { name: server.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={(e) => e.stopPropagation()}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(server.id);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  const deletableSelected = Array.from(selectedIds).filter(
    (id) => !servers.find((s) => s.id === id)?.subscriptionId
  );

  return (
    <div className="space-y-4">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">{t('servers.serverList')}</h3>
          <p className="text-sm text-muted-foreground">{t('servers.serverListDesc')}</p>
        </div>
        <div className="flex gap-2 items-center">
          {/* 视图切换 */}
          <div className="flex rounded-md border overflow-hidden">
            <Button
              variant={viewMode === 'card' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 w-8 p-0 rounded-none border-0"
              title={t('servers.viewCard')}
              onClick={() => setViewMode('card')}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'list' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 w-8 p-0 rounded-none border-0 border-l"
              title={t('servers.viewList')}
              onClick={() => setViewMode('list')}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>

          <Button
            variant="outline"
            className="flex items-center gap-2"
            onClick={handleSpeedTest}
            disabled={isTestingSpeed}
          >
            <Zap className={`h-4 w-4 ${isTestingSpeed ? 'animate-pulse fill-current/20' : ''}`} />
            {isTestingSpeed ? t('servers.speedTesting') : t('servers.speedTest')}
          </Button>

          {/* 批量选择按钮 */}
          {showAddButton && (
            <Button
              variant={isSelecting ? 'secondary' : 'outline'}
              size="sm"
              className="flex items-center gap-1"
              onClick={() => {
                setIsSelecting(!isSelecting);
                setSelectedIds(new Set());
              }}
            >
              <CheckSquare className="h-4 w-4" />
              {isSelecting ? t('common.cancel') : t('servers.multiSelect')}
            </Button>
          )}

          {showAddButton && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  {t('servers.addServer')}
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onAddServer}>
                  <Plus className="h-4 w-4 mr-2" />
                  {t('servers.manualAdd')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setIsImportDialogOpen(true)}>
                  <Link className="h-4 w-4 mr-2" />
                  {t('servers.importFromUrl')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* 搜索 + 过滤 + 排序栏 */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            className="pl-8 h-9"
            placeholder={t('servers.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <Select value={filterProtocol} onValueChange={setFilterProtocol}>
          <SelectTrigger className="w-[130px] h-9">
            <SelectValue placeholder={t('servers.protocol')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('servers.allProtocols')}</SelectItem>
            {ALL_PROTOCOLS.map((p) => (
              <SelectItem key={p} value={p}>
                {p.toUpperCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 flex items-center gap-1">
              <ArrowUpDown className="h-3.5 w-3.5" />
              {t('servers.sort')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(
              [
                ['name', t('servers.sortName')],
                ['protocol', t('servers.sortProtocol')],
                ['latency', t('servers.sortLatency')],
                ['address', t('servers.sortAddress')],
              ] as [SortKey, string][]
            ).map(([key, label]) => (
              <DropdownMenuItem
                key={key}
                onClick={() => {
                  if (sortKey === key) {
                    setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
                  } else {
                    setSortKey(key);
                    setSortOrder('asc');
                  }
                }}
              >
                {label} {sortKey === key ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setSortKey('name');
                setSortOrder('asc');
              }}
            >
              {t('servers.resetSort')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 批量操作栏 */}
      {isSelecting && (
        <div className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/60 border">
          <div className="flex items-center gap-3">
            <button
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
              onClick={toggleSelectAll}
            >
              {selectedIds.size === filteredServers.length && filteredServers.length > 0 ? (
                <CheckSquare className="h-4 w-4" />
              ) : (
                <Square className="h-4 w-4" />
              )}
              {t('servers.selectAll')}
            </button>
            <span className="text-sm text-muted-foreground">
              {t('servers.selectedCount', {
                count: selectedIds.size,
                total: filteredServers.length,
              })}
            </span>
          </div>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="flex items-center gap-1"
                onClick={handleBatchCopy}
              >
                <Copy className="h-3.5 w-3.5" />
                {t('servers.batchCopyCount', { count: selectedIds.size })}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex items-center gap-1"
                    disabled={deletableSelected.length === 0}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('servers.deleteCount', { count: deletableSelected.length })}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('servers.batchDelete')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('servers.batchDeleteDesc', { count: deletableSelected.length })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleBatchDelete}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {t('servers.confirmDelete')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </div>
      )}

      {/* 节点列表 */}
      {filteredServers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Server className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">
              {servers.length === 0
                ? showAddButton
                  ? t('servers.noServers')
                  : t('servers.noNodes')
                : t('servers.noMatchingNodes')}
            </h3>
            <p className="text-sm text-muted-foreground mb-4 text-center">
              {servers.length === 0
                ? showAddButton
                  ? t('servers.noServersDesc')
                  : t('servers.noSubNodesDesc')
                : t('servers.noMatchingDesc')}
            </p>
            {servers.length === 0 && showAddButton && (
              <div className="flex gap-2">
                <Button onClick={onAddServer} className="flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  {t('servers.manualAdd')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setIsImportDialogOpen(true)}
                  className="flex items-center gap-2"
                >
                  <Link className="h-4 w-4" />
                  {t('servers.importFromUrl')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : viewMode === 'card' ? (
        /* ========= 卡片视图 ========= */
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filteredServers.map((server) => {
            const countryCode = getCountryCode(server.name);
            return (
              <Card
                key={server.id}
                className={`cursor-pointer transition-colors relative overflow-hidden ${
                  selectedServerId === server.id
                    ? 'ring-2 ring-primary bg-primary/5'
                    : 'hover:bg-muted/50'
                } ${isSelecting && selectedIds.has(server.id) ? 'ring-2 ring-blue-400 bg-blue-50/10' : ''}`}
                onClick={() =>
                  isSelecting
                    ? toggleSelect(server.id, { stopPropagation: () => {} } as any)
                    : onSelectServer(server.id)
                }
              >
                {countryCode && (
                  <div
                    className="absolute -right-4 -bottom-4 z-0 h-28 w-28 opacity-[0.08] select-none pointer-events-none rounded-full overflow-hidden dark:opacity-[0.15]"
                    style={{
                      backgroundImage: `url('https://flagcdn.com/w160/${countryCode}.png')`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      backgroundRepeat: 'no-repeat',
                      maskImage:
                        'radial-gradient(circle at 60% 60%, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 85%)',
                      WebkitMaskImage:
                        'radial-gradient(circle at 60% 60%, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 85%)',
                    }}
                  />
                )}
                {/* 批量选择 checkbox */}
                {isSelecting && (
                  <div className="absolute top-2 left-2 z-10 pointer-events-none">
                    <Checkbox checked={selectedIds.has(server.id)} />
                  </div>
                )}
                <CardHeader className={`pb-2 ${isSelecting ? 'pl-8' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="text-sm truncate">{server.name}</CardTitle>
                      <CardDescription className="text-xs mt-0.5">
                        {server.address}:{server.port}
                      </CardDescription>
                    </div>
                    {!isSelecting && renderActions(server)}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    <Badge
                      className={`text-xs h-4 px-1 border ${getProtocolBadgeVariant(server.protocol)}`}
                    >
                      {server.protocol.toUpperCase()}
                    </Badge>
                    {selectedServerId === server.id && (
                      <Badge variant="outline" className="text-xs h-4 px-1">
                        {t('servers.current')}
                      </Badge>
                    )}
                    {server.shadowTlsSettings && (
                      <Badge
                        variant="outline"
                        className="text-xs h-4 px-1 text-teal-600 border-teal-300/50"
                      >
                        +ST
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pt-0 pb-3">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {server.protocol?.toLowerCase() === 'shadowsocks' ? (
                      <span>
                        {t('servers.encryption')}: {server.shadowsocksSettings?.method || 'N/A'}
                      </span>
                    ) : (
                      <>
                        <span>
                          {t('servers.transport')}: {server.network || 'tcp'}
                        </span>
                        <span>
                          {t('servers.encryption')}: {server.security || 'none'}
                        </span>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        /* ========= 列表视图 ========= */
        <div className="rounded-md border divide-y">
          {filteredServers.map((server) => {
            const countryCode = getCountryCode(server.name);
            return (
              <div
                key={server.id}
                className={`relative overflow-hidden flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
                  selectedServerId === server.id ? 'bg-primary/5' : 'hover:bg-muted/50'
                } ${isSelecting && selectedIds.has(server.id) ? 'bg-blue-50/10' : ''}`}
                onClick={() => {
                  if (isSelecting) {
                    setSelectedIds((prev) => {
                      const s = new Set(prev);
                      if (s.has(server.id)) {
                        s.delete(server.id);
                      } else {
                        s.add(server.id);
                      }
                      return s;
                    });
                  } else {
                    onSelectServer(server.id);
                  }
                }}
              >
                {/* 批量选择 */}
                {isSelecting && (
                  <Checkbox className="pointer-events-none" checked={selectedIds.has(server.id)} />
                )}

                {/* 选中指示器 */}
                {!isSelecting && (
                  <div
                    className={`relative z-10 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      selectedServerId === server.id ? 'bg-primary' : 'bg-transparent'
                    }`}
                  />
                )}

                {/* 背景国旗 */}
                {countryCode && (
                  <div
                    className="absolute right-12 top-1/2 -translate-y-1/2 z-0 h-24 w-24 opacity-[0.05] select-none pointer-events-none rounded-full overflow-hidden dark:opacity-[0.1]"
                    style={{
                      backgroundImage: `url('https://flagcdn.com/w80/${countryCode}.png')`,
                      backgroundSize: 'contain',
                      backgroundPosition: 'center',
                      backgroundRepeat: 'no-repeat',
                      maskImage:
                        'linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 30%, rgba(0,0,0,1) 70%, rgba(0,0,0,0) 100%)',
                      WebkitMaskImage:
                        'linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 30%, rgba(0,0,0,1) 70%, rgba(0,0,0,0) 100%)',
                    }}
                  />
                )}

                {/* 名称 + 地址 */}
                <div className="flex-1 min-w-0 relative z-10">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{server.name}</span>
                    <Badge
                      className={`text-[10px] h-4 px-1 flex-shrink-0 border ${getProtocolBadgeVariant(server.protocol)}`}
                    >
                      {server.protocol.toUpperCase()}
                    </Badge>
                    {server.shadowTlsSettings && (
                      <Badge
                        variant="outline"
                        className="text-[10px] h-4 px-1 flex-shrink-0 text-teal-600 border-teal-300/50"
                      >
                        +ST
                      </Badge>
                    )}
                    {selectedServerId === server.id && (
                      <Badge variant="outline" className="text-[10px] h-4 px-1 flex-shrink-0">
                        {t('servers.current')}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {server.address}:{server.port}
                    {server.network && server.network !== 'tcp' && (
                      <span className="ml-2">{server.network}</span>
                    )}
                  </p>
                </div>

                {/* 延迟 + 操作 */}
                {!isSelecting && (
                  <div className="relative z-10 flex items-center">{renderActions(server)}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ImportUrlDialog
        open={isImportDialogOpen}
        onOpenChange={setIsImportDialogOpen}
        onImportSuccess={onImportSuccess}
      />
    </div>
  );
}
