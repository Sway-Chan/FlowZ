import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { APP_PRESETS, type AppPreset } from '../../../shared/app-rules-preset';
import type { AppRule, RuleAction, CustomAppPreset } from '../../../shared/types';
import { Plus, Trash2, Search, LayoutGrid, List, Image as ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useEffect } from 'react';

export function AppRulesCard() {
  const { t } = useTranslation();
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);

  // -- 新增自定义应用状态 --
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newAppName, setNewAppName] = useState('');
  const [newAppEmoji, setNewAppEmoji] = useState('🌐');
  const [newAppIconUrl, setNewAppIconUrl] = useState('');
  const [newAppGeosite, setNewAppGeosite] = useState('');
  const [newAppGeoIP, setNewAppGeoIP] = useState('');

  // -- 图标库状态 --
  const [iconGalleries, setIconGalleries] = useState<{ name: string; url: string }[]>([]);
  const [isLoadingIcons, setIsLoadingIcons] = useState(false);
  const [appSearchQuery, setAppSearchQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showIconGallery, setShowIconGallery] = useState(false);
  const [viewMode, setViewMode] = useState<'comfortable' | 'compact'>(
    () => (localStorage.getItem('flowz_app_view_mode') as 'comfortable' | 'compact') || 'compact'
  );

  useEffect(() => {
    localStorage.setItem('flowz_app_view_mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    if (!showIconGallery || iconGalleries.length > 0) return;

    const fetchIcons = async () => {
      setIsLoadingIcons(true);
      try {
        // 尝试多个源，提高在不同网络环境下的成功率
        const fetchWithFallback = async (urls: string[]) => {
          for (const url of urls) {
            try {
              const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
              if (res.ok) return await res.json();
            } catch {
              console.warn(`Failed to fetch from ${url}, trying next...`);
            }
          }
          throw new Error('All icon sources failed');
        };

        const [qureData, edcData] = await Promise.all([
          fetchWithFallback([
            'https://cdn.jsdelivr.net/gh/Koolson/Qure/Other/QureColor-All.json',
            'https://fastly.jsdelivr.net/gh/Koolson/Qure/Other/QureColor-All.json',
            'https://raw.githubusercontent.com/Koolson/Qure/master/Other/QureColor-All.json',
          ]),
          fetchWithFallback([
            'https://cdn.jsdelivr.net/gh/erdongchanyo/icon@main/edc-filter-icon-gallery.json',
            'https://fastly.jsdelivr.net/gh/erdongchanyo/icon@main/edc-filter-icon-gallery.json',
            'https://raw.githubusercontent.com/erdongchanyo/icon/main/edc-filter-icon-gallery.json',
          ]),
        ]);

        const allIcons = [...(qureData?.icons || []), ...(edcData?.icons || [])];
        setIconGalleries(allIcons);
      } catch (e) {
        console.error('Failed to fetch icon galleries:', e);
        toast.error('图标库加载失败，请检查网络连接');
      } finally {
        setIsLoadingIcons(false);
      }
    };
    fetchIcons();
  }, [showIconGallery, iconGalleries.length]);

  const filteredIcons = searchQuery
    ? iconGalleries.filter((i) => i.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : iconGalleries.slice(0, 100);

  if (!config) return null;

  const appRules: AppRule[] = config.appRules || [];
  const customPresets: CustomAppPreset[] = config.customAppPresets || [];

  // 合并预设列表进行渲染
  const allPresets: AppPreset[] = [
    ...APP_PRESETS,
    ...customPresets.map((p) => ({
      id: p.id,
      labelKey: p.name,
      emoji: p.emoji,
      iconUrl: p.iconUrl,
      geositeTags: p.geositeTags,
      geoipTags: p.geoipTags,
      category: 'tools' as const,
      isCustom: true,
    })),
  ];

  // -- 过滤后的预设列表 --
  const filteredPresets = allPresets.filter((p) => {
    if (!appSearchQuery.trim()) return true;
    const label = (p as any).isCustom ? p.labelKey : t(`rules.apps.${p.labelKey}` as any);
    return label.toLowerCase().includes(appSearchQuery.toLowerCase());
  });

  const getAppRule = (appId: string): AppRule | undefined =>
    appRules.find((r) => r.appId === appId);

  const handlePolicyChange = async (preset: AppPreset, value: string) => {
    let action: RuleAction = 'proxy';
    let targetServerId: string | undefined = undefined;
    let enabled = true;

    if (value === 'direct') action = 'direct';
    else if (value === 'block') action = 'block';
    else if (value === 'proxy-default') {
      action = 'proxy';
      enabled = false;
    } else if (value.startsWith('node-')) {
      action = 'proxy';
      targetServerId = value.replace('node-', '');
    }

    const existing = getAppRule(preset.id);
    let newRules: AppRule[];

    if (existing) {
      newRules = appRules.map((r) =>
        r.appId === preset.id ? { ...r, action, targetServerId, enabled } : r
      );
    } else {
      if (value === 'proxy-default') return;
      newRules = [...appRules, { appId: preset.id, action, targetServerId, enabled: true }];
    }

    await saveConfig({ ...config, appRules: newRules });
  };

  const handleAddCustomApp = async () => {
    if (!newAppName.trim() || !newAppGeosite.trim()) {
      toast.error('请填写应用名称和 Geosite 标签');
      return;
    }

    const newId = `custom-${Date.now()}`;
    const newPreset: CustomAppPreset = {
      id: newId,
      name: newAppName.trim(),
      emoji: newAppEmoji.trim() || '🌐',
      iconUrl: newAppIconUrl.trim() || undefined,
      geositeTags: newAppGeosite
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      geoipTags: newAppGeoIP
        ? newAppGeoIP
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    };

    await saveConfig({
      ...config,
      customAppPresets: [...customPresets, newPreset],
    });

    setIsAddDialogOpen(false);
    setShowIconGallery(false);
    setNewAppName('');
    setNewAppEmoji('🌐');
    setNewAppIconUrl('');
    setNewAppGeosite('');
    setNewAppGeoIP('');
    toast.success('自定义应用添加成功');
  };

  const handleDeleteCustomApp = async (appId: string) => {
    const newPresets = customPresets.filter((p) => p.id !== appId);
    const newRules = appRules.filter((r) => r.appId !== appId);
    await saveConfig({
      ...config,
      customAppPresets: newPresets,
      appRules: newRules,
    });
    toast.success('自定义应用已删除');
  };

  return (
    <Card>
      <CardContent className="pt-6 space-y-6">
        {/* 顶部搜索框：补齐视觉突兀感 */}
        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex-1 group">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50 transition-colors group-focus-within:text-primary" />
            <Input
              placeholder={t('rules.searchApps' as any) || '搜索应用...'}
              value={appSearchQuery}
              onChange={(e) => setAppSearchQuery(e.target.value)}
              className="pl-10 h-11 bg-muted/40 border-muted-foreground/10 focus:border-primary/30 transition-all rounded-xl text-sm"
            />
          </div>

          <div className="flex items-center bg-muted/30 p-1 rounded-xl border border-muted-foreground/5">
            <Button
              variant={viewMode === 'comfortable' ? 'secondary' : 'ghost'}
              size="icon"
              className={`h-9 w-9 rounded-lg ${viewMode === 'comfortable' ? 'shadow-sm' : ''}`}
              onClick={() => setViewMode('comfortable')}
              title="舒适模式 (Style A)"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'compact' ? 'secondary' : 'ghost'}
              size="icon"
              className={`h-9 w-9 rounded-lg ${viewMode === 'compact' ? 'shadow-sm' : ''}`}
              onClick={() => setViewMode('compact')}
              title="紧凑模式 (Style B)"
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div
          className={
            viewMode === 'comfortable'
              ? 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4'
              : 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3'
          }
        >
          {filteredPresets.map((preset) => {
            const rule = getAppRule(preset.id);
            const isEnabled = rule?.enabled ?? false;
            const isCustom = preset.id.startsWith('custom-');

            return (
              <div key={preset.id} className="group relative">
                <Select
                  value={(() => {
                    if (!rule || !isEnabled) return 'proxy-default';
                    if (rule.action === 'direct') return 'direct';
                    if (rule.action === 'block') return 'block';
                    return rule.targetServerId ? `node-${rule.targetServerId}` : 'proxy-default';
                  })()}
                  onValueChange={(v) => handlePolicyChange(preset, v)}
                >
                  <SelectTrigger
                    className={`h-${viewMode === 'comfortable' ? '[110px]' : '[88px]'} w-full p-${viewMode === 'comfortable' ? '3.5' : '2.5'} flex flex-col items-start rounded-xl border border-muted-foreground/10 transition-all duration-300 shadow-none focus:ring-0 [&>svg]:hidden bg-muted/40 hover:bg-muted/60 relative overflow-hidden`}
                  >
                    {/* 左上脚标：Surge 风格 */}
                    <div
                      className={`text-[8px] text-muted-foreground/50 font-medium tracking-tight uppercase leading-none mt-0.5 mb-1 ${viewMode === 'comfortable' ? 'ml-1.5' : 'ml-2.5'}`}
                    >
                      {t('rules.appRulesManualSelection')}
                    </div>

                    <div
                      className={
                        viewMode === 'comfortable'
                          ? 'flex items-center gap-2.5 w-full flex-1 ml-1.5'
                          : 'flex items-center gap-2 w-full mt-0.5 ml-2.5'
                      }
                    >
                      <div
                        className={`${viewMode === 'comfortable' ? 'h-9 w-9' : 'h-6 w-6'} flex items-center justify-center bg-background/80 rounded-lg shadow-sm border border-white/${viewMode === 'comfortable' ? '10' : '5'} p-${viewMode === 'comfortable' ? '1' : '0.5'} shrink-0 transition-transform group-hover:scale-105`}
                      >
                        {preset.iconUrl ? (
                          <img
                            src={preset.iconUrl}
                            alt=""
                            className="h-full w-full object-contain"
                            loading="lazy"
                            onError={(e) => {
                              (e.target as any).style.display = 'none';
                              (e.target as any).nextSibling.style.display = 'block';
                            }}
                          />
                        ) : null}
                        <span
                          className={viewMode === 'comfortable' ? 'text-xl' : 'text-xs'}
                          style={{ display: preset.iconUrl ? 'none' : 'block' }}
                        >
                          {preset.emoji}
                        </span>
                      </div>
                      <span
                        className={`text-[${viewMode === 'comfortable' ? '13px' : '12px'}] font-bold truncate tracking-tight transition-colors ${
                          isEnabled ? 'text-foreground' : 'text-foreground/70'
                        }`}
                      >
                        {isCustom ? preset.labelKey : t(`rules.apps.${preset.labelKey}` as any)}
                      </span>
                    </div>

                    {viewMode === 'comfortable' && (
                      <div className="h-4 w-full flex-none opacity-0 pointer-events-none" />
                    )}

                    <div
                      className={
                        viewMode === 'comfortable'
                          ? `absolute bottom-1.5 left-2.5 right-3.5 text-[9.5px] w-full text-left font-bold tracking-normal truncate ${
                              !rule || !isEnabled
                                ? 'text-muted-foreground/60'
                                : rule.action === 'direct'
                                  ? 'text-green-600 dark:text-green-400'
                                  : rule.action === 'block'
                                    ? 'text-red-600 dark:text-red-400'
                                    : 'text-primary'
                            }`
                          : `text-[9px] w-full text-left font-bold tracking-normal truncate ml-2 ${
                              !rule || !isEnabled
                                ? 'text-muted-foreground/60'
                                : rule.action === 'direct'
                                  ? 'text-green-600 dark:text-green-400'
                                  : rule.action === 'block'
                                    ? 'text-red-600 dark:text-red-400'
                                    : 'text-primary'
                            }`
                      }
                    >
                      <div className="flex items-center gap-1">
                        <div
                          className={`${viewMode === 'comfortable' ? 'h-1.5 w-1.5' : 'h-1 w-1'} rounded-full ${
                            !rule || !isEnabled
                              ? 'bg-muted-foreground/30'
                              : rule.action === 'direct'
                                ? 'bg-green-500'
                                : rule.action === 'block'
                                  ? 'bg-red-500'
                                  : 'bg-primary'
                          }`}
                        />
                        <span className="truncate">
                          {(() => {
                            if (!rule || !isEnabled) return 'Proxy';
                            if (rule.action === 'direct') return 'DIRECT';
                            if (rule.action === 'block') return 'BLOCK';
                            if (rule.targetServerId) {
                              const s = config.servers?.find(
                                (server) => server.id === rule.targetServerId
                              );
                              return s ? s.name : 'Proxy';
                            }
                            return 'Proxy';
                          })()}
                        </span>
                      </div>
                    </div>
                  </SelectTrigger>

                  <SelectContent className="max-h-[300px]">
                    <div className="px-2 py-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-wide">
                      系统策略
                    </div>
                    <SelectItem value="proxy-default" className="text-xs font-medium text-primary">
                      代理
                    </SelectItem>
                    <SelectItem
                      value="direct"
                      className="text-xs text-green-600 dark:text-green-500"
                    >
                      {t('rules.direct')}
                    </SelectItem>
                    <SelectItem value="block" className="text-xs text-red-600 dark:text-red-500">
                      {t('rules.block')}
                    </SelectItem>

                    {config.servers && config.servers.length > 0 && (
                      <>
                        <div className="px-2 py-1.5 mt-1 text-[10px] font-bold text-muted-foreground uppercase tracking-wide border-t">
                          独立路由节点
                        </div>
                        {config.servers.map((s) => (
                          <SelectItem key={s.id} value={`node-${s.id}`} className="text-xs">
                            {s.name}
                          </SelectItem>
                        ))}
                      </>
                    )}
                  </SelectContent>
                </Select>

                {isCustom && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteCustomApp(preset.id);
                    }}
                    className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-sm z-10"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}

          {/* 新增按钮：始终在最后 */}
          {!appSearchQuery && (
            <div className="group relative">
              <Button
                variant="outline"
                onClick={() => {
                  setShowIconGallery(false);
                  setIsAddDialogOpen(true);
                }}
                className={`${viewMode === 'comfortable' ? 'h-[110px]' : 'h-[88px]'} w-full flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-muted-foreground/10 bg-transparent hover:bg-muted/30 hover:border-primary/30 transition-all duration-300 shadow-none`}
              >
                <div className="h-9 w-9 flex items-center justify-center bg-muted/40 rounded-full group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                  <Plus className="h-6 w-6 text-muted-foreground/60 group-hover:text-primary" />
                </div>
                <span className="text-xs font-medium text-muted-foreground/70 group-hover:text-primary transition-colors">
                  创建自定义
                </span>
              </Button>
            </div>
          )}
        </div>
      </CardContent>

      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          {showIconGallery ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setShowIconGallery(false)}
                  >
                    <Plus className="h-4 w-4 rotate-45" />
                  </Button>
                  选择图标库
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="在 Qure Color / EDC 库中搜索..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9 h-10 text-sm bg-muted/30 border-none focus-visible:ring-1"
                  />
                </div>
                <ScrollArea className="h-[300px] pr-4">
                  <div className="grid grid-cols-5 gap-3 p-1">
                    {isLoadingIcons ? (
                      <div className="col-span-5 py-20 text-center text-sm text-muted-foreground animate-pulse">
                        正在加载云端图标库...
                      </div>
                    ) : (
                      <>
                        {!searchQuery && (
                          <Button
                            variant="outline"
                            className="h-12 w-12 p-0 text-xl hover:bg-primary/5 hover:border-primary/30"
                            onClick={() => {
                              setNewAppIconUrl('');
                              setNewAppEmoji('🌐');
                              setShowIconGallery(false);
                            }}
                          >
                            🌐
                          </Button>
                        )}
                        {filteredIcons.map((icon, idx) => (
                          <Button
                            key={`${icon.name}-${idx}`}
                            variant="ghost"
                            className="h-12 w-12 p-1.5 hover:bg-primary/5 hover:border-primary/30 border border-transparent transition-all"
                            onClick={() => {
                              setNewAppIconUrl(icon.url);
                              if (!newAppName) {
                                setNewAppName(icon.name.replace('.png', '').replace(/_/g, ' '));
                              }
                              setShowIconGallery(false);
                            }}
                          >
                            <img
                              src={icon.url}
                              className="h-full w-full object-contain"
                              alt={icon.name}
                            />
                          </Button>
                        ))}
                      </>
                    )}
                  </div>
                  {!isLoadingIcons && iconGalleries.length === 0 && (
                    <div className="py-10 text-center space-y-2">
                      <p className="text-xs text-muted-foreground">加载失败或网络受限</p>
                      <Button
                        variant="link"
                        size="sm"
                        className="text-[10px]"
                        onClick={() => {
                          setIconGalleries([]); // 触发 useEffect 重试
                        }}
                      >
                        点击重试
                      </Button>
                    </div>
                  )}
                </ScrollArea>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>新增自定义应用分流</DialogTitle>
                <DialogDescription>创建规则，像使用内置应用一样方便。</DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label className="text-right">图标</Label>
                  <div className="col-span-3">
                    <Button
                      variant="outline"
                      className="w-full flex items-center justify-between gap-3 px-4 h-12 rounded-xl group border-dashed hover:border-primary/50 hover:bg-primary/5 transition-all"
                      onClick={() => setShowIconGallery(true)}
                    >
                      <div className="flex items-center gap-3 overflow-hidden">
                        <div className="h-8 w-8 flex items-center justify-center shrink-0">
                          {newAppIconUrl ? (
                            <img src={newAppIconUrl} className="h-full w-full object-contain" />
                          ) : (
                            <span className="text-xl">{newAppEmoji}</span>
                          )}
                        </div>
                        <div className="flex flex-col items-start overflow-hidden">
                          <span className="text-sm font-medium">点击浏览图标库</span>
                          <span className="text-[10px] text-muted-foreground truncate">
                            {newAppIconUrl ? '已选: ' + newAppIconUrl : '从 Qure / EDC 中选择'}
                          </span>
                        </div>
                      </div>
                      <ImageIcon className="h-4 w-4 opacity-40 group-hover:opacity-100 group-hover:text-primary transition-all" />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="name" className="text-right">
                    名称
                  </Label>
                  <Input
                    id="name"
                    value={newAppName}
                    onChange={(e) => setNewAppName(e.target.value)}
                    placeholder="应用名称"
                    className="col-span-3 h-10 rounded-lg bg-muted/20 border-none focus-visible:ring-1"
                  />
                </div>
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="geosite" className="text-right">
                    Geosite
                  </Label>
                  <Input
                    id="geosite"
                    value={newAppGeosite}
                    onChange={(e) => setNewAppGeosite(e.target.value)}
                    placeholder="如 apple,icloud"
                    className="col-span-3 h-10 rounded-lg bg-muted/20 border-none focus-visible:ring-1"
                  />
                </div>
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="geoip" className="text-right">
                    GeoIP
                  </Label>
                  <Input
                    id="geoip"
                    value={newAppGeoIP}
                    onChange={(e) => setNewAppGeoIP(e.target.value)}
                    placeholder="可选，如 apple"
                    className="col-span-3 h-10 rounded-lg bg-muted/20 border-none focus-visible:ring-1"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                  取消
                </Button>
                <Button onClick={handleAddCustomApp}>保存应用</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
