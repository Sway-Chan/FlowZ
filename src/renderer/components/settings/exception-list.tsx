import { useState, useEffect } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import { parseLines } from '../../../shared/parse-lines';

interface ExceptionListProps {
  /** 当前清单：undefined=用 defaults（未编辑） */
  value?: string[];
  /** 默认 seed / 恢复默认源 */
  defaults: readonly string[];
  /** 提交回调（onBlur / 恢复默认） */
  onChange?: (values: string[]) => void;
  placeholder?: string;
  /** 一句辅助说明 */
  hint?: string;
  /** hint 配色：muted=次要灰（默认）；warning=琥珀提醒（与网关提示一致，强调优先级语义） */
  hintTone?: 'muted' | 'warning';
}

/**
 * 设置项「例外清单」统一展开式编辑器（开关 ON 时由父级条件渲染）：
 * textarea 每行一条、onBlur 提交、恢复默认。FakeIP 例外域名 / 绕过局域网共用。
 */
export function ExceptionList({
  value,
  defaults,
  onChange,
  placeholder,
  hint,
  hintTone = 'muted',
}: ExceptionListProps) {
  const { t } = useTranslation();
  const [text, setText] = useState((value ?? defaults).join('\n'));
  // defaults 为模块常量（引用稳定）；value 变化时同步 textarea。
  useEffect(() => setText((value ?? defaults).join('\n')), [value, defaults]);
  const hintClass = `text-xs ${hintTone === 'warning' ? 'font-medium text-warning' : 'text-muted-foreground'}`;

  const isModified = value !== undefined;
  return (
    <div className="space-y-1.5 pb-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange?.(parseLines(text))}
        rows={5}
        spellCheck={false}
        placeholder={placeholder}
        className="w-full font-mono text-xs"
      />
      <div className="flex items-center justify-between gap-2">
        {hint ? <p className={hintClass}>{hint}</p> : <span />}
        <Button
          size="sm"
          disabled={!isModified}
          onClick={() => onChange?.([...defaults])}
          className="shrink-0"
        >
          {t('common.restoreDefault', '恢复默认')}
        </Button>
      </div>
    </div>
  );
}
