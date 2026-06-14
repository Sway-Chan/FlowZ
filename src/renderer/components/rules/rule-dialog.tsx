import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { ServerSelectGroups } from '@/components/settings/server-select-groups';
import { useAppStore } from '@/store/app-store';
import type { DomainRule, RuleAction } from '../../../shared/types';
import { useTranslation } from 'react-i18next';

const domainRegex = /^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const ipCidrRegex = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;

const getRuleFormSchema = (t: any) =>
  z
    .object({
      domains: z.string().optional(),
      ipCidr: z.string().optional(),
      action: z.enum(['proxy', 'direct', 'block']),
      enabled: z.boolean(),
      bypassFakeIP: z.boolean(),
      targetServerId: z.string().optional(),
      remarks: z
        .string()
        .max(100, { message: t('rules.remarksLengthError', '备注不能超过100个字符') })
        .optional(),
    })
    .refine((data) => data.domains || data.ipCidr, {
      message: t('rules.errorEmpty', '域名和 IP CIDR 不能同时为空'),
      path: ['domains'],
    });

type RuleFormValues = z.infer<ReturnType<typeof getRuleFormSchema>>;

interface RuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'add' | 'edit';
  rule?: DomainRule;
}

export function RuleDialog({ open, onOpenChange, mode, rule }: RuleDialogProps) {
  const { t } = useTranslation();
  const ruleFormSchema = getRuleFormSchema(t);

  const addCustomRule = useAppStore((state) => state.addCustomRule);
  const updateCustomRule = useAppStore((state) => state.updateCustomRule);
  const servers = useAppStore((state) => state.config?.servers || []);

  const form = useForm<RuleFormValues>({
    resolver: zodResolver(ruleFormSchema),
    defaultValues: {
      domains: '',
      ipCidr: '',
      action: 'proxy',
      enabled: true,
      bypassFakeIP: false,
      targetServerId: 'default',
      remarks: '',
    },
  });

  useEffect(() => {
    if (open) {
      if (mode === 'edit' && rule) {
        form.reset({
          domains: rule.domains.join('\n'),
          ipCidr: rule.ipCidr?.join('\n') || '',
          action: rule.action,
          enabled: rule.enabled,
          bypassFakeIP: rule.bypassFakeIP ?? false,
          targetServerId: rule.targetServerId || 'default',
          remarks: rule.remarks || '',
        });
      } else {
        form.reset({
          domains: '',
          ipCidr: '',
          action: 'proxy',
          enabled: true,
          bypassFakeIP: false,
          targetServerId: 'default',
          remarks: '',
        });
      }
    }
  }, [open, mode, rule, form]);

  const parseLines = (input: string | undefined): string[] => {
    if (!input) return [];
    return input
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  };

  const validateDomain = (domain: string): boolean => {
    if (domain.startsWith('geosite:')) return true;
    return domainRegex.test(domain);
  };

  const validateIpCidr = (ip: string): boolean => {
    return ipCidrRegex.test(ip);
  };

  const onSubmit = async (values: RuleFormValues) => {
    try {
      const domains = parseLines(values.domains);
      const ipCidrs = parseLines(values.ipCidr);

      if (domains.length === 0 && ipCidrs.length === 0) {
        toast.error(t('rules.errorEmpty', '请输入至少一个域名或 IP CIDR'));
        return;
      }

      const invalidDomains = domains.filter((d) => !validateDomain(d));
      if (invalidDomains.length > 0) {
        toast.error(t('rules.invalidDomainFormat', '域名格式不正确'), {
          description: t('rules.invalidDomainFormatDesc', '以下域名格式无效: {{domains}}', {
            domains: `${invalidDomains.slice(0, 3).join(', ')}${invalidDomains.length > 3 ? '...' : ''}`,
          }),
        });
        return;
      }

      const invalidIpCidrs = ipCidrs.filter((ip) => !validateIpCidr(ip));
      if (invalidIpCidrs.length > 0) {
        toast.error(t('rules.invalidIpCidrFormat', 'IP CIDR 格式不正确'), {
          description: t('rules.invalidIpCidrFormatDesc', '以下 CIDR 格式无效: {{ips}}', {
            ips: `${invalidIpCidrs.slice(0, 3).join(', ')}${invalidIpCidrs.length > 3 ? '...' : ''}`,
          }),
        });
        return;
      }

      const targetServerId =
        values.targetServerId === 'default' ? undefined : values.targetServerId;

      if (mode === 'add') {
        const newRule: DomainRule = {
          id: `rule_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          domains,
          ipCidr: ipCidrs,
          action: values.action as RuleAction,
          enabled: values.enabled,
          bypassFakeIP: values.bypassFakeIP,
          targetServerId,
          remarks: values.remarks,
        };
        await addCustomRule(newRule);
        toast.success(t('rules.ruleAdded', '规则已添加'));
      } else if (rule) {
        const updatedRule: DomainRule = {
          ...rule,
          domains,
          ipCidr: ipCidrs,
          action: values.action as RuleAction,
          enabled: values.enabled,
          bypassFakeIP: values.bypassFakeIP,
          targetServerId,
          remarks: values.remarks,
        };
        await updateCustomRule(updatedRule);
        toast.success(t('rules.ruleUpdated', '规则已更新'));
      }

      onOpenChange(false);
    } catch (error) {
      toast.error(t('rules.saveFailed', '保存失败'), {
        description:
          error instanceof Error ? error.message : t('rules.saveErrorDesc', '保存规则时发生错误'),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[95vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === 'add' ? t('rules.addRule', '添加规则') : t('rules.editRule', '编辑规则')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'add'
              ? t('rules.addRuleDesc', '添加新的代理规则 (域名或 IP CIDR)')
              : t('rules.editRuleDesc', '修改代理规则')}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="domains"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('rules.domainLabel', '域名')}</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={`google.com\ngithub.com\nopenai.com`}
                      className="min-h-[100px] font-mono text-sm"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription className="space-y-1">
                    <span className="block">
                      {t('rules.domainTip', '每行输入一个域名，会自动匹配该域名及其所有子域名')}
                    </span>
                    <span className="block text-amber-600/80 dark:text-amber-400/80">
                      {t(
                        'rules.geositeTip',
                        '输入 geosite:标签（如 geosite:youtube）可匹配整个网站分组。注意：标签必须存在于 sing-geosite 数据库（如资源包都没有 geosite:bbc，请直接输入 bbc.com）'
                      )}
                    </span>
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="ipCidr"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('rules.ipCidrLabel', 'IP CIDR (可选)')}</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={`192.168.1.0/24\n10.0.0.0/8`}
                      className="min-h-[80px] font-mono text-sm"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t('rules.ipCidrTip', '每行输入一个 IP CIDR 网段')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="remarks"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('rules.remarksLabel', '备注 (可选)')}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t('rules.remarksPlaceholder', '例如：公司内网、奈飞服务器')}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="action"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('rules.policy', '策略')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={t('rules.selectPolicy', '选择策略')} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="proxy">{t('rules.policyProxy', '代理')}</SelectItem>
                      <SelectItem value="direct">{t('rules.policyDirect', '直连')}</SelectItem>
                      <SelectItem value="block">{t('rules.policyBlock', '阻止')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {form.watch('action') === 'proxy' && (
              <FormField
                control={form.control}
                name="targetServerId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('rules.targetNode', '目标节点 (可选)')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue
                            placeholder={t('rules.defaultNodeTip', '默认 (跟随主节点)')}
                          />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="default">
                          {t('rules.defaultNodeTip', '默认 (跟随主节点)')}
                        </SelectItem>
                        <ServerSelectGroups servers={servers} />
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {t(
                        'rules.targetNodeTip',
                        '指定该规则使用的代理节点。如果不选，则跟随主界面选中的节点。'
                      )}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                  <FormControl>
                    <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel>{t('rules.enableRule', '启用规则')}</FormLabel>
                    <FormDescription>
                      {t('rules.enableRuleTip', '禁用的规则不会生效')}
                    </FormDescription>
                  </div>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="bypassFakeIP"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                  <FormControl>
                    <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel>{t('rules.bypassFakeIp', '绕过 FakeIP')}</FormLabel>
                    <FormDescription>
                      {t(
                        'rules.bypassFakeIpTip',
                        '默认无需开启，不理解请保持关闭。仅用于解决 Cloudflare Tunnel 等应用的 QUIC 协议兼容性问题。'
                      )}
                    </FormDescription>
                  </div>
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={form.formState.isSubmitting}
              >
                {t('servers.cancel', '取消')}
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {mode === 'add' ? t('rules.add', '添加') : t('rules.save', '保存')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
