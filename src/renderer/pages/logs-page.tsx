import { RealTimeLogs } from '@/components/logs';
import { useTranslation } from 'react-i18next';

export function LogsPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">{t('logs.pageTitle')}</h2>
        <p className="text-muted-foreground mt-1">{t('logs.pageDesc')}</p>
      </div>

      <RealTimeLogs
        heightClass="h-[calc(100vh-300px)] min-h-[320px]"
        initialLimit={200}
        maxBuffer={500}
      />
    </div>
  );
}
