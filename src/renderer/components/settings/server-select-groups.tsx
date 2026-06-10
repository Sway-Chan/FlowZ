import { SelectGroup, SelectItem, SelectLabel } from '@/components/ui/select';
import { groupServersBySubscription } from '@shared/server-grouping';
import type { ServerConfig } from '@/bridge/types';
import { useAppStore } from '@/store/app-store';
import { useTranslation } from 'react-i18next';

interface ServerSelectGroupsProps {
  servers: ServerConfig[];
  /** 排除某节点（用于 detour 选择器避免自指） */
  excludeId?: string;
  /** option value 前缀（如应用分流用 'node-'），默认空 */
  valuePrefix?: string;
  /** SelectItem 透传类名（适配不同选择器字号） */
  itemClassName?: string;
}

/**
 * 在 <SelectContent> 内渲染「按订阅/自建分组」的节点选项，供路由规则 / 应用分流 / 代理链等节点选择器共用。
 * 订阅清单从 store 读取，调用方只需传 servers。单一来源时退化为平铺（不显冗余分组标签）。
 */
export function ServerSelectGroups({
  servers,
  excludeId,
  valuePrefix = '',
  itemClassName,
}: ServerSelectGroupsProps) {
  const { t } = useTranslation();
  const subscriptions = useAppStore((s) => s.config?.subscriptions || []);
  const list = excludeId ? servers.filter((s) => s.id !== excludeId) : servers;
  const groups = groupServersBySubscription(list, subscriptions);
  const val = (id: string) => `${valuePrefix}${id}`;

  // 仅一个分组（纯自建或仅一个订阅）：不加分组标签，平铺更清爽
  if (groups.length <= 1) {
    return (
      <>
        {list.map((s) => (
          <SelectItem key={s.id} value={val(s.id)} className={itemClassName}>
            {s.name}
          </SelectItem>
        ))}
      </>
    );
  }

  return (
    <>
      {groups.map((g) => (
        <SelectGroup key={g.id}>
          <SelectLabel>{g.isManual ? t('servers.manualNodes', '自建节点') : g.name}</SelectLabel>
          {g.servers.map((s) => (
            <SelectItem key={s.id} value={val(s.id)} className={itemClassName}>
              {s.name}
            </SelectItem>
          ))}
        </SelectGroup>
      ))}
    </>
  );
}
