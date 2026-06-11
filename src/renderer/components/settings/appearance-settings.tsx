import { Card, CardContent } from '@/components/ui/card';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useTheme } from '@/components/theme-provider';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { useTranslation } from 'react-i18next';
import { api } from '@/ipc';
import { SettingsRow } from './settings-row';

export function AppearanceSettings() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  const handleThemeChange = (value: string) => {
    setTheme(value as 'light' | 'dark' | 'system');
    toast.success(t('settings.appearance.themeUpdated'));
  };

  const handleLanguageChange = (value: string) => {
    i18n.changeLanguage(value);
    localStorage.setItem('app-language', value);
    api.config.setLanguage(value).catch(console.error);
    toast.success(t('settings.appearance.languageUpdated'));
  };

  return (
    <Card>
      <CardContent className="divide-y divide-border/60 pt-2">
        <SettingsRow label={t('settings.appearance.theme')} stacked>
          <SegmentedControl
            className="max-w-xs"
            value={theme}
            onChange={handleThemeChange}
            options={[
              { value: 'light', label: t('settings.appearance.light') },
              { value: 'dark', label: t('settings.appearance.dark') },
              { value: 'system', label: t('settings.appearance.system') },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t('settings.appearance.language')} stacked>
          <SegmentedControl
            className="max-w-xs"
            value={i18n.language}
            onChange={handleLanguageChange}
            options={[
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en-US', label: 'English' },
            ]}
          />
        </SettingsRow>
      </CardContent>
    </Card>
  );
}
