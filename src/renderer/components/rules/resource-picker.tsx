import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/ipc/api-client';
import { useAppStore } from '@/store/app-store';
import type { RuleResourceListItem } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

interface ResourcePickerProps {
  /** ruleSet 规则的 values：res:<id>（本地资源）或 https://...（远程 URL） */
  value: string[];
  onChange: (values: string[]) => void;
  /** 选「前往规则资源页」前先关闭弹窗 */
  onRequestClose?: () => void;
}

export function ResourcePicker({ value, onChange, onRequestClose }: ResourcePickerProps) {
  const { t } = useTranslation();
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const [resources, setResources] = useState<RuleResourceListItem[]>([]);
  const [urlInput, setUrlInput] = useState('');

  useEffect(() => {
    // 内置（随包）+ 外置（已下载）都列出：两者都是本地 .srs，均可经 res:<id> 引用（内置 id=builtin:<tag>，
    // 后端 generateCustomRules 解析为随包 runtime 路径）。按 builtin 分组渲染。
    api.ruleResources
      .list()
      .then(setResources)
      .catch(() => {});
  }, []);

  const toggleRes = (id: string) => {
    const ref = `res:${id}`;
    onChange(value.includes(ref) ? value.filter((x) => x !== ref) : [...value, ref]);
  };

  const addUrl = () => {
    const u = urlInput.trim();
    if (!/^https?:\/\/.+/i.test(u)) {
      toast.error(t('ruleResources.urlInvalid', '请输入有效的 https 链接'));
      return;
    }
    if (!value.includes(u)) onChange([...value, u]);
    setUrlInput('');
  };

  const remove = (v: string) => onChange(value.filter((x) => x !== v));

  const resName = (id: string) => resources.find((r) => r.id === id)?.name;

  const goToResources = () => {
    onRequestClose?.();
    setCurrentView('ruleResources');
  };

  return (
    <div className="space-y-3">
      {resources.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-center">
          <p className="mb-2 text-sm text-muted-foreground">
            {t('ruleResources.picker.empty', '尚无已下载资源')}
          </p>
          <Button variant="outline" size="sm" onClick={goToResources}>
            {t('ruleResources.picker.goDownload', '前往规则资源页')}
          </Button>
        </div>
      ) : (
        <div className="max-h-56 overflow-auto rounded-md border">
          {(
            [
              ['builtin', resources.filter((r) => r.builtin)] as const,
              ['external', resources.filter((r) => !r.builtin)] as const,
            ] as const
          ).map(([group, list]) =>
            list.length === 0 ? null : (
              <div key={group}>
                <div className="bg-muted/40 px-3 py-1 text-[11px] font-medium text-muted-foreground">
                  {group === 'builtin'
                    ? t('ruleResources.picker.groupBuiltin', '内置 · 随包')
                    : t('ruleResources.picker.groupExternal', '已下载')}
                </div>
                <div className="divide-y divide-border/60">
                  {list.map((r) => {
                    // 文件缺失且未被引用 → 不可新选（后端 isValidSsrFile 会跳过该规则，避免用户建一条静默失效的引用）；
                    // 已引用的缺失项仍可取消（解除失效引用）。文件存在的项正常勾选。
                    const isReferenced = value.includes(`res:${r.id}`);
                    const disabled = !r.fileExists && !isReferenced;
                    return (
                      <label
                        key={r.id}
                        className={`flex items-center gap-3 px-3 py-2 ${
                          disabled ? 'opacity-50' : 'cursor-pointer hover:bg-muted/50'
                        }`}
                      >
                        <Checkbox
                          checked={isReferenced}
                          disabled={disabled}
                          onCheckedChange={() => toggleRes(r.id)}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
                        {!r.fileExists && (
                          <Badge
                            variant="outline"
                            className="border-transparent bg-destructive/15 text-xs text-destructive"
                          >
                            {t('ruleResources.missing', '文件缺失')}
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-xs">
                          {t(`ruleResources.category.${r.category}`, r.category)}
                        </Badge>
                      </label>
                    );
                  })}
                </div>
              </div>
            )
          )}
        </div>
      )}

      {/* 添加远程 URL */}
      <div className="flex gap-2">
        <Input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addUrl())}
          placeholder={t('ruleResources.picker.addUrl', '添加远程规则集 URL')}
          className="font-mono text-sm"
        />
        <Button type="button" variant="outline" size="icon" onClick={addUrl}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* 已选 chips */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => {
            const isRes = v.startsWith('res:');
            const id = v.slice(4);
            const name = isRes ? resName(id) : v;
            const deleted = isRes && !name;
            return (
              <span
                key={v}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${
                  deleted ? 'border-destructive/40 text-destructive' : 'bg-muted'
                }`}
              >
                <span className="max-w-[180px] truncate">
                  {isRes ? name || t('ruleResources.picker.deletedBadge', '已删除') : v}
                </span>
                {isRes && !deleted && (
                  <Badge variant="outline" className="h-4 px-1 text-[10px]">
                    {t('ruleResources.picker.localBadge', '本地')}
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => remove(v)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
