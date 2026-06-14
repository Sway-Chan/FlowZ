import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Loader2, RotateCw, Search, Search as SearchIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/ipc/api-client';
import type {
  RuleResourceCatalogItem,
  RuleResourceCatalogResult,
  RuleResourceCategory,
  RuleResourceDownloadItem,
} from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import { RULE_RESOURCE_CATALOG } from '../../../shared/rule-resource-catalog';

const BUILTIN_CATALOG_IDS = RULE_RESOURCE_CATALOG.map((i) => i.id);

// 分类筛选：全部 / geosite / geoip / 精简（lite）。catalog 永不含 custom（仅手动 URL 下载），故不设该选项
type CatalogFilter = 'all' | 'geosite' | 'geoip' | 'lite';
const CATALOG_FILTERS: CatalogFilter[] = ['all', 'geosite', 'geoip', 'lite'];

export const RESOURCE_CATEGORY_BADGE: Record<RuleResourceCategory, string> = {
  geosite: 'border-transparent bg-badge-blue/15 text-badge-blue',
  'geosite-lite': 'border-transparent bg-badge-blue/10 text-badge-blue',
  geoip: 'border-transparent bg-badge-purple/15 text-badge-purple',
  'geoip-lite': 'border-transparent bg-badge-purple/10 text-badge-purple',
  custom: 'border-transparent bg-muted text-muted-foreground',
};

interface ResourceCatalogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  downloadedIds: Set<string>;
  onDownload: (items: RuleResourceDownloadItem[]) => void;
}

export function ResourceCatalogDialog({
  open,
  onOpenChange,
  downloadedIds,
  onDownload,
}: ResourceCatalogDialogProps) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<RuleResourceCatalogResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setSearch('');
    setFilter('all');
    setLoading(true);
    api.ruleResources
      .getCatalog()
      .then(setCatalog)
      .catch(() => setCatalog(null))
      .finally(() => setLoading(false));
  }, [open]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await api.ruleResources.refreshCatalog();
      setCatalog(res);
      toast.success(t('ruleResources.refreshOk', '资源库已更新'));
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      toast.error(
        code === 'rate_limited'
          ? t('ruleResources.rateLimited', 'GitHub 请求频繁，请稍后再试')
          : t('ruleResources.refreshFailed', '刷新资源库失败')
      );
    } finally {
      setRefreshing(false);
    }
  };

  const all = catalog?.items || [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byCat = (i: RuleResourceCatalogItem) =>
      filter === 'all' ||
      (filter === 'lite' ? i.category.endsWith('-lite') : i.category === filter);
    if (q) {
      const matched = all.filter(
        (i) => byCat(i) && (i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q))
      );
      return { items: matched.slice(0, 200), total: matched.length };
    }
    // 无搜索：只展示内置精选（推荐）；分类筛选在精选内生效（兜底判断须基于未筛选交集，否则空分类会错切全量）
    const builtinIds = new Set(BUILTIN_CATALOG_IDS);
    const curated = all.filter((i) => builtinIds.has(i.id));
    const pool = curated.length ? curated : all.slice(0, 80);
    const items = pool.filter(byCat);
    return { items, total: items.length };
  }, [all, search, filter]);

  const truncated = filtered.total > filtered.items.length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleDownload = () => {
    onDownload(Array.from(selected).map((id) => ({ catalogId: id })));
    onOpenChange(false);
  };

  const item = (i: RuleResourceCatalogItem) => {
    const already = downloadedIds.has(i.id);
    return (
      <label
        key={i.id}
        className={`flex items-center gap-3 px-3 py-2 ${
          already ? 'opacity-50' : 'cursor-pointer hover:bg-muted/50'
        }`}
      >
        <Checkbox
          checked={selected.has(i.id)}
          disabled={already}
          onCheckedChange={() => !already && toggle(i.id)}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{i.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{i.path}</div>
        </div>
        <Badge variant="outline" className={RESOURCE_CATEGORY_BADGE[i.category]}>
          {t(`ruleResources.category.${i.category}`, i.category)}
        </Badge>
        {already && (
          <span className="text-xs text-muted-foreground">
            {t('ruleResources.downloaded', '已下载')}
          </span>
        )}
      </label>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>{t('ruleResources.library', '资源库')}</DialogTitle>
            <div className="flex items-center gap-2 pr-6">
              {catalog?.fetchedAt && (
                <span className="text-xs text-muted-foreground">
                  {t('ruleResources.catalogUpdatedAt', '更新于')}{' '}
                  {new Date(catalog.fetchedAt).toLocaleDateString()}
                </span>
              )}
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={refresh}
                disabled={refreshing}
                title={t('ruleResources.refreshCatalog', '刷新资源库')}
              >
                <RotateCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
          <DialogDescription>
            {t('ruleResources.libraryDesc', '从 meta-rules-dat 选择 .srs 规则集下载（可多选）')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('ruleResources.searchCatalog', '搜索规则集')}
              className="pl-8"
            />
          </div>

          <SegmentedControl<CatalogFilter>
            value={filter}
            onChange={setFilter}
            options={CATALOG_FILTERS.map((f) => ({
              value: f,
              label:
                f === 'all'
                  ? t('ruleResources.filterAll', '全部')
                  : f === 'lite'
                    ? t('ruleResources.filterLite', '精简')
                    : t(`ruleResources.category.${f}`, f),
            }))}
          />

          <ScrollArea className="h-80 rounded-md border">
            {loading ? (
              <div className="flex h-80 items-center justify-center text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('common.loading', '加载中...')}
              </div>
            ) : filtered.items.length === 0 ? (
              <div className="flex h-80 items-center justify-center text-sm text-muted-foreground">
                {t('ruleResources.noCatalog', '没有匹配的规则集')}
              </div>
            ) : (
              <div className="divide-y divide-border/60">
                {filtered.items.map(item)}
                {truncated && (
                  <div className="flex items-center justify-center gap-1.5 px-3 py-3 text-xs text-muted-foreground">
                    <SearchIcon className="h-3.5 w-3.5" />
                    {t('ruleResources.searchMore', '结果较多，继续输入以精确搜索')}
                  </div>
                )}
              </div>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('servers.cancel', '取消')}
          </Button>
          <Button onClick={handleDownload} disabled={selected.size === 0}>
            {t('ruleResources.downloadNItems', '下载 {{count}} 项', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
