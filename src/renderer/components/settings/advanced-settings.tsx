import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/store/app-store';
import { parseDnsServerSpec } from '@shared/dns';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { BackupRestoreSection } from './backup-restore-section';

export function AdvancedSettings() {
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);

  const [socksPort, setSocksPort] = useState(config?.socksPort?.toString() || '2081');
  const [httpPort, setHttpPort] = useState(config?.httpPort?.toString() || '2080');
  const [mixedPortEnabled, setMixedPortEnabled] = useState((config?.mixedPort ?? 0) > 0);
  const [mixedPort, setMixedPort] = useState(
    config?.mixedPort && config.mixedPort > 0 ? config.mixedPort.toString() : '7890'
  );
  const [isLoading, setIsLoading] = useState(false);
  const [subInterval, setSubInterval] = useState(
    config?.subscriptionUpdateIntervalHours?.toString() || '12'
  );
  const { t } = useTranslation();

  const handleSavePorts = async () => {
    if (!config) return;

    const socksPortNum = parseInt(socksPort, 10);
    const httpPortNum = parseInt(httpPort, 10);

    // Validate ports
    if (isNaN(socksPortNum) || socksPortNum < 1024 || socksPortNum > 65535) {
      toast.error(t('settings.advanced.socksPortRange'));
      return;
    }

    if (isNaN(httpPortNum) || httpPortNum < 1024 || httpPortNum > 65535) {
      toast.error(t('settings.advanced.httpPortRange'));
      return;
    }

    if (socksPortNum === httpPortNum) {
      toast.error(t('settings.advanced.portsSame'));
      return;
    }

    // Validate mixed port only if enabled
    let mixedPortNum: number | undefined = undefined;
    if (mixedPortEnabled) {
      mixedPortNum = parseInt(mixedPort, 10);
      if (isNaN(mixedPortNum) || mixedPortNum < 1024 || mixedPortNum > 65535) {
        toast.error(t('settings.advanced.mixedPortRange'));
        return;
      }
      if (mixedPortNum === socksPortNum || mixedPortNum === httpPortNum) {
        toast.error(t('settings.advanced.mixedPortConflict'));
        return;
      }
    }

    setIsLoading(true);
    try {
      const updatedConfig = {
        ...config,
        socksPort: socksPortNum,
        httpPort: httpPortNum,
        mixedPort: mixedPortEnabled ? mixedPortNum : 0,
      };
      await saveConfig(updatedConfig);
      toast.success(t('settings.advanced.portsSaved'));
    } catch {
      toast.error(t('settings.advanced.portsSaveFail'));
    } finally {
      setIsLoading(false);
    }
  };

  if (!config) {
    return null;
  }

  return (
    <Card>
      <CardContent className="space-y-6 pt-6">
        {/* DNS 设置区域 */}
        <div className="space-y-4">
          <h4 className="text-sm font-medium mb-2">{t('settings.advanced.dnsSettings')}</h4>

          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="domesticDns">{t('settings.advanced.domesticDns')}</Label>
              <Input
                id="domesticDns"
                value={config.dnsConfig?.domesticDns || 'https://doh.pub/dns-query'}
                onChange={(e) => {
                  const updatedConfig = { ...config };
                  if (!updatedConfig.dnsConfig) {
                    updatedConfig.dnsConfig = {
                      domesticDns: '',
                      foreignDns: '',
                      enableFakeIp: false,
                    };
                  }
                  updatedConfig.dnsConfig.domesticDns = e.target.value;
                  saveConfig(updatedConfig);
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && !parseDnsServerSpec(v)) toast.error(t('settings.advanced.dnsInvalid'));
                }}
                className="max-w-md"
                placeholder={t('settings.advanced.domesticDnsPlaceholder')}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.advanced.domesticDnsDesc')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="foreignDns">{t('settings.advanced.foreignDns')}</Label>
              <Input
                id="foreignDns"
                value={config.dnsConfig?.foreignDns || 'https://dns.google/dns-query'}
                onChange={(e) => {
                  const updatedConfig = { ...config };
                  if (!updatedConfig.dnsConfig) {
                    updatedConfig.dnsConfig = {
                      domesticDns: '',
                      foreignDns: '',
                      enableFakeIp: false,
                    };
                  }
                  updatedConfig.dnsConfig.foreignDns = e.target.value;
                  saveConfig(updatedConfig);
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && !parseDnsServerSpec(v)) toast.error(t('settings.advanced.dnsInvalid'));
                }}
                className="max-w-md"
                placeholder={t('settings.advanced.foreignDnsPlaceholder')}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.advanced.foreignDnsDesc')}
              </p>
            </div>

            <div className="flex items-center space-x-2 pt-2">
              <input
                type="checkbox"
                id="enableFakeIp"
                className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                checked={config.dnsConfig?.enableFakeIp || false}
                onChange={(e) => {
                  const updatedConfig = { ...config };
                  if (!updatedConfig.dnsConfig) {
                    updatedConfig.dnsConfig = {
                      domesticDns: 'https://doh.pub/dns-query',
                      foreignDns: 'https://dns.google/dns-query',
                      enableFakeIp: false,
                    };
                  }
                  updatedConfig.dnsConfig.enableFakeIp = e.target.checked;
                  saveConfig(updatedConfig);
                }}
              />
              <Label htmlFor="enableFakeIp" className="font-normal">
                {t('settings.advanced.enableFakeIp')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground ml-6 mb-2">
              {t('settings.advanced.fakeIpDesc')}
            </p>

            <div className="flex items-center space-x-2 pt-3 border-t">
              <Checkbox
                id="enableIPv6"
                checked={config.enableIPv6 === true}
                onCheckedChange={(checked) => {
                  const updatedConfig = { ...config, enableIPv6: checked as boolean };
                  saveConfig(updatedConfig);
                }}
              />
              <Label
                htmlFor="enableIPv6"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer text-orange-500"
              >
                {t('settings.general.enableIPv6')}
              </Label>
            </div>
          </div>
        </div>

        {/* 端口设置区域 */}
        <div className="space-y-4 pt-4 border-t">
          <h4 className="text-sm font-medium mb-2">{t('settings.advanced.portSettings')}</h4>
          <div className="space-y-2">
            <Label htmlFor="socksPort">{t('settings.advanced.socksPort')}</Label>
            <div className="flex gap-2">
              <Input
                id="socksPort"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={socksPort}
                onChange={(e) => setSocksPort(e.target.value.replace(/[^0-9]/g, ''))}
                className="max-w-[200px]"
              />
            </div>
            <p className="text-xs text-muted-foreground">{t('settings.advanced.default')}: 2081</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="httpPort">{t('settings.advanced.httpPort')}</Label>
            <div className="flex gap-2">
              <Input
                id="httpPort"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={httpPort}
                onChange={(e) => setHttpPort(e.target.value.replace(/[^0-9]/g, ''))}
                className="max-w-[200px]"
              />
            </div>
            <p className="text-xs text-muted-foreground">{t('settings.advanced.default')}: 2080</p>
          </div>

          {/* Mixed Port (Optional) */}
          <div className="space-y-3 pt-2 border-t border-dashed">
            <div className="flex items-center gap-2">
              <Checkbox
                id="mixedPortEnabled"
                checked={mixedPortEnabled}
                onCheckedChange={(checked) => setMixedPortEnabled(checked as boolean)}
              />
              <Label htmlFor="mixedPortEnabled" className="cursor-pointer">
                {t('settings.advanced.mixedPort')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground ml-6">
              {t('settings.advanced.mixedPortDesc')}
            </p>
            {mixedPortEnabled && (
              <div className="ml-6 space-y-2">
                <Input
                  id="mixedPort"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={mixedPort}
                  onChange={(e) => setMixedPort(e.target.value.replace(/[^0-9]/g, ''))}
                  className="max-w-[200px]"
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.advanced.default')}: 7890
                </p>
              </div>
            )}
          </div>

          <Button onClick={handleSavePorts} disabled={isLoading}>
            {isLoading ? t('settings.advanced.saving') : t('settings.advanced.savePortSettings')}
          </Button>
        </div>

        {/* 局域网设置区域 */}
        <div className="space-y-4 pt-4 border-t">
          <h4 className="text-sm font-medium mb-2">{t('settings.advanced.lanSettings')}</h4>
          <div className="space-y-3">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="allowLan"
                checked={config.allowLan === true}
                onCheckedChange={(checked) => {
                  const updatedConfig = { ...config, allowLan: checked as boolean };
                  saveConfig(updatedConfig);
                }}
              />
              <Label htmlFor="allowLan" className="font-normal cursor-pointer">
                {t('settings.advanced.allowLan')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground ml-6 mb-2">
              {t('settings.advanced.allowLanDesc')}
            </p>
            {config.allowLan && (
              <p className="text-xs text-orange-500 font-medium ml-6 mb-2">
                {t('settings.advanced.allowLanGatewayTip')}
              </p>
            )}

            <div className="flex items-center space-x-2 pt-2">
              <Checkbox
                id="bypassLAN"
                checked={config.bypassLAN !== false} // 默认为 true
                onCheckedChange={(checked) => {
                  const updatedConfig = { ...config, bypassLAN: checked as boolean };
                  saveConfig(updatedConfig);
                }}
              />
              <Label htmlFor="bypassLAN" className="font-normal cursor-pointer">
                {t('settings.advanced.bypassLAN')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground ml-6 mb-2">
              {t('settings.advanced.bypassLANDesc')}
            </p>

            <div className="flex items-center space-x-2 pt-2">
              <Checkbox
                id="blockQuic"
                checked={config.blockQuic === true}
                onCheckedChange={(checked) => {
                  const updatedConfig = { ...config, blockQuic: checked as boolean };
                  saveConfig(updatedConfig);
                }}
              />
              <Label htmlFor="blockQuic" className="font-normal cursor-pointer">
                {t('settings.advanced.blockQuic')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground ml-6 mb-2">
              {t('settings.advanced.blockQuicDesc')}
            </p>

            <div className="flex items-center space-x-2 pt-2">
              <Checkbox
                id="interruptOnSwitch"
                checked={config.interruptConnectionsOnSwitch === true}
                onCheckedChange={(checked) => {
                  const updatedConfig = {
                    ...config,
                    interruptConnectionsOnSwitch: checked as boolean,
                  };
                  saveConfig(updatedConfig);
                }}
              />
              <Label htmlFor="interruptOnSwitch" className="font-normal cursor-pointer">
                {t('settings.advanced.interruptOnSwitch')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground ml-6 mb-2">
              {t('settings.advanced.interruptOnSwitchDesc')}
            </p>

            <div className="flex items-center space-x-2 pt-2">
              <Checkbox
                id="tlsFragment"
                checked={config.tlsFragment === true}
                onCheckedChange={(checked) => {
                  const updatedConfig = { ...config, tlsFragment: checked as boolean };
                  saveConfig(updatedConfig);
                }}
              />
              <Label htmlFor="tlsFragment" className="font-normal cursor-pointer">
                {t('settings.advanced.tlsFragment')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground ml-6 mb-2">
              {t('settings.advanced.tlsFragmentDesc')}
            </p>

            {/* 日志级别 */}
            <div className="space-y-1.5 pt-2">
              <Label className="font-normal">{t('settings.advanced.logLevel')}</Label>
              <Select
                value={config.logLevel || 'info'}
                onValueChange={(v) =>
                  saveConfig({ ...config, logLevel: v as typeof config.logLevel })
                }
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="debug">debug</SelectItem>
                  <SelectItem value="info">info</SelectItem>
                  <SelectItem value="warn">warn</SelectItem>
                  <SelectItem value="error">error</SelectItem>
                  <SelectItem value="fatal">fatal</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('settings.advanced.logLevelDesc')}</p>
            </div>

            {/* 关闭日志写盘 */}
            <div className="flex items-center space-x-2 pt-2">
              <Checkbox
                id="disableLogFile"
                checked={config.disableLogFile === true}
                onCheckedChange={(checked) => {
                  saveConfig({ ...config, disableLogFile: checked as boolean });
                }}
              />
              <Label htmlFor="disableLogFile" className="font-normal cursor-pointer">
                {t('settings.advanced.disableLogFile')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground ml-6 mb-2">
              {t('settings.advanced.disableLogFileDesc')}
            </p>

            {/* 自动换节点 */}
            <div className="flex items-center space-x-2 pt-2">
              <Checkbox
                id="autoSwitchNode"
                checked={config.autoSwitchNode === true}
                onCheckedChange={(checked) => {
                  saveConfig({ ...config, autoSwitchNode: checked as boolean });
                }}
              />
              <Label htmlFor="autoSwitchNode" className="font-normal cursor-pointer">
                {t('settings.advanced.autoSwitchNode' as any) || '节点故障自动切换'}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground ml-6 mb-2">
              {t('settings.advanced.autoSwitchNodeDesc' as any) ||
                '当前节点断线或崩溃时，自动测速并切换到延迟最低的可用节点（每次切换冷却 60 秒）'}
            </p>

            {/* 核心更新：仅在兼容版本带内自动更新 */}
            <div className="flex items-center space-x-2 pt-2">
              <Checkbox
                id="restrictCoreUpdate"
                checked={config.restrictCoreUpdateToCompatibleMinor !== false}
                onCheckedChange={(checked) => {
                  saveConfig({
                    ...config,
                    restrictCoreUpdateToCompatibleMinor: checked as boolean,
                  });
                }}
              />
              <Label htmlFor="restrictCoreUpdate" className="font-normal cursor-pointer">
                {t('settings.advanced.restrictCoreUpdate' as any) || '仅在兼容版本带内自动更新内核'}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground ml-6 mb-2">
              {t('settings.advanced.restrictCoreUpdateDesc' as any) ||
                '仅自动更新到与当前配置生成器兼容的 sing-box 版本带（如 1.13.x）；跨版本带（如 1.14）不自动更新、转为提示随 App 升级，避免配置不兼容。手动更新不受此限制。'}
            </p>
          </div>
        </div>

        {/* 订阅自动更新 */}
        <div className="space-y-4 pt-4 border-t">
          <h4 className="text-sm font-medium mb-2">{t('settings.advanced.subAutoUpdate')}</h4>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="autoUpdateSub"
              checked={config.autoUpdateSubscriptionOnStart === true}
              onCheckedChange={(checked) =>
                saveConfig({ ...config, autoUpdateSubscriptionOnStart: checked as boolean })
              }
            />
            <Label htmlFor="autoUpdateSub" className="font-normal cursor-pointer">
              {t('settings.advanced.autoUpdateSub')}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground ml-6">
            {t('settings.advanced.autoUpdateSubDesc')}
          </p>

          {config.autoUpdateSubscriptionOnStart && (
            <div className="ml-6 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="subInterval" className="font-normal">
                  {t('settings.advanced.subUpdateInterval')}
                </Label>
                <Input
                  id="subInterval"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={subInterval}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^0-9]/g, '');
                    setSubInterval(v);
                    const n = parseInt(v, 10);
                    if (!isNaN(n) && n >= 1 && n <= 168) {
                      saveConfig({ ...config, subscriptionUpdateIntervalHours: n });
                    }
                  }}
                  className="max-w-[120px]"
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.advanced.subUpdateIntervalDesc')}
                </p>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="subViaProxy"
                  checked={config.subscriptionUpdateViaProxy === true}
                  onCheckedChange={(checked) =>
                    saveConfig({ ...config, subscriptionUpdateViaProxy: checked as boolean })
                  }
                />
                <Label htmlFor="subViaProxy" className="font-normal cursor-pointer">
                  {t('settings.advanced.subUpdateViaProxy')}
                </Label>
              </div>
              <p className="text-xs text-muted-foreground ml-6">
                {t('settings.advanced.subUpdateViaProxyDesc')}
              </p>
            </div>
          )}
        </div>

        <div className="space-y-4 pt-4 border-t">
          <div>
            <h4 className="text-sm font-medium mb-2">{t('settings.advanced.terminalProxy')}</h4>
            <p className="text-xs text-muted-foreground mb-3">
              {t('settings.advanced.terminalProxyDesc')}
            </p>

            <div className="space-y-3">
              <div>
                <Label className="text-xs font-medium text-muted-foreground">Windows (CMD)</Label>
                <div className="mt-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 text-xs bg-muted rounded font-mono">
                      set http_proxy=http://127.0.0.1:{httpPort}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `set http_proxy=http://127.0.0.1:${httpPort}`
                        );
                        toast.success(t('settings.advanced.copied'));
                      }}
                    >
                      {t('settings.advanced.copy')}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 text-xs bg-muted rounded font-mono">
                      set https_proxy=http://127.0.0.1:{httpPort}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `set https_proxy=http://127.0.0.1:${httpPort}`
                        );
                        toast.success(t('settings.advanced.copied'));
                      }}
                    >
                      {t('settings.advanced.copy')}
                    </Button>
                  </div>
                </div>
              </div>

              <div>
                <Label className="text-xs font-medium text-muted-foreground">
                  Windows (PowerShell)
                </Label>
                <div className="mt-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 text-xs bg-muted rounded font-mono">
                      $env:http_proxy="http://127.0.0.1:{httpPort}"
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `$env:http_proxy="http://127.0.0.1:${httpPort}"`
                        );
                        toast.success(t('settings.advanced.copied'));
                      }}
                    >
                      {t('settings.advanced.copy')}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 text-xs bg-muted rounded font-mono">
                      $env:https_proxy="http://127.0.0.1:{httpPort}"
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `$env:https_proxy="http://127.0.0.1:${httpPort}"`
                        );
                        toast.success(t('settings.advanced.copied'));
                      }}
                    >
                      {t('settings.advanced.copy')}
                    </Button>
                  </div>
                </div>
              </div>

              <div>
                <Label className="text-xs font-medium text-muted-foreground">
                  Linux/macOS (Bash/Zsh)
                </Label>
                <div className="mt-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 text-xs bg-muted rounded font-mono">
                      export http_proxy=http://127.0.0.1:{httpPort}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `export http_proxy=http://127.0.0.1:${httpPort}`
                        );
                        toast.success(t('settings.advanced.copied'));
                      }}
                    >
                      {t('settings.advanced.copy')}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 text-xs bg-muted rounded font-mono">
                      export https_proxy=http://127.0.0.1:{httpPort}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `export https_proxy=http://127.0.0.1:${httpPort}`
                        );
                        toast.success(t('settings.advanced.copied'));
                      }}
                    >
                      {t('settings.advanced.copy')}
                    </Button>
                  </div>
                </div>
              </div>

              <div>
                <Label className="text-xs font-medium text-muted-foreground">
                  {t('settings.advanced.gitProxy')}
                </Label>
                <div className="mt-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 text-xs bg-muted rounded font-mono">
                      git config --global http.proxy http://127.0.0.1:{httpPort}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `git config --global http.proxy http://127.0.0.1:${httpPort}`
                        );
                        toast.success(t('settings.advanced.copied'));
                      }}
                    >
                      {t('settings.advanced.copy')}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 text-xs bg-muted rounded font-mono">
                      git config --global https.proxy http://127.0.0.1:{httpPort}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `git config --global https.proxy http://127.0.0.1:${httpPort}`
                        );
                        toast.success(t('settings.advanced.copied'));
                      }}
                    >
                      {t('settings.advanced.copy')}
                    </Button>
                  </div>
                </div>
              </div>

              <div>
                <Label className="text-xs font-medium text-muted-foreground">
                  {t('settings.advanced.npmProxy')}
                </Label>
                <div className="mt-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 text-xs bg-muted rounded font-mono">
                      npm config set proxy http://127.0.0.1:{httpPort}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `npm config set proxy http://127.0.0.1:${httpPort}`
                        );
                        toast.success(t('settings.advanced.copied'));
                      }}
                    >
                      {t('settings.advanced.copy')}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 text-xs bg-muted rounded font-mono">
                      npm config set https-proxy http://127.0.0.1:{httpPort}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `npm config set https-proxy http://127.0.0.1:${httpPort}`
                        );
                        toast.success(t('settings.advanced.copied'));
                      }}
                    >
                      {t('settings.advanced.copy')}
                    </Button>
                  </div>
                </div>
              </div>

              <div>
                <Label className="text-xs font-medium text-muted-foreground">
                  {t('settings.advanced.socks5Proxy')}
                </Label>
                <div className="mt-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 text-xs bg-muted rounded font-mono">
                      set ALL_PROXY=socks5://127.0.0.1:{socksPort}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `set ALL_PROXY=socks5://127.0.0.1:${socksPort}`
                        );
                        toast.success(t('settings.advanced.copied'));
                      }}
                    >
                      {t('settings.advanced.copy')}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 text-xs bg-muted rounded font-mono">
                      $env:ALL_PROXY="socks5://127.0.0.1:{socksPort}"
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `$env:ALL_PROXY="socks5://127.0.0.1:${socksPort}"`
                        );
                        toast.success(t('settings.advanced.copied'));
                      }}
                    >
                      {t('settings.advanced.copy')}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 text-xs bg-muted rounded font-mono">
                      export ALL_PROXY=socks5://127.0.0.1:{socksPort}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `export ALL_PROXY=socks5://127.0.0.1:${socksPort}`
                        );
                        toast.success(t('settings.advanced.copied'));
                      }}
                    >
                      {t('settings.advanced.copy')}
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 p-3 bg-muted/50 rounded-lg">
              <p className="text-xs text-muted-foreground">
                <strong>{t('settings.advanced.tip')}</strong>
              </p>
              <ul className="text-xs text-muted-foreground mt-1 space-y-1">
                <li>• {t('settings.advanced.tipSessionOnly')}</li>
                <li>• {t('settings.advanced.tipPermanent')}</li>
                <li>• {t('settings.advanced.tipHttpPort', { port: httpPort })}</li>
                <li>• {t('settings.advanced.tipSocksPort', { port: socksPort })}</li>
                <li>• {t('settings.advanced.tipDisable')}</li>
              </ul>
            </div>
          </div>
        </div>

        {/* 数据备份与恢复 */}
        <BackupRestoreSection />
      </CardContent>
    </Card>
  );
}
