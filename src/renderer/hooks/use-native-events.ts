/**
 * React hook for listening to IPC events from Electron main process
 */

import { useEffect } from 'react';
import { api } from '../ipc';
import { ErrorHandler, ErrorCategory } from '../lib/error-handler';
import { toast } from 'sonner';

// 定义事件数据类型
interface NativeEventData {
  processStarted: { pid: number | null; startTime?: string | Date; autoRestarted?: boolean };
  processStopped: Record<string, never>;
  // 主进程各 emit 点 payload 不完全一致（{message,code}|{message,error}|{message,code,signal}），
  // 统一按 message 优先、error 兜底消费
  processError: { message?: string; error?: string; code?: number; signal?: string | null };
  configChanged: { key?: string; oldValue?: any; newValue?: any };
  statsUpdated: any;
  navigateToPage: string;
  proxyModeSwitched: { success: boolean; newMode: string };
  proxyModeSwitchFailed: { success: boolean; error: string };
  autoNodeSwitched: { reason: string; newServerName: string; latency: number };
}

type NativeEventListener<K extends keyof NativeEventData> = (data: NativeEventData[K]) => void;

export function useNativeEvent<K extends keyof NativeEventData>(
  eventName: K,
  callback: NativeEventListener<K>
) {
  useEffect(() => {
    // 根据事件名称注册对应的监听器
    let unsubscribe: (() => void) | undefined;

    switch (eventName) {
      case 'processStarted':
        unsubscribe = api.proxy.onStarted(callback as any);
        break;
      case 'processStopped':
        unsubscribe = api.proxy.onStopped(callback as any);
        break;
      case 'processError':
        unsubscribe = api.proxy.onError(callback as any);
        break;
      case 'configChanged':
        unsubscribe = api.config.onChanged(callback as any);
        break;
      case 'statsUpdated':
        unsubscribe = api.stats.onUpdated(callback as any);
        break;
      case 'autoNodeSwitched':
        unsubscribe = api.proxy.onAutoNodeSwitched(callback as any);
        break;
      default:
        console.warn(`Unknown event: ${eventName}`);
    }

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [eventName, callback]);
}

/**
 * Hook to listen to all native events and update store
 */
export function useNativeEventListeners() {
  const handleProcessStarted = (data: NativeEventData['processStarted']) => {
    console.log('Process started:', data);
    // Refresh connection status when process starts
    import('../store/app-store').then(({ useAppStore }) => {
      const refreshConnectionStatus = useAppStore.getState().refreshConnectionStatus;
      refreshConnectionStatus();
    });
  };

  const handleProcessStopped = (data: NativeEventData['processStopped']) => {
    console.log('Process stopped:', data);
    // Refresh connection status when process stops
    import('../store/app-store').then(({ useAppStore }) => {
      const refreshConnectionStatus = useAppStore.getState().refreshConnectionStatus;
      refreshConnectionStatus();
    });
  };

  const handleProcessError = (data: NativeEventData['processError']) => {
    console.error('Process error:', data);

    // 各 emit 点 message/error 不一致 → 统一取值，避免「崩溃达上限」等场景因只读 data.error 而漏弹 toast
    const errText = data.message ?? data.error;
    // Display user-friendly error notification
    if (errText) {
      // Determine error category and retry capability
      let category = ErrorCategory.Process;
      let canRetry = true;

      // Check for Trojan-specific errors
      if (errText.includes('Trojan') || errText.includes('trojan')) {
        category = ErrorCategory.Connection;

        // Authentication and config errors are not retryable
        if (
          errText.includes('认证失败') ||
          errText.includes('密码错误') ||
          errText.includes('配置错误')
        ) {
          canRetry = false;
        }
      }

      // Check for VLESS-specific errors
      if (errText.includes('VLESS') || errText.includes('vless')) {
        category = ErrorCategory.Connection;

        if (errText.includes('UUID 错误') || errText.includes('认证失败')) {
          canRetry = false;
        }
      }

      // Check for protocol errors
      if (errText.includes('不支持的协议') || errText.includes('Protocol')) {
        category = ErrorCategory.Config;
        canRetry = false;
      }

      // Handle the error with appropriate category
      ErrorHandler.handle({
        category,
        userMessage: errText,
        technicalMessage: errText,
        canRetry,
      });
    }
  };

  const handleConfigChanged = (data: NativeEventData['configChanged']) => {
    console.log('Config changed:', data);
    // 当收到配置变更事件时，直接使用事件中的新配置更新 store
    // 这样可以确保即使在 isLoading 状态下也能同步配置
    import('../store/app-store').then(({ useAppStore }) => {
      if (data.newValue) {
        // 直接更新 store 中的配置
        console.log('Config changed by external source, updating store directly');
        useAppStore.setState({ config: data.newValue });
      } else {
        // 如果没有新配置数据，则重新加载
        const state = useAppStore.getState();
        if (!state.isLoading) {
          console.log('Config changed, reloading from backend...');
          state.loadConfig();
        }
      }
    });
  };

  const handleStatsUpdated = (data: NativeEventData['statsUpdated']) => {
    console.log('Stats updated:', data);
    // 更新统计信息到 store
    import('../store/app-store').then(({ useAppStore }) => {
      useAppStore.getState().refreshStatistics();
    });
  };

  useNativeEvent('processStarted', handleProcessStarted);
  useNativeEvent('processStopped', handleProcessStopped);
  useNativeEvent('processError', handleProcessError);
  useNativeEvent('configChanged', handleConfigChanged);
  useNativeEvent('statsUpdated', handleStatsUpdated);

  const handleAutoNodeSwitched = (data: NativeEventData['autoNodeSwitched']) => {
    // 刷新连接状态和配置，以反映新节点
    import('../store/app-store').then(({ useAppStore }) => {
      useAppStore.getState().refreshConnectionStatus();
      useAppStore.getState().loadConfig();
    });
    // 显示 toast 通知
    toast.success(`已自动切换到 ${data.newServerName}（${data.latency}ms）`, {
      description: `触发原因：${data.reason === '崩溃检测' ? '节点崩溃' : '心跳检测连续失败'}`,
      duration: 5000,
    });
  };

  useNativeEvent('autoNodeSwitched', handleAutoNodeSwitched);
}
