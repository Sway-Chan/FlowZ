/**
 * 抗封增强字段的共享渲染组件（人工配置用）。
 *
 * 各协议表单（vless/trojan/vmess/ss/tuic/hysteria2/anytls）的 RHF schema / 默认值 / submit
 * 映射仍各自维护（react-hook-form 限制），但渲染部分统一走这里，避免在多表单里重复 JSX。
 *
 * 约定的标准字段名（各表单 schema 需包含对应可选字段）：
 *   ECH:       ech?: boolean
 *   Multiplex: muxEnabled?: boolean, muxProtocol?: 'h2mux'|'smux'|'yamux',
 *              muxMaxConnections?: number, muxMinStreams?: number, muxPadding?: boolean
 *
 * 这些字段最终由 ProxyManager.applyAntiCensorshipOptions 消费（tls.ech / multiplex），
 * 后端链路已全通——本组件只补人工入口。
 */
import type { Control } from 'react-hook-form';
import { useFormContext } from 'react-hook-form';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

type AnyControl = Control<any>;
type TFn = (key: string, fallback?: any) => string;

/** ECH（Encrypted Client Hello）开关 —— 隐藏 SNI、抗 SNI 阻断。适用于带 TLS 的协议。 */
export function EchField({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <FormField
      control={control}
      name="ech"
      render={({ field }) => (
        <FormItem className="flex flex-row items-start space-x-3 space-y-0">
          <FormControl>
            <Checkbox checked={field.value === true} onCheckedChange={field.onChange} />
          </FormControl>
          <div className="space-y-1 leading-none">
            <FormLabel>{t('servers.ech')}</FormLabel>
            <FormDescription>{t('servers.echDesc')}</FormDescription>
          </div>
        </FormItem>
      )}
    />
  );
}

/**
 * Multiplex（多路复用）字段组。
 * @param disabled    置 true 时禁用并显示 disabledReason（如 vision flow 不兼容）
 */
export function MultiplexFields({
  control,
  t,
  disabled = false,
  disabledReason,
}: {
  control: AnyControl;
  t: TFn;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const { watch } = useFormContext();
  const enabled = watch('muxEnabled') === true;

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <FormField
        control={control}
        name="muxEnabled"
        render={({ field }) => (
          <FormItem className="flex flex-row items-start space-x-3 space-y-0">
            <FormControl>
              <Checkbox
                checked={field.value === true && !disabled}
                disabled={disabled}
                onCheckedChange={field.onChange}
              />
            </FormControl>
            <div className="space-y-1 leading-none">
              <FormLabel>{t('servers.multiplex')}</FormLabel>
              <FormDescription>
                {disabled
                  ? disabledReason || t('servers.multiplexDisabled')
                  : t('servers.multiplexDesc')}
              </FormDescription>
            </div>
          </FormItem>
        )}
      />

      {enabled && !disabled && (
        <div className="space-y-3 pl-6">
          <FormField
            control={control}
            name="muxProtocol"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('servers.multiplexProtocol')}</FormLabel>
                <Select onValueChange={field.onChange} value={field.value || 'h2mux'}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="h2mux" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="h2mux">h2mux</SelectItem>
                    <SelectItem value="smux">smux</SelectItem>
                    <SelectItem value="yamux">yamux</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={control}
              name="muxMaxConnections"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.multiplexMaxConn')}</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder={t('servers.optional')}
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) =>
                        field.onChange(e.target.value ? parseInt(e.target.value, 10) : undefined)
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name="muxMinStreams"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.multiplexMinStreams')}</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder={t('servers.optional')}
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) =>
                        field.onChange(e.target.value ? parseInt(e.target.value, 10) : undefined)
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={control}
            name="muxPadding"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                <FormControl>
                  <Checkbox checked={field.value === true} onCheckedChange={field.onChange} />
                </FormControl>
                <div className="space-y-1 leading-none">
                  <FormLabel>{t('servers.multiplexPadding')}</FormLabel>
                  <FormDescription>{t('servers.multiplexPaddingDesc')}</FormDescription>
                </div>
              </FormItem>
            )}
          />
        </div>
      )}
    </div>
  );
}
