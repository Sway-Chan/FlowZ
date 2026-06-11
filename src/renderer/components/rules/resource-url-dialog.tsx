import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { deriveResourceMeta } from '../../../shared/rule-resource-catalog';
import type { RuleResourceDownloadItem } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

interface ResourceUrlDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDownload: (items: RuleResourceDownloadItem[]) => void;
}

export function ResourceUrlDialog({ open, onOpenChange, onDownload }: ResourceUrlDialogProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    if (open) {
      setUrl('');
      setName('');
    }
  }, [open]);

  const derivedName = url.trim() ? deriveResourceMeta(url.trim()).name : '';

  const handleAdd = () => {
    const u = url.trim();
    if (!/^https:\/\/.+\.srs$/i.test(u)) {
      toast.error(t('ruleResources.urlInvalid', '请输入以 .srs 结尾的 https 链接'));
      return;
    }
    onDownload([{ url: u, name: name.trim() || undefined }]);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('ruleResources.manualUrl', 'URL 下载')}</DialogTitle>
          <DialogDescription>
            {t(
              'ruleResources.urlHint',
              '输入 .srs 规则集链接；raw.githubusercontent.com 链接会自动应用加速'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('ruleResources.urlLabel', '链接')}</label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/rule.srs"
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('ruleResources.nameLabel', '名称 (可选)')}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={derivedName || t('ruleResources.namePlaceholder', '留空自动命名')}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('servers.cancel', '取消')}
          </Button>
          <Button onClick={handleAdd} disabled={!url.trim()}>
            {t('ruleResources.download', '下载')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
