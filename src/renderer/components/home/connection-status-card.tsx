import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/store/app-store';
import { Plus, ArrowUp, ArrowDown } from 'lucide-react';
import { toast } from 'sonner';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '@/lib/format';

export function ConnectionStatusCard() {
  const connectionStatus = useAppStore((state) => state.connectionStatus);
  const config = useAppStore((state) => state.config);
  const error = useAppStore((state) => state.error);
  const isLoading = useAppStore((state) => state.isLoading);
  const saveConfig = useAppStore((state) => state.saveConfig);
  const setCurrentView = useAppStore((state) => state.setCurrentView);
  const stats = useAppStore((state) => state.stats);
  const refreshStatistics = useAppStore((state) => state.refreshStatistics);

  // 挂载时拉一次初值（事件驱动更新由 useNativeEventListeners 负责）
  useEffect(() => {
    refreshStatistics();
  }, [refreshStatistics]);

  const servers = config?.servers || [];
  const selectedServerId = config?.selectedServerId;
  const selectedServer = servers.find((s) => s.id === selectedServerId);
  const { t } = useTranslation();

  const getStatusInfo = () => {
    // Use proxyModeType from connectionStatus if available, otherwise fall back to config
    const proxyModeType = connectionStatus?.proxyModeType || config?.proxyModeType || 'systemProxy';
    const isTunMode = proxyModeType === 'tun';
    const isManualMode = proxyModeType === 'manual';
    const modeText = isTunMode
      ? t('home.tunMode')
      : isManualMode
        ? t('home.manualMode')
        : t('home.systemProxyMode');

    // Show error from store if present
    if (error) {
      return {
        label: t('home.statusError'),
        variant: 'destructive' as const,
        description: error,
        mode: modeText,
      };
    }

    if (!connectionStatus) {
      return {
        label: t('home.statusUnknown'),
        variant: 'secondary' as const,
        description: t('home.fetchingStatus'),
        mode: modeText,
      };
    }

    const { proxyCore, proxy } = connectionStatus;

    // Handle proxy core errors with more specific messages
    if (proxyCore.error) {
      // Parse TUN mode specific errors
      let errorDescription = proxyCore.error;

      if (proxyCore.error.includes('权限不足') || proxyCore.error.includes('管理员权限')) {
        errorDescription = t('home.tunNeedsAdmin');
      } else if (proxyCore.error.includes('wintun') || proxyCore.error.includes('驱动')) {
        errorDescription = t('home.tunDriverFail');
      } else if (proxyCore.error.includes('接口创建失败')) {
        errorDescription = t('home.tunInterfaceFail');
      } else if (proxyCore.error.includes('sing-box.exe')) {
        errorDescription = t('home.singboxMissing');
      }

      return {
        label: t('home.statusError'),
        variant: 'destructive' as const,
        description: errorDescription,
        mode: modeText,
      };
    }

    // TUN模式下，只需要检查代理核心是否运行
    if (isTunMode) {
      if (proxyCore.running) {
        const uptime = proxyCore.uptime
          ? t('home.uptime', { min: Math.floor(proxyCore.uptime / 60) })
          : '';
        return {
          label: t('home.statusConnected'),
          variant: 'default' as const,
          description: `${t('home.tunMode')}${t('home.statusConnected')}${uptime ? ' - ' + uptime : ''}`,
          mode: modeText,
        };
      }

      if (isLoading) {
        return {
          label: t('home.statusConnecting'),
          variant: 'secondary' as const,
          description: t('home.startingTun'),
          mode: modeText,
        };
      }

      return {
        label: t('home.statusDisconnected'),
        variant: 'outline' as const,
        description: t('home.tunNotEnabled'),
        mode: modeText,
      };
    }

    // 系统代理或仅本地代理模式下，需要检查代理核心和（系统代理的）状态
    // 对于仅本地代理，只要 proxyCore.running 即可，因为它不碰 proxy.enabled状态
    if (proxyCore.running && (proxy.enabled || isManualMode)) {
      const uptime = proxyCore.uptime
        ? t('home.uptime', { min: Math.floor(proxyCore.uptime / 60) })
        : '';

      if (isManualMode) {
        return {
          label: t('home.statusConnected'),
          variant: 'default' as const,
          description: uptime ? `${t('home.manualMode')} - ${uptime}` : t('home.manualMode'),
          mode: modeText,
          isManualNotice: true,
        };
      }

      return {
        label: t('home.statusConnected'),
        variant: 'default' as const,
        description: `${t('home.systemProxyConnected')}${uptime ? ' - ' + uptime : ''}`,
        mode: modeText,
      };
    }

    if (proxyCore.running && !proxy.enabled && !isManualMode) {
      return {
        label: t('home.statusConnecting'),
        variant: 'secondary' as const,
        description: t('home.singboxRunningEnabling'),
        mode: modeText,
      };
    }

    if (isLoading) {
      return {
        label: t('home.statusConnecting'),
        variant: 'secondary' as const,
        description: t('home.startingSingbox'),
        mode: modeText,
      };
    }

    return {
      label: t('home.statusDisconnected'),
      variant: 'outline' as const,
      description: t('home.proxyNotEnabled'),
      mode: modeText,
    };
  };

  const handleServerChange = async (serverId: string) => {
    if (!config) return;

    try {
      const updatedConfig = {
        ...config,
        selectedServerId: serverId,
      };

      await saveConfig(updatedConfig);
      toast.success(t('home.serverSwitched'));
    } catch (error) {
      toast.error(t('home.switchFailed'), {
        description: error instanceof Error ? error.message : t('home.switchError'),
      });
    }
  };

  const handleGoToServers = () => {
    setCurrentView('server');
  };

  const statusInfo = getStatusInfo();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('home.connectionStatus')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t('home.status')}</span>
          <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t('home.proxyMode')}</span>
          <Badge variant="secondary">{statusInfo.mode}</Badge>
        </div>

        {/* 服务器选择区域 */}
        {servers.length === 0 ? (
          <div className="space-y-3">
            <div className="p-4 border border-dashed border-muted-foreground/25 rounded-lg text-center">
              <p className="text-sm text-muted-foreground mb-3">{t('home.noServerConfig')}</p>
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGoToServers}
                  className="flex items-center gap-2"
                >
                  <Plus className="h-4 w-4" />
                  {t('home.addServer')}
                </Button>
              </div>
            </div>
          </div>
        ) : !selectedServer ? (
          <div className="space-y-3">
            <div className="p-4 border border-yellow-500/50 bg-yellow-500/10 rounded-lg">
              <p className="text-sm text-yellow-600 dark:text-yellow-400 mb-3">
                ⚠️ {t('home.selectServerHint')}
              </p>
              <Select onValueChange={handleServerChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('home.selectServer')} />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((server) => (
                    <SelectItem key={server.id} value={server.id}>
                      <span className="truncate max-w-[200px] md:max-w-[260px] inline-block align-bottom">
                        {server.name} ({server.protocol})
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* 服务器切换 */}
            <div className="space-y-2">
              <div className="space-y-2">
                <span className="text-sm text-muted-foreground">{t('home.currentServer')}</span>
                <Select value={selectedServerId ?? undefined} onValueChange={handleServerChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('home.selectServer')} />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.map((server) => (
                      <SelectItem key={server.id} value={server.id}>
                        <span className="truncate max-w-[200px] md:max-w-[260px] inline-block align-bottom">
                          {server.name} ({server.protocol})
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* 服务器详细信息 */}
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t('home.protocol')}</span>
                <Badge variant="outline" className="text-xs">
                  {selectedServer.protocol}
                </Badge>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t('home.address')}</span>
                <span
                  className="text-sm font-medium truncate max-w-[150px]"
                  title={selectedServer.address}
                >
                  {selectedServer.address}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t('home.port')}</span>
                <span className="text-sm font-medium">{selectedServer.port}</span>
              </div>
            </div>
          </div>
        )}

        <div className="pt-2 border-t">
          <p className="text-xs text-muted-foreground">{statusInfo.description}</p>
        </div>

        {/* 流量统计：代理运行时展示实时上下行速率 + 累计 + 连接数 */}
        {connectionStatus?.proxyCore?.running && stats && (
          <div className="grid grid-cols-3 gap-2 pt-2 border-t text-center">
            <div>
              <p className="text-xs text-muted-foreground flex items-center justify-center gap-0.5">
                <ArrowUp className="h-3 w-3" />
                {formatBytes(stats.uploadSpeed)}/s
              </p>
              <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                {formatBytes(stats.totalUpload)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground flex items-center justify-center gap-0.5">
                <ArrowDown className="h-3 w-3" />
                {formatBytes(stats.downloadSpeed)}/s
              </p>
              <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                {formatBytes(stats.totalDownload)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{stats.activeConnections ?? 0}</p>
              <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                {t('home.connections', '连接')}
              </p>
            </div>
          </div>
        )}

        {/* 仅本地代理特殊提示区 */}
        {(statusInfo as any).isManualNotice && (
          <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg space-y-1">
            <p className="text-sm font-medium text-blue-600 dark:text-blue-400 flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
              </span>
              {t('home.manualModeTip')}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
