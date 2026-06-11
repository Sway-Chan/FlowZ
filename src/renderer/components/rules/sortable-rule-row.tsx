import type { ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import { TableCell, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  ArrowUpToLine,
  ArrowDownToLine,
  GripVertical,
} from 'lucide-react';
import type { Rule } from '@/bridge/types';
import { TYPE_TO_CATEGORY, CATEGORY_BADGE_CLASS, RULE_TYPE_NAME } from './rule-type-meta';

interface SortableRuleRowProps {
  rule: Rule;
  index: number;
  rowsLength: number;
  isOrderEditing: boolean;
  savingOrder: boolean;
  onToggle: (rule: Rule) => void;
  onEdit: (rule: Rule) => void;
  onDelete: (rule: Rule) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onMoveToEdge: (index: number, edge: 'top' | 'bottom') => void;
  renderExitNode: (rule: Rule) => ReactNode;
}

/**
 * 单条规则行（可拖拽排序）。编辑态：首列为拖拽手柄 + 序号，操作列为 置顶/上/下/置底；
 * 常态：首列为启用开关，操作列为 编辑/删除。useSortable 的 transform 施加到 TableRow。
 */
export function SortableRuleRow({
  rule,
  index,
  rowsLength,
  isOrderEditing,
  savingOrder,
  onToggle,
  onEdit,
  onDelete,
  onMove,
  onMoveToEdge,
  renderExitNode,
}: SortableRuleRowProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rule.id,
    disabled: !isOrderEditing || savingOrder,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // 拖拽中：抬升 + 半透明，让落点更清晰
    opacity: isDragging ? 0.6 : undefined,
    position: isDragging ? ('relative' as const) : undefined,
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <TableRow ref={setNodeRef} style={style} data-dragging={isDragging || undefined}>
      <TableCell>
        {isOrderEditing ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={t('rules.dragToReorder', '拖拽排序')}
              disabled={savingOrder}
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-4 w-4" />
            </button>
            <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">
              {index + 1}
            </span>
          </div>
        ) : (
          <Switch checked={rule.enabled} onCheckedChange={() => onToggle(rule)} />
        )}
      </TableCell>
      <TableCell className="font-mono">
        <div className="flex max-w-[400px] flex-col gap-1">
          {rule.remarks && (
            <div className="truncate text-sm font-semibold text-foreground" title={rule.remarks}>
              {rule.remarks}
            </div>
          )}
          {rule.values.length > 0 && (
            <div className="truncate text-sm" title={rule.values.join(', ')}>
              {rule.values.length <= 3 ? (
                rule.values.join(', ')
              ) : (
                <>
                  {rule.values.slice(0, 3).join(', ')}
                  <span className="ml-1 text-muted-foreground">+{rule.values.length - 3}</span>
                </>
              )}
            </div>
          )}
        </div>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <div className="flex items-center gap-1">
          <Badge
            variant="outline"
            className={`${CATEGORY_BADGE_CLASS[TYPE_TO_CATEGORY[rule.type]]} whitespace-nowrap`}
          >
            {t(`rules.types.${rule.type}.name`, RULE_TYPE_NAME[rule.type])}
          </Badge>
          {/* 多条件规则：首条件类型 badge + 额外条件计数 +N */}
          {rule.conditions && rule.conditions.length > 1 && (
            <span
              className="whitespace-nowrap text-xs text-muted-foreground"
              title={rule.conditions
                .map((c) => t(`rules.types.${c.type}.name`, RULE_TYPE_NAME[c.type]))
                .join(rule.combineMode === 'and' ? ' & ' : ' / ')}
            >
              +{rule.conditions.length - 1}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell>
        {/* 两行：action badge 在上、出口节点/realDns 第二行——避免窄窗竖压 */}
        <div className="flex flex-col items-start gap-1">
          <Badge
            variant="default"
            className={`whitespace-nowrap ${
              rule.action === 'direct'
                ? 'border-transparent bg-green-600 text-white hover:bg-green-600/90'
                : rule.action === 'block'
                  ? 'border-transparent bg-red-600 text-white hover:bg-red-600/90'
                  : ''
            }`}
          >
            {rule.action === 'proxy'
              ? t('rules.proxy')
              : rule.action === 'direct'
                ? t('rules.direct')
                : t('rules.block')}
          </Badge>
          {(rule.action === 'proxy' || rule.bypassFakeIP) && (
            <div className="flex min-w-0 items-center gap-1.5">
              {renderExitNode(rule)}
              {rule.bypassFakeIP && (
                <Badge
                  variant="outline"
                  className="whitespace-nowrap text-xs text-muted-foreground"
                >
                  {t('rules.realDns')}
                </Badge>
              )}
            </div>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-0.5">
          {isOrderEditing ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={savingOrder || index === 0}
                onClick={() => onMoveToEdge(index, 'top')}
                title={t('rules.moveTop', '置顶')}
              >
                <ArrowUpToLine className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={savingOrder || index === 0}
                onClick={() => onMove(index, -1)}
                title={t('rules.moveUp', '上移')}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={savingOrder || index === rowsLength - 1}
                onClick={() => onMove(index, 1)}
                title={t('rules.moveDown', '下移')}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={savingOrder || index === rowsLength - 1}
                onClick={() => onMoveToEdge(index, 'bottom')}
                title={t('rules.moveBottom', '置底')}
              >
                <ArrowDownToLine className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => onEdit(rule)}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onDelete(rule)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
