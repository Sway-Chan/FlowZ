import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2 } from 'lucide-react';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createHysteria2Schema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    password: z.string().min(1, t('servers.passwordRequired')),
    // 带宽限制
    upMbps: z.number().optional(),
    downMbps: z.number().optional(),
    serverPorts: z.string().optional(),
    hopInterval: z.string().optional(),
    // 混淆设置
    obfsEnabled: z.boolean(),
    obfsPassword: z.string().optional(),
    // TLS 设置
    tlsServerName: z.string().optional(),
    tlsAllowInsecure: z.boolean(),
  });

type Hysteria2FormValues = z.infer<ReturnType<typeof createHysteria2Schema>>;

interface Hysteria2FormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

const normalizeHopInterval = (value?: string): string | undefined => {
  const input = value?.trim();
  if (!input) return undefined;
  return /^\d+$/.test(input) ? `${input}s` : input;
};

export function Hysteria2Form({ serverConfig, onSubmit }: Hysteria2FormProps) {
  const { t } = useTranslation();
  const hysteria2FormSchema = createHysteria2Schema(t);

  const form = useForm<Hysteria2FormValues>({
    resolver: zodResolver(hysteria2FormSchema),
    defaultValues: {
      address: '',
      port: 443,
      password: '',
      upMbps: undefined,
      downMbps: undefined,
      serverPorts: '',
      hopInterval: '',
      obfsEnabled: false,
      obfsPassword: '',
      tlsServerName: '',
      tlsAllowInsecure: false,
    },
  });

  useEffect(() => {
    console.log('[Hysteria2Form] Server config changed:', serverConfig);
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'hysteria2') {
      const formData = {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        password: serverConfig.password || '',
        upMbps: serverConfig.hysteria2Settings?.upMbps ?? undefined,
        downMbps: serverConfig.hysteria2Settings?.downMbps ?? undefined,
        serverPorts: serverConfig.hysteria2Settings?.serverPorts || '',
        hopInterval: serverConfig.hysteria2Settings?.hopInterval || '',
        obfsEnabled: !!serverConfig.hysteria2Settings?.obfs?.type,
        obfsPassword: serverConfig.hysteria2Settings?.obfs?.password || '',
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
      };
      console.log('[Hysteria2Form] Resetting form with:', formData);
      form.reset(formData);
    }
  }, [serverConfig, form]);

  const handleSubmit = async (values: Hysteria2FormValues) => {
    const serverConfig: any = {
      protocol: 'hysteria2' as const,
      address: values.address,
      port: values.port,
      password: values.password,
      // Hysteria2 总是使用 TLS
      security: 'tls',
      tlsSettings: {
        serverName: values.tlsServerName || undefined,
        allowInsecure: values.tlsAllowInsecure,
      },
      hysteria2Settings: {
        upMbps: values.upMbps || undefined,
        downMbps: values.downMbps || undefined,
        serverPorts: values.serverPorts?.trim() || undefined,
        hopInterval: normalizeHopInterval(values.hopInterval),
        obfs:
          values.obfsEnabled && values.obfsPassword
            ? {
                type: 'salamander',
                password: values.obfsPassword,
              }
            : undefined,
      },
    };

    await onSubmit(serverConfig);
  };

  const isObfsEnabled = form.watch('obfsEnabled');
  const hasServerPorts = !!form.watch('serverPorts')?.trim();

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <FormField
          control={form.control}
          name="address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('servers.serverAddress')}</FormLabel>
              <FormControl>
                <Input placeholder="example.com" {...field} />
              </FormControl>
              <FormDescription>{t('servers.serverAddressDesc')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="port"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('servers.port')}</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  placeholder="443"
                  {...field}
                  disabled={hasServerPorts}
                  onChange={(e) => field.onChange(parseInt(e.target.value) || 0)}
                />
              </FormControl>
              <FormDescription>{t('servers.portDesc')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('servers.password')}</FormLabel>
              <FormControl>
                <Input type="password" placeholder={t('servers.passwordPlaceholder')} {...field} />
              </FormControl>
              <FormDescription>{t('servers.passwordDesc')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="upMbps"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('servers.upMbps')}</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    placeholder={t('servers.optional')}
                    {...field}
                    value={field.value ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      field.onChange(val ? parseInt(val) : undefined);
                    }}
                  />
                </FormControl>
                <FormDescription>{t('servers.bbrDesc')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="downMbps"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('servers.downMbps')}</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    placeholder={t('servers.optional')}
                    {...field}
                    value={field.value ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      field.onChange(val ? parseInt(val) : undefined);
                    }}
                  />
                </FormControl>
                <FormDescription>{t('servers.bbrDesc')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="serverPorts"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('servers.serverPorts')}</FormLabel>
                <FormControl>
                  <Input placeholder="47000:48000,50000" {...field} />
                </FormControl>
                <FormDescription>{t('servers.serverPortsDesc')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="hopInterval"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('servers.hopInterval')}</FormLabel>
                <FormControl>
                  <Input placeholder="18" {...field} />
                </FormControl>
                <FormDescription>{t('servers.hopIntervalDesc')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="obfsEnabled"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel>{t('servers.obfsEnabled')}</FormLabel>
                <FormDescription>{t('servers.obfsEnabledDesc')}</FormDescription>
              </div>
            </FormItem>
          )}
        />

        {isObfsEnabled && (
          <FormField
            control={form.control}
            name="obfsPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('servers.obfsPassword')}</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    placeholder={t('servers.obfsPasswordPlaceholder')}
                    {...field}
                  />
                </FormControl>
                <FormDescription>{t('servers.obfsPasswordDesc')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="tlsServerName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('servers.tlsServerName')}</FormLabel>
              <FormControl>
                <Input placeholder="example.com" {...field} />
              </FormControl>
              <FormDescription>{t('servers.tlsServerNameDesc')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="tlsAllowInsecure"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel>{t('servers.allowInsecure')}</FormLabel>
                <FormDescription>{t('servers.allowInsecureDesc')}</FormDescription>
              </div>
            </FormItem>
          )}
        />

        <div className="flex gap-4">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('common.save')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => form.reset()}
            disabled={form.formState.isSubmitting}
          >
            {t('common.reset')}
          </Button>
        </div>
      </form>
    </Form>
  );
}
