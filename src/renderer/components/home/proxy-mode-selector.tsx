import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store/app-store';
import { Loader2, Play, Square } from 'lucide-react';
import type { ProxyMode } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

export function ProxyModeSelector() {
  const { t } = useTranslation();
  const config = useAppStore((state) => state.config);
  const connectionStatus = useAppStore((state) => state.connectionStatus);
  const updateProxyMode = useAppStore((state) => state.updateProxyMode);
  const isLoading = useAppStore((state) => state.isLoading);
  const startProxy = useAppStore((state) => state.startProxy);
  const stopProxy = useAppStore((state) => state.stopProxy);

  const currentMode = config?.proxyMode || 'smart';

  // Check connection status based on proxy mode type
  const proxyModeType = connectionStatus?.proxyModeType || config?.proxyModeType || 'systemProxy';
  const isTunMode = proxyModeType === 'tun';
  const isManualMode = proxyModeType === 'manual';
  const isConnected =
    isTunMode || isManualMode
      ? connectionStatus?.proxyCore?.running === true // TUN/Manual mode: only check proxy core
      : connectionStatus?.proxyCore?.running && connectionStatus?.proxy?.enabled; // System proxy: check both

  const hasError = connectionStatus?.proxyCore?.error;

  // Check if server is configured and selected
  const isServerConfigured = (() => {
    if (!config?.selectedServerId) return false;

    const selectedServer = config.servers?.find((s) => s.id === config.selectedServerId);
    if (!selectedServer) return false;

    // Basic checks
    if (!selectedServer.address || selectedServer.address.trim() === '') return false;
    if (!selectedServer.port || selectedServer.port <= 0) return false;

    // Protocol-specific checks (case-insensitive)
    const protocol = selectedServer.protocol?.toLowerCase();
    if (protocol === 'vless' || protocol === 'vmess') {
      return !!(selectedServer.uuid && selectedServer.uuid.trim() !== '');
    } else if (protocol === 'trojan' || protocol === 'hysteria2' || protocol === 'anytls') {
      return !!(selectedServer.password && selectedServer.password.trim() !== '');
    } else if (protocol === 'tuic') {
      return !!(
        selectedServer.uuid &&
        selectedServer.uuid.trim() !== '' &&
        selectedServer.password &&
        selectedServer.password.trim() !== ''
      );
    } else if (protocol === 'shadowsocks') {
      return !!(
        selectedServer.shadowsocksSettings?.method &&
        selectedServer.shadowsocksSettings?.method.trim() !== '' &&
        selectedServer.shadowsocksSettings?.password &&
        selectedServer.shadowsocksSettings?.password.trim() !== ''
      );
    } else if (protocol === 'naive') {
      return !!(
        selectedServer.username &&
        selectedServer.username.trim() !== '' &&
        selectedServer.password &&
        selectedServer.password.trim() !== ''
      );
    } else if (protocol === 'socks' || protocol === 'http') {
      // SOCKS and HTTP can just have address and port, username/pass are optional
      return true;
    } else if (protocol === 'snell') {
      return !!(
        selectedServer.snellSettings?.psk && selectedServer.snellSettings?.psk.trim() !== ''
      );
    }

    return false;
  })();

  const handleModeChange = async (value: string) => {
    await updateProxyMode(value as ProxyMode);
  };

  const handleToggleProxy = async () => {
    if (isConnected) {
      await stopProxy();
    } else {
      await startProxy();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('home.proxyMode')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <RadioGroup
          value={currentMode}
          onValueChange={handleModeChange}
          disabled={isLoading}
          className="space-y-3"
        >
          <div className="flex items-center space-x-3">
            <RadioGroupItem value="global" id="mode-global" />
            <Label htmlFor="mode-global" className="cursor-pointer">
              <div>
                <div className="font-medium">{t('home.modeGlobal')}</div>
                <div className="text-xs text-muted-foreground">{t('home.modeGlobalDesc')}</div>
              </div>
            </Label>
          </div>

          <div className="flex items-center space-x-3">
            <RadioGroupItem value="smart" id="mode-smart" />
            <Label htmlFor="mode-smart" className="cursor-pointer">
              <div>
                <div className="font-medium">{t('home.modeSmart')}</div>
                <div className="text-xs text-muted-foreground">{t('home.modeSmartDesc')}</div>
              </div>
            </Label>
          </div>

          <div className="flex items-center space-x-3">
            <RadioGroupItem value="direct" id="mode-direct" />
            <Label htmlFor="mode-direct" className="cursor-pointer">
              <div>
                <div className="font-medium">{t('home.modeDirect')}</div>
                <div className="text-xs text-muted-foreground">{t('home.modeDirectDesc')}</div>
              </div>
            </Label>
          </div>
        </RadioGroup>

        <div className="pt-2 border-t">
          <Button
            onClick={handleToggleProxy}
            disabled={isLoading || !isServerConfigured}
            className="w-full"
            size="lg"
            variant={isConnected ? 'outline' : 'default'}
            title={!isServerConfigured ? t('home.plsConfigServer') : hasError ? hasError : ''}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {isConnected ? t('home.disconnecting') : t('home.connecting')}
              </>
            ) : isConnected ? (
              <>
                <Square className="mr-2 h-4 w-4" />
                {t('home.stopProxy')}
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" />
                {t('home.startProxy')}
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
