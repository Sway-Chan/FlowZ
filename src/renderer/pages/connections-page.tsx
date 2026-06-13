import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { EyeOff } from 'lucide-react';
import { ConnectionsTable } from '@/components/connections/connections-table';
import { shouldHideForPrivacy } from '@/components/connections/connection-utils';

/**
 * 连接信息页：复用 main 单一 poller 的连接快照（connectionsApi），逐条展示活动连接 + per-conn 速率差分。
 * 隐私模式屏蔽：连接表含 sourceIP/processPath 敏感信息，isPrivacyMode 激活时不渲染明细（决策）——
 * 既避免敏感数据进 DOM（防御纵深，PrivacyOverlay 之外再设一道），也明示用户该页在隐私态不可用。
 */
export function ConnectionsPage() {
  const { t } = useTranslation();
  const isPrivacyMode = useAppStore((s) => s.isPrivacyMode);
  const hidden = shouldHideForPrivacy(isPrivacyMode);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">{t('connections.pageTitle')}</h2>
        <p className="text-muted-foreground mt-1">{t('connections.pageDesc')}</p>
      </div>

      {hidden ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border bg-muted/40 py-20 text-muted-foreground">
          <EyeOff className="h-10 w-10 opacity-50" />
          <span className="text-sm">{t('connections.privacyHidden')}</span>
        </div>
      ) : (
        <ConnectionsTable />
      )}
    </div>
  );
}
