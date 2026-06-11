import { ConnectionStatusCard } from '@/components/home/connection-status-card';
import { ProxyControlCard } from '@/components/home/proxy-control-card';
import { NetworkInfoCard } from '@/components/home/network-info-card';
import { ConnectionTopology } from '@/components/home/connection-topology';
import { useTranslation } from 'react-i18next';

export function HomePage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">{t('home.pageTitle')}</h2>
        <p className="text-muted-foreground mt-1">{t('home.pageDesc')}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ConnectionStatusCard />
        <ProxyControlCard />
      </div>

      <NetworkInfoCard />

      <ConnectionTopology />
    </div>
  );
}
