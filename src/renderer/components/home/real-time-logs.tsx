import { useEffect, useRef, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { useAppStore } from '@/store/app-store';
import { Trash2, ArrowDown, Search } from 'lucide-react';
import { getLogs, clearLogs, addEventListener } from '@/bridge/api-wrapper';
import type { LogEntry } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

export function RealTimeLogs() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isAutoScroll, setIsAutoScroll] = useState(false); // 默认不自动滚动
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const userScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const connectionStatus = useAppStore((state) => state.connectionStatus);

  // Load initial logs and set up real-time updates
  useEffect(() => {
    const loadInitialLogs = async () => {
      try {
        const response = await getLogs(50);
        if (response && response.success && response.data) {
          setLogs(response.data);
        }
      } catch (error) {
        console.error('Failed to load initial logs:', error);
      }
    };

    // Load initial logs
    loadInitialLogs();

    // Set up real-time log listener
    const handleLogReceived = (logEntry: LogEntry) => {
      setLogs((prev) => {
        const updated = [...prev, logEntry];
        // Keep only last 100 logs
        return updated.slice(-100);
      });
    };

    const unsubscribe = addEventListener('logReceived', handleLogReceived);

    return () => {
      unsubscribe();
    };
  }, []);

  // 获取滚动元素
  const getScrollElement = useCallback(() => {
    return scrollAreaRef.current?.querySelector(
      '[data-radix-scroll-area-viewport]'
    ) as HTMLElement | null;
  }, []);

  // 检查是否在底部
  const checkIsAtBottom = useCallback((element: HTMLElement) => {
    const threshold = 30; // 距离底部30px以内认为在底部
    return element.scrollTop + element.clientHeight >= element.scrollHeight - threshold;
  }, []);

  // 监听滚动事件
  useEffect(() => {
    const scrollElement = getScrollElement();
    if (!scrollElement) return;

    const handleScroll = () => {
      // 标记用户正在滚动
      setIsUserScrolling(true);

      // 清除之前的超时
      if (userScrollTimeoutRef.current) {
        clearTimeout(userScrollTimeoutRef.current);
      }

      // 设置超时，滚动停止后更新状态
      userScrollTimeoutRef.current = setTimeout(() => {
        setIsUserScrolling(false);
        // 检查是否滚动到底部
        const atBottom = checkIsAtBottom(scrollElement);
        setIsAutoScroll(atBottom);
      }, 150);
    };

    scrollElement.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      scrollElement.removeEventListener('scroll', handleScroll);
      if (userScrollTimeoutRef.current) {
        clearTimeout(userScrollTimeoutRef.current);
      }
    };
  }, [getScrollElement, checkIsAtBottom]);

  // 只有在自动滚动模式且用户没有主动滚动时才自动滚动到底部
  useEffect(() => {
    if (isAutoScroll && !isUserScrolling) {
      const scrollElement = getScrollElement();
      if (scrollElement) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    }
  }, [logs, isAutoScroll, isUserScrolling, getScrollElement]);

  const handleClearLogs = async () => {
    try {
      const success = await clearLogs();
      if (success) {
        setLogs([]);
      }
    } catch (error) {
      console.error('Failed to clear logs:', error);
      // Clear local logs anyway
      setLogs([]);
    }
  };

  const getLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'error':
        return 'text-red-500';
      case 'warn':
        return 'text-yellow-500';
      case 'info':
        return 'text-blue-500';
      case 'debug':
        return 'text-gray-500';
      default:
        return 'text-foreground';
    }
  };

  const filteredLogs = logs.filter(
    (log) =>
      log.message.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.level.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{t('home.realTimeLogs')}</CardTitle>
          <div className="flex items-center space-x-2">
            <div className="relative">
              <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={t('home.searchLogs')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="h-8 w-[160px] pl-8 text-xs"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearLogs}
              disabled={logs.length === 0}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              {t('home.clear')}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea ref={scrollAreaRef} className="h-64 w-full rounded border bg-muted/30 p-3">
          {filteredLogs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              {logs.length > 0 && searchTerm
                ? t('home.noLogsMatch')
                : connectionStatus?.proxyCore?.running
                  ? t('home.waitingForLogs')
                  : t('home.plsStartProxy')}
            </div>
          ) : (
            <div className="space-y-1 select-text cursor-text">
              {filteredLogs.map((log, index) => {
                const timestamp = new Date(log.timestamp).toLocaleTimeString('zh-CN');

                return (
                  <div key={index} className="text-xs font-mono select-text">
                    <span className="text-muted-foreground">[{timestamp}]</span>
                    <span className={`ml-2 font-semibold ${getLevelColor(log.level)}`}>
                      {log.level.toUpperCase()}:
                    </span>
                    <span className="ml-2">{log.message}</span>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>

        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {isAutoScroll ? t('home.autoScrollOn') : t('home.autoScrollOff')}
          </span>
          {!isAutoScroll && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsAutoScroll(true);
                const scrollElement = getScrollElement();
                if (scrollElement) {
                  scrollElement.scrollTop = scrollElement.scrollHeight;
                }
              }}
              className="text-xs h-7"
            >
              <ArrowDown className="h-3 w-3 mr-1" />
              {t('home.scrollToBottom')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
