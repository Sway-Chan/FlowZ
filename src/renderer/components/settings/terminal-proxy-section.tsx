import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ChevronRight, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

interface TerminalProxySectionProps {
  httpPort: string;
  socksPort: string;
}

/**
 * 终端代理速查表：默认折叠（这是「工具/文档」不是高频设置，不应撑大设置页）。
 * 数据驱动渲染各平台命令，避免重复 JSX。
 */
export function TerminalProxySection({ httpPort, socksPort }: TerminalProxySectionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const copy = (cmd: string) => {
    navigator.clipboard.writeText(cmd);
    toast.success(t('settings.advanced.copied'));
  };

  const h = `http://127.0.0.1:${httpPort}`;
  const s = `socks5://127.0.0.1:${socksPort}`;
  const groups: { label: string; cmds: string[] }[] = [
    { label: 'Windows (CMD)', cmds: [`set http_proxy=${h}`, `set https_proxy=${h}`] },
    { label: 'Windows (PowerShell)', cmds: [`$env:http_proxy="${h}"`, `$env:https_proxy="${h}"`] },
    {
      label: 'Linux/macOS (Bash/Zsh)',
      cmds: [`export http_proxy=${h}`, `export https_proxy=${h}`],
    },
    {
      label: t('settings.advanced.gitProxy'),
      cmds: [`git config --global http.proxy ${h}`, `git config --global https.proxy ${h}`],
    },
    {
      label: t('settings.advanced.npmProxy'),
      cmds: [`npm config set proxy ${h}`, `npm config set https-proxy ${h}`],
    },
    {
      label: t('settings.advanced.socks5Proxy'),
      cmds: [`set ALL_PROXY=${s}`, `$env:ALL_PROXY="${s}"`, `export ALL_PROXY=${s}`],
    },
  ];

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-sm font-medium"
      >
        <ChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
        {t('settings.advanced.terminalProxy')}
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            {t('settings.advanced.terminalProxyDesc')}
          </p>
          {groups.map((g) => (
            <div key={g.label}>
              <Label className="text-xs font-medium text-muted-foreground">{g.label}</Label>
              <div className="mt-1 space-y-1">
                {g.cmds.map((cmd) => (
                  <div key={cmd} className="flex items-center gap-2">
                    <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                      {cmd}
                    </code>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => copy(cmd)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="rounded-lg bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground">
              <strong>{t('settings.advanced.tip')}</strong>
            </p>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              <li>• {t('settings.advanced.tipSessionOnly')}</li>
              <li>• {t('settings.advanced.tipPermanent')}</li>
              <li>• {t('settings.advanced.tipHttpPort', { port: httpPort })}</li>
              <li>• {t('settings.advanced.tipSocksPort', { port: socksPort })}</li>
              <li>• {t('settings.advanced.tipDisable')}</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
