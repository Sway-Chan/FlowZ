import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store/app-store';
import { openExternal } from '@/bridge/api-wrapper';
import { LOGIN_ITEMS_SETTINGS_URL } from '@/components/home/helper-install-dialog';
import { toast } from 'sonner';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * 提权助手管理卡（仅 macOS）：展示安装/就绪状态，提供安装/修复/卸载入口。
 * 与首页启动提示共享同一安装逻辑（store.installHelper / uninstallHelper）。
 */
export function HelperManagementCard() {
  const { t } = useTranslation();
  const helperStatus = useAppStore((s) => s.helperStatus);
  const refreshHelperStatus = useAppStore((s) => s.refreshHelperStatus);
  const installHelper = useAppStore((s) => s.installHelper);
  const uninstallHelper = useAppStore((s) => s.uninstallHelper);
  const [busy, setBusy] = useState<'install' | 'uninstall' | 'recover' | null>(null);

  useEffect(() => {
    refreshHelperStatus();
  }, [refreshHelperStatus]);

  const handleInstall = async () => {
    setBusy('install');
    try {
      const res = await installHelper();
      if (res.success) toast.success(t('helper.installSuccess'));
      else toast.error(t('helper.installFail'), { description: res.error });
    } finally {
      setBusy(null);
    }
  };

  const handleUninstall = async () => {
    setBusy('uninstall');
    try {
      const res = await uninstallHelper();
      if (res.success) toast.success(t('helper.uninstallSuccess'));
      else toast.error(t('helper.uninstallFail'), { description: res.error });
    } finally {
      setBusy(null);
    }
  };

  /** 「允许在后台」被关：尝试自动恢复 = 重装 helper（授权一次）；失败或装完仍未就绪 → 引导去系统设置。 */
  const handleRecover = async () => {
    setBusy('recover');
    try {
      const res = await installHelper();
      const ready = useAppStore.getState().helperStatus?.ready === true;
      if (res.success && ready) {
        toast.success(t('helper.recoverSuccess'));
      } else {
        toast.error(t('helper.recoverFail'), {
          description: res.error
            ? `${res.error} — ${t('helper.recoverFailGoSettings')}`
            : t('helper.recoverFailGoSettings'),
        });
        await openExternal(LOGIN_ITEMS_SETTINGS_URL);
      }
    } finally {
      setBusy(null);
    }
  };

  // 状态徽章
  const statusBadge = () => {
    if (!helperStatus) return <Badge variant="secondary">{t('helper.statusChecking')}</Badge>;
    if (!helperStatus.installed)
      return <Badge variant="outline">{t('helper.statusNotInstalled')}</Badge>;
    if (helperStatus.backgroundDisabled)
      return (
        <Badge variant="destructive">
          {t('helper.statusBackgroundDisabled', '后台运行被禁用')}
        </Badge>
      );
    if (helperStatus.pathMismatch)
      return (
        <Badge variant="destructive">{t('helper.statusPathMismatch', '应用已移动，需修复')}</Badge>
      );
    if (helperStatus.needsRepair)
      return <Badge variant="destructive">{t('helper.statusNeedsRepair')}</Badge>;
    return <Badge variant="default">{t('helper.statusInstalled')}</Badge>;
  };

  const installed = helperStatus?.installed;
  const needsRepair = helperStatus?.needsRepair;
  const backgroundDisabled = helperStatus?.backgroundDisabled;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          {t('helper.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('helper.desc')}</p>
        {helperStatus?.backgroundDisabled && (
          <p className="text-sm text-destructive">
            {t(
              'helper.backgroundDisabledDesc',
              '系统设置中本应用的「允许在后台」已被关闭，提权助手无法运行，TUN 启停将退回每次弹管理员授权框。请前往系统设置重新开启，或尝试自动恢复（需授权一次）。'
            )}
          </p>
        )}
        {helperStatus?.pathMismatch && !helperStatus?.backgroundDisabled && (
          <p className="text-sm text-destructive">
            {t(
              'helper.pathMismatchDesc',
              '提权助手登记的核心路径与当前应用不一致（应用可能被移动过），TUN 免授权启动将失效，请点击修复。'
            )}
          </p>
        )}

        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t('helper.statusLabel')}</span>
          {statusBadge()}
        </div>

        <div className="flex gap-2 pt-1">
          {!installed && (
            <Button onClick={handleInstall} disabled={busy !== null}>
              {busy === 'install' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('helper.install')}
            </Button>
          )}
          {installed && backgroundDisabled && (
            <>
              <Button
                onClick={() => openExternal(LOGIN_ITEMS_SETTINGS_URL)}
                disabled={busy !== null}
              >
                {t('helper.disabledOpenSettings', '打开系统设置')}
              </Button>
              <Button variant="outline" onClick={handleRecover} disabled={busy !== null}>
                {busy === 'recover' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('helper.disabledTryRecover', '尝试自动恢复（需授权一次）')}
              </Button>
            </>
          )}
          {installed && needsRepair && !backgroundDisabled && (
            <Button onClick={handleInstall} disabled={busy !== null}>
              {busy === 'install' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('helper.repair')}
            </Button>
          )}
          {installed && (
            <Button variant="destructive" onClick={handleUninstall} disabled={busy !== null}>
              {busy === 'uninstall' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('helper.uninstall')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
