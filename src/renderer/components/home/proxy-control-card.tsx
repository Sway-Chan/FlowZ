import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { HelperInstallDialog } from './helper-install-dialog';
import { useAppStore } from '@/store/app-store';
import { Loader2, Play, Square } from 'lucide-react';
import type { ProxyMode, ProxyModeType } from '@/bridge/types';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

const isMac = window.electron?.platform === 'darwin';

// 会话级提示去重（非组件级）：HomePage 在 App.tsx 条件挂载，home↔settings 往返会卸载组件 → 组件级 ref 归零、
// 重复弹窗。模块级变量在整个 app 会话内持久，真正实现「每会话最多一次」。
// install 引导已移至 start 门（handleToggleProxy），不再有切模式/启动被动弹窗；仅 repair/reenable 保留早发现。
let repairPrompted = false;
let reenablePrompted = false;

/**
 * 首页代理控制卡：两行 OpenClash 风格分段切换（接管方式 / 分流策略）+ 启停按钮。
 * 接管方式（systemProxy/tun/manual）从设置页迁移至此；TUN 下 helper 未就绪由「开启代理」start 门引导（仅 macOS）。
 */
export function ProxyControlCard() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const proxyBusy = useAppStore((s) => s.proxyBusy);
  const proxyPhase = useAppStore((s) => s.proxyPhase);
  const updateProxyMode = useAppStore((s) => s.updateProxyMode);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const startProxy = useAppStore((s) => s.startProxy);
  const stopProxy = useAppStore((s) => s.stopProxy);
  const helperStatus = useAppStore((s) => s.helperStatus);
  const refreshHelperStatus = useAppStore((s) => s.refreshHelperStatus);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingModeType, setPendingModeType] = useState<ProxyModeType | null>(null);
  const [helperDialogOpen, setHelperDialogOpen] = useState(false);
  const [helperDialogVariant, setHelperDialogVariant] = useState<'install' | 'repair' | 'reenable'>(
    'install'
  );
  // start 门语境：「开启代理」触发的 helper 引导（成功安装后续接启动；区别于切模式/启动时的被动教育弹窗）
  const [helperGateMode, setHelperGateMode] = useState(false);
  // F2：updateProxyMode 不再写全局 busy → 用本地 routingBusy 提供分流切换进行中反馈
  const [routingBusy, setRoutingBusy] = useState(false);
  // 提示去重标记已提升为模块级 repairPrompted/reenablePrompted（见文件顶部，真正会话级）

  // 挂载时拉一次 helper 状态（仅 macOS 有意义）
  useEffect(() => {
    if (isMac) refreshHelperStatus();
  }, [refreshHelperStatus]);

  // config 是接管方式的持久化真值（用户设置）；优先它，避免启动时 connectionStatus 尚未刷新而默认 systemProxy 盖掉已存的 tun。
  const proxyModeType = config?.proxyModeType || connectionStatus?.proxyModeType || 'systemProxy';
  const isTunMode = proxyModeType === 'tun';
  const isManualMode = proxyModeType === 'manual';
  const isConnected =
    isTunMode || isManualMode
      ? connectionStatus?.proxyCore?.running === true
      : connectionStatus?.proxyCore?.running && connectionStatus?.proxy?.enabled;
  const hasError = connectionStatus?.proxyCore?.error;

  // 仅 macOS + TUN + helper 已装但烧录路径不符（app 被移动过）→ 提示修复（每会话一次，不可被「不再提示」吞）
  // backgroundDisabled 时不提修复：daemon 被系统禁止运行，「修复」(=install) 大概率被 BTM 拦截，先走 reenable
  const shouldPromptRepair = (modeType: ProxyModeType): boolean =>
    isMac &&
    modeType === 'tun' &&
    !!helperStatus &&
    helperStatus.installed &&
    helperStatus.pathMismatch &&
    !helperStatus.backgroundDisabled;

  // 仅 macOS + TUN + helper 已装但被系统「允许在后台」关闭（去抖后）+ 用户未忽略 → 引导重新启用（每会话一次）
  const shouldPromptReenable = (modeType: ProxyModeType): boolean =>
    isMac &&
    modeType === 'tun' &&
    !!helperStatus &&
    helperStatus.installed &&
    helperStatus.backgroundDisabled &&
    !config?.helperDisabledPromptDismissed;

  // 已装用户的异常态早发现（reenable > repair）；install 引导改由 start 门承接，不在此被动弹。
  useEffect(() => {
    if (!config) return;
    // 优先级 reenable > repair：被系统禁用时「修复」必然失败，先引导解禁
    if (!reenablePrompted && shouldPromptReenable(config.proxyModeType)) {
      reenablePrompted = true;
      setHelperDialogVariant('reenable');
      setHelperDialogOpen(true);
      return;
    }
    if (!repairPrompted && shouldPromptRepair(config.proxyModeType)) {
      repairPrompted = true;
      setHelperDialogVariant('repair');
      setHelperDialogOpen(true);
    }
  }, [helperStatus, config?.proxyModeType]);

  const isServerConfigured = (() => {
    if (!config?.selectedServerId) return false;
    const s = config.servers?.find((x) => x.id === config.selectedServerId);
    if (!s) return false;
    if (!s.address || s.address.trim() === '') return false;
    if (!s.port || s.port <= 0) return false;
    const protocol = s.protocol?.toLowerCase();
    if (protocol === 'vless' || protocol === 'vmess') return !!s.uuid?.trim();
    if (protocol === 'trojan' || protocol === 'hysteria2' || protocol === 'anytls')
      return !!s.password?.trim();
    if (protocol === 'tuic') return !!s.uuid?.trim() && !!s.password?.trim();
    if (protocol === 'shadowsocks')
      return !!s.shadowsocksSettings?.method?.trim() && !!s.shadowsocksSettings?.password?.trim();
    if (protocol === 'naive') return !!s.username?.trim() && !!s.password?.trim();
    if (protocol === 'socks' || protocol === 'http' || protocol === 'ssh') return true;
    return false;
  })();

  // ── 接管方式（proxyModeType）────────────────────────────────────────────
  const applyTakeover = async (modeType: ProxyModeType) => {
    if (!config) return;
    try {
      await saveConfig({ ...config, proxyModeType: modeType });
      toast.success(t('settings.proxyMode.successUpdate'), {
        description: isConnected ? t('settings.proxyMode.reconnectToast') : undefined,
      });
      if (!reenablePrompted && shouldPromptReenable(modeType)) {
        reenablePrompted = true;
        setHelperDialogVariant('reenable');
        setHelperDialogOpen(true);
      } else if (!repairPrompted && shouldPromptRepair(modeType)) {
        repairPrompted = true;
        setHelperDialogVariant('repair');
        setHelperDialogOpen(true);
      }
    } catch {
      toast.error(t('settings.proxyMode.failUpdate'));
    }
  };

  const handleTakeoverChange = (next: ProxyModeType) => {
    if (next === config?.proxyModeType) return;
    if (isConnected) {
      setPendingModeType(next);
      setConfirmOpen(true);
    } else {
      applyTakeover(next);
    }
  };

  const confirmTakeover = () => {
    if (pendingModeType) applyTakeover(pendingModeType);
    setPendingModeType(null);
    setConfirmOpen(false);
  };

  // ── 分流策略（proxyMode）────────────────────────────────────────────────
  const handleRoutingChange = async (next: ProxyMode) => {
    setRoutingBusy(true);
    try {
      await updateProxyMode(next);
    } catch {
      toast.error(t('common.saveFailed'));
    } finally {
      setRoutingBusy(false);
    }
  };

  const handleToggleProxy = async () => {
    if (isConnected) {
      await stopProxy();
      return;
    }
    // 非 macOS / 非 TUN：无需提权 helper，直接启动（行为与时延完全不变）
    if (!isMac || !isTunMode) {
      await startProxy();
      return;
    }
    // macOS + TUN：start 门——拉新鲜 helper 状态，未就绪先引导（安装/修复/解禁）；装好续接启动走 helper
    // 零提权，「跳过本次/装失败」才回落 osascript（主进程 startSingBoxProcess 每次重判 isReady + osascript 兜底）。
    await refreshHelperStatus();
    const st = useAppStore.getState().helperStatus;
    let variant: 'install' | 'repair' | 'reenable' | null = null;
    if (st) {
      if (st.backgroundDisabled) variant = 'reenable';
      else if (st.needsRepair) variant = 'repair';
      else if (!st.installed) variant = 'install';
    }
    if (!variant) {
      // helper 就绪（或状态未知）→ 直接启动：helper 零提权；状态未知时由主进程兜底
      await startProxy();
      return;
    }
    // repair 不可 dismiss；install/reenable 尊重用户「不再提示」→ 降级为非阻断 toast，不弹模态
    const dismissed =
      variant === 'reenable'
        ? !!config?.helperDisabledPromptDismissed
        : variant === 'install'
          ? !!config?.helperPromptDismissed
          : false;
    if (!dismissed) {
      setHelperDialogVariant(variant);
      setHelperGateMode(true);
      setHelperDialogOpen(true);
      return;
    }
    // reenable 场景 helper 已安装、仅被系统禁后台，文案不能说「安装」
    const fallbackMsg =
      variant === 'reenable'
        ? t(
            'home.helperGateReenableToast',
            '将使用系统授权启动；可在设置中重新启用后台运行以免每次授权'
          )
        : t(
            'home.helperGateFallbackToast',
            '将使用系统授权启动；可在设置中安装提权助手以免每次授权'
          );
    toast.info(fallbackMsg, {
      action: {
        label: t('home.helperGateGoSettings', '去设置'),
        onClick: () => {
          setSettingsSection('network');
          setCurrentView('settings');
        },
      },
    });
    await startProxy();
  };

  if (!config) return null;

  const takeoverOptions = [
    {
      value: 'systemProxy' as const,
      label: t('home.takeoverSystemProxy'),
      title: t('settings.proxyMode.systemProxyModeDesc'),
    },
    {
      value: 'tun' as const,
      label: t('home.takeoverTun'),
      title: t('settings.proxyMode.tunModeDesc'),
    },
    {
      value: 'manual' as const,
      label: t('home.takeoverManual'),
      title: t('settings.proxyMode.manualProxyModeDesc'),
    },
  ];

  const routingOptions = [
    { value: 'global' as const, label: t('home.routingGlobal'), title: t('home.modeGlobalDesc') },
    { value: 'smart' as const, label: t('home.routingSmart'), title: t('home.modeSmartDesc') },
    { value: 'direct' as const, label: t('home.routingDirect'), title: t('home.modeDirectDesc') },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('home.proxyControl')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* 接管方式 */}
        <div className="space-y-2">
          <span className="text-sm text-muted-foreground">{t('home.takeoverMethod')}</span>
          <SegmentedControl
            options={takeoverOptions}
            value={proxyModeType}
            onChange={handleTakeoverChange}
            disabled={proxyBusy}
          />
        </div>

        {/* 分流策略 */}
        <div className="space-y-2">
          <span className="text-sm text-muted-foreground">{t('home.routingStrategy')}</span>
          <SegmentedControl
            options={routingOptions}
            value={config.proxyMode || 'smart'}
            onChange={handleRoutingChange}
            disabled={proxyBusy || routingBusy}
          />
        </div>

        {/* 启停 */}
        <div className="pt-1">
          <Button
            onClick={handleToggleProxy}
            disabled={proxyBusy || !isServerConfigured}
            className="w-full"
            size="lg"
            variant={
              proxyPhase === 'stopping' || (proxyPhase === 'idle' && isConnected)
                ? 'destructive'
                : 'default'
            }
            title={!isServerConfigured ? t('home.plsConfigServer') : hasError ? hasError : ''}
          >
            {proxyPhase !== 'idle' ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {proxyPhase === 'stopping' ? t('home.disconnecting') : t('home.connecting')}
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

      {/* 已连接时切换接管方式 → 确认重连 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.proxyMode.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.proxyMode.confirmDesc')}
              <br />
              <br />
              {t('settings.proxyMode.confirmSwitch')}
              <strong>
                {pendingModeType === 'tun'
                  ? t('settings.proxyMode.tunMode')
                  : pendingModeType === 'manual'
                    ? t('settings.proxyMode.manualProxyMode')
                    : t('settings.proxyMode.systemProxyMode')}
              </strong>
              {t('settings.proxyMode.confirmQuestion')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingModeType(null)}>
              {t('settings.proxyMode.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmTakeover}>
              {t('settings.proxyMode.confirmBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <HelperInstallDialog
        open={helperDialogOpen}
        onOpenChange={(o) => {
          setHelperDialogOpen(o);
          if (!o) setHelperGateMode(false); // 关窗即退出 start 门语境
        }}
        variant={helperDialogVariant}
        gateMode={helperGateMode}
        onProceed={() => {
          void startProxy();
        }}
      />
    </Card>
  );
}
