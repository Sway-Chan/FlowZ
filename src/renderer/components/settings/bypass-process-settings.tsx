import { useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Plus, X, ShieldOff, Info } from 'lucide-react';
import { toast } from 'sonner';

export function BypassProcessSettings() {
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);
  const [inputValue, setInputValue] = useState('');

  if (!config) return null;

  const bypassProcesses = config.bypassProcesses || [];

  const handleAdd = async () => {
    const name = inputValue.trim();
    if (!name) return;

    // 防止重复
    if (bypassProcesses.some((p) => p.toLowerCase() === name.toLowerCase())) {
      toast.warning('该进程名已在列表中');
      return;
    }

    try {
      await saveConfig({ ...config, bypassProcesses: [...bypassProcesses, name] });
      setInputValue('');
      toast.success(`已添加排除进程: ${name}`);
    } catch {
      toast.error('保存失败');
    }
  };

  const handleRemove = async (name: string) => {
    try {
      await saveConfig({
        ...config,
        bypassProcesses: bypassProcesses.filter((p) => p !== name),
      });
      toast.success(`已移除: ${name}`);
    } catch {
      toast.error('保存失败');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleAdd();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldOff className="h-4 w-4 text-muted-foreground" />
          排除进程（绕过代理）
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 说明 */}
        <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            添加进程名后，该进程的所有流量将直连，不经过代理。
            <br />
            Windows 填写 <code className="bg-muted rounded px-1">.exe</code> 文件名，如{' '}
            <code className="bg-muted rounded px-1">THS.exe</code>；
            macOS 填写应用进程名，如{' '}
            <code className="bg-muted rounded px-1">THS</code>。
            需要重启代理后生效。
          </span>
        </div>

        {/* 输入框 */}
        <div className="flex gap-2">
          <Input
            placeholder="输入进程名，如 THS.exe 或 ths"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-9 text-sm"
          />
          <Button onClick={handleAdd} size="sm" className="h-9 px-3 shrink-0" disabled={!inputValue.trim()}>
            <Plus className="h-4 w-4 mr-1" />
            添加
          </Button>
        </div>

        {/* 进程列表 */}
        {bypassProcesses.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {bypassProcesses.map((name) => (
              <Badge
                key={name}
                variant="secondary"
                className="flex items-center gap-1.5 pr-1.5 pl-2.5 py-1 text-xs font-mono"
              >
                {name}
                <button
                  onClick={() => handleRemove(name)}
                  className="ml-0.5 rounded-sm opacity-60 hover:opacity-100 transition-opacity"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground text-center py-3">
            暂未添加任何排除进程
          </p>
        )}
      </CardContent>
    </Card>
  );
}
