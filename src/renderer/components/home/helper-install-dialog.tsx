import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store/app-store';
import { openExternal } from '@/bridge/api-wrapper';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** macOS「系统设置 → 通用 → 登录项与扩展」深链（「允许在后台」开关所在面板）。 */
export const LOGIN_ITEMS_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';

interface HelperInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 'install'（默认，未安装时劝装）/ 'repair'（已装但烧录路径不符，劝重烧路径）
   * / 'reenable'（已装但被系统「允许在后台」关闭，引导去系统设置或一键尝试恢复）
   */
  variant?: 'install' | 'repair' | 'reenable';
  /**
   * preStart 门语境：由「开启代理」触发。安装/修复/恢复成功后续接启动（onProceed），
   * 按钮文案变「…并连接」+「跳过本次用系统授权」，隐藏「不再提示」（不在启动时机劝退）。
   */
  gateMode?: boolean;
  /** gateMode 下「…并连接」成功 或「跳过本次」时调用，续接 startProxy（装好走 helper 零提权 / 跳过走 osascript）。 */
  onProceed?: () => void;
}

/**
 * 提权 helper 安装/修复/恢复提示。
 * install：立即安装 / 稍后 / 不再提示（持久化 helperPromptDismissed）。
 * repair：立即修复（install() 重烧当前路径，弹一次密码框）/ 稍后（不写 dismissed——修复不能被永久吞掉）。
 * reenable：打开系统设置（深链登录项面板）/ 尝试自动恢复（重装 helper，授权一次；BTM 拦截下可能失败 →
 *           失败 toast 并自动带去系统设置，不在「再修复」里打转）/ 稍后 / 不再提示（持久化
 *           helperDisabledPromptDismissed；设置页 helper 卡保留常驻入口）。
 */
export function HelperInstallDialog({
  open,
  onOpenChange,
  variant = 'install',
  gateMode = false,
  onProceed,
}: HelperInstallDialogProps) {
  const { t } = useTranslation();
  const installHelper = useAppStore((s) => s.installHelper);
  const setConfigValue = useAppStore((s) => s.setConfigValue);
  const [installing, setInstalling] = useState(false);
  const isRepair = variant === 'repair';
  const isReenable = variant === 'reenable';

  // gateMode：关窗并续接启动（osascript 回落路径，或安装成功后的零提权路径）
  const proceed = () => {
    onOpenChange(false);
    onProceed?.();
  };

  const handleInstall = async () => {
    setInstalling(true);
    try {
      const res = await installHelper();
      if (res.success) {
        toast.success(t(isRepair ? 'helper.repairSuccess' : 'helper.installSuccess'));
        onOpenChange(false);
        // 装好→续接启动：startSingBoxProcess 重判 isReady 走 helper 零提权，无需主进程改动
        if (gateMode) onProceed?.();
      } else {
        toast.error(t(isRepair ? 'helper.repairFail' : 'helper.installFail'), {
          description: res.error,
        });
      }
    } finally {
      setInstalling(false);
    }
  };

  /** reenable：一键尝试恢复 = 重装 helper（授权一次）。失败或装完仍未就绪（BTM 仍拦）→ 导向系统设置深链。 */
  const handleRecover = async () => {
    setInstalling(true);
    try {
      const res = await installHelper();
      const ready = useAppStore.getState().helperStatus?.ready === true;
      if (res.success && ready) {
        toast.success(t('helper.recoverSuccess'));
        onOpenChange(false);
        if (gateMode) onProceed?.();
      } else {
        toast.error(t('helper.recoverFail'), {
          description: res.error
            ? `${res.error} — ${t('helper.recoverFailGoSettings')}`
            : t('helper.recoverFailGoSettings'),
        });
        await openExternal(LOGIN_ITEMS_SETTINGS_URL);
      }
    } finally {
      setInstalling(false);
    }
  };

  const handleOpenSettings = async () => {
    await openExternal(LOGIN_ITEMS_SETTINGS_URL);
    onOpenChange(false);
  };

  const handleDismiss = async () => {
    await setConfigValue(
      isReenable ? 'helperDisabledPromptDismissed' : 'helperPromptDismissed',
      true
    );
    onOpenChange(false);
  };

  const title = isReenable
    ? t('helper.disabledPromptTitle', '代理后台守护已被系统关闭')
    : isRepair
      ? t('helper.repairPromptTitle', '修复提权助手？')
      : t('helper.promptTitle');
  const description = isReenable
    ? t(
        'helper.disabledPromptDesc',
        '系统设置「登录项与扩展」中本应用的「允许在后台」已被关闭，提权助手无法运行，启停代理将退回每次弹管理员授权框。可前往系统设置重新开启，或尝试自动恢复（需授权一次）。'
      )
    : isRepair
      ? t(
          'helper.repairPromptDesc',
          '检测到应用位置已变更（例如移入「应用程序」文件夹），提权助手仍指向旧路径。立即修复将重新登记新路径，仅需授权一次。'
        )
      : t('helper.promptDesc');

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onEscapeKeyDown={(e) => {
          // 安装/恢复进行中禁 Esc 关窗：否则父级重置 helperGateMode，但本闭包 gateMode 仍为 true →
          // 安装成功后仍 onProceed() 自动启动，与「关窗即退出 start 门」语义矛盾
          if (installing) e.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:gap-2">
          {gateMode ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={installing}>
                {t('common.cancel')}
              </Button>
              <Button variant="outline" onClick={proceed} disabled={installing}>
                {t('helper.gateSkip', '跳过，本次用系统授权')}
              </Button>
              {isReenable && (
                <Button variant="outline" onClick={handleOpenSettings} disabled={installing}>
                  {t('helper.disabledOpenSettings', '打开系统设置')}
                </Button>
              )}
              <Button onClick={isReenable ? handleRecover : handleInstall} disabled={installing}>
                {installing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isReenable
                  ? t('helper.gateRecoverConnect', '恢复并连接')
                  : isRepair
                    ? t('helper.gateRepairConnect', '修复并连接')
                    : t('helper.gateInstallConnect', '安装并连接')}
              </Button>
            </>
          ) : (
            <>
              {!isRepair && (
                <Button variant="ghost" onClick={handleDismiss} disabled={installing}>
                  {t('helper.promptDismiss')}
                </Button>
              )}
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={installing}>
                {t('helper.promptLater')}
              </Button>
              {isReenable ? (
                <>
                  <Button variant="outline" onClick={handleRecover} disabled={installing}>
                    {installing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('helper.disabledTryRecover', '尝试自动恢复（需授权一次）')}
                  </Button>
                  <Button onClick={handleOpenSettings} disabled={installing}>
                    {t('helper.disabledOpenSettings', '打开系统设置')}
                  </Button>
                </>
              ) : (
                <Button onClick={handleInstall} disabled={installing}>
                  {installing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {isRepair
                    ? t('helper.repairPromptConfirm', '立即修复')
                    : t('helper.promptInstall')}
                </Button>
              )}
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
