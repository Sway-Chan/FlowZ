import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useAppStore } from '@/store/app-store';
import { toast } from 'sonner';
import { api } from '@/ipc';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Input } from '@/components/ui/input';

export function GeneralSettings() {
  const { t } = useTranslation();
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);
  const [passwordValue, setPasswordValue] = useState(config?.privacyPassword || '');

  const handleToggle = async (
    field:
      | 'autoStart'
      | 'silentStart'
      | 'autoConnect'
      | 'minimizeToTray'
      | 'autoCheckUpdate'
      | 'autoLightweightMode'
      | 'rememberWindowSize'
      | 'autoPrivacyMode',
    value: boolean
  ) => {
    if (!config) return;

    try {
      if (field === 'autoStart') {
        await api.autoStart.set(value);
      }

      const updatedConfig = {
        ...config,
        [field]: value,
      };

      await saveConfig(updatedConfig);
      toast.success(t('settings.general.successUpdate'));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : t('settings.general.failUpdate');
      toast.error(errorMessage);
    }
  };

  const handlePasswordSave = async (value: string) => {
    if (!config) return;
    try {
      const updatedConfig = { ...config, privacyPassword: value };
      await saveConfig(updatedConfig);
      toast.success(t('settings.general.successUpdate'));
    } catch {
      toast.error(t('settings.general.failUpdate'));
    }
  };

  if (!config) {
    return null;
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-center space-x-2">
          <Checkbox
            id="silentStart"
            checked={config.silentStart}
            onCheckedChange={(checked) => handleToggle('silentStart', checked as boolean)}
          />
          <Label
            htmlFor="silentStart"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
          >
            {t('settings.general.silentStart')}
          </Label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="autoStart"
            checked={config.autoStart}
            onCheckedChange={(checked) => handleToggle('autoStart', checked as boolean)}
          />
          <Label
            htmlFor="autoStart"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
          >
            {t('settings.general.autoStartTitle')}
          </Label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="autoConnect"
            checked={config.autoConnect}
            onCheckedChange={(checked) => handleToggle('autoConnect', checked as boolean)}
          />
          <Label
            htmlFor="autoConnect"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
          >
            {t('settings.general.autoConnect')}
          </Label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="minimizeToTray"
            checked={config.minimizeToTray}
            onCheckedChange={(checked) => handleToggle('minimizeToTray', checked as boolean)}
          />
          <Label
            htmlFor="minimizeToTray"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
          >
            {t('settings.general.minimizeToTrayTitle')}
          </Label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="autoCheckUpdate"
            checked={config.autoCheckUpdate !== false}
            onCheckedChange={(checked) => handleToggle('autoCheckUpdate', checked as boolean)}
          />
          <Label
            htmlFor="autoCheckUpdate"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
          >
            {t('settings.general.autoCheckUpdate')}
          </Label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="rememberWindowSize"
            checked={config.rememberWindowSize === true}
            onCheckedChange={(checked) => handleToggle('rememberWindowSize', checked as boolean)}
          />
          <Label
            htmlFor="rememberWindowSize"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
          >
            {t('settings.general.rememberWindowSize')}
          </Label>
        </div>

        <div className="flex items-center space-x-2 border-t pt-4 mt-2">
          <Checkbox
            id="autoLightweightMode"
            checked={config.autoLightweightMode}
            onCheckedChange={(checked) => handleToggle('autoLightweightMode', checked as boolean)}
          />
          <Label
            htmlFor="autoLightweightMode"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
          >
            {t('settings.general.autoLightweightMode')}
          </Label>
        </div>

        <div className="flex flex-col space-y-2">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="autoPrivacyMode"
              checked={config.autoPrivacyMode === true}
              onCheckedChange={(checked) => handleToggle('autoPrivacyMode', checked as boolean)}
            />
            <Label
              htmlFor="autoPrivacyMode"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
            >
              {t('settings.general.autoPrivacyMode')}
            </Label>
          </div>

          {config.autoPrivacyMode && (
            <div className="flex items-center space-x-2 pl-6 pt-1 pb-2">
              <Label
                htmlFor="privacyPassword"
                className="text-sm font-medium pr-2 text-muted-foreground whitespace-nowrap"
              >
                {t('settings.general.privacyPassword')}
              </Label>
              <Input
                id="privacyPassword"
                type="password"
                placeholder={t('settings.general.privacyPasswordPlaceholder')}
                value={passwordValue}
                onChange={(e) => setPasswordValue(e.target.value)}
                onBlur={() => handlePasswordSave(passwordValue)}
                className="max-w-[260px] h-8"
              />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
