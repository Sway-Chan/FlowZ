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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2 } from 'lucide-react';
import { EchField, MultiplexFields } from './shared/anti-censor-fields';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createTrojanSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    password: z.string().min(1, t('servers.passwordRequired')),
    network: z.enum(['tcp', 'ws', 'h2', 'httpupgrade']),
    security: z.enum(['none', 'tls']),
    tlsServerName: z.string().optional(),
    tlsAllowInsecure: z.boolean(),
    tlsFingerprint: z.string().optional(),
    alpn: z.string().optional(),
    wsPath: z.string().optional(),
    wsHost: z.string().optional(),
    ech: z.boolean().optional(),
    muxEnabled: z.boolean().optional(),
    muxProtocol: z.enum(['h2mux', 'smux', 'yamux']).optional(),
    muxMaxConnections: z.number().optional(),
    muxMinStreams: z.number().optional(),
    muxPadding: z.boolean().optional(),
  });

type TrojanFormValues = z.infer<ReturnType<typeof createTrojanSchema>>;

interface TrojanFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function TrojanForm({ serverConfig, onSubmit }: TrojanFormProps) {
  const { t } = useTranslation();
  const trojanFormSchema = createTrojanSchema(t);

  const form = useForm<TrojanFormValues>({
    resolver: zodResolver(trojanFormSchema),
    defaultValues: {
      address: '',
      port: 443,
      password: '',
      network: 'tcp',
      security: 'tls',
      tlsServerName: '',
      tlsAllowInsecure: false,
      tlsFingerprint: 'none',
      alpn: '',
      wsPath: '',
      wsHost: '',
      ech: false,
      muxEnabled: false,
      muxProtocol: 'h2mux',
      muxMaxConnections: undefined,
      muxMinStreams: undefined,
      muxPadding: false,
    },
  });

  useEffect(() => {
    console.log('[TrojanForm] Server config changed:', serverConfig);
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'trojan') {
      // 标准化 network 和 security 值（转为全小写以匹配 schema）
      const normalizeNetwork = (n: string | undefined): 'tcp' | 'ws' | 'h2' | 'httpupgrade' => {
        const lower = (n || 'tcp').toLowerCase();
        if (lower === 'ws' || lower === 'websocket') return 'ws';
        if (lower === 'httpupgrade') return 'httpupgrade';
        if (lower === 'h2' || lower === 'http2') return 'h2';
        return 'tcp';
      };
      const normalizeSecurity = (s: string | undefined): 'none' | 'tls' => {
        const lower = (s || 'tls').toLowerCase();
        return lower === 'none' ? 'none' : 'tls';
      };

      const formData = {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        password: serverConfig.password || '',
        network: normalizeNetwork(serverConfig.network),
        security: normalizeSecurity(serverConfig.security),
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        tlsFingerprint: serverConfig.tlsSettings?.fingerprint || 'none',
        alpn: serverConfig.tlsSettings?.alpn?.join(',') || '',
        wsPath: serverConfig.wsSettings?.path || '',
        wsHost: serverConfig.wsSettings?.headers?.['Host'] || '',
        ech: serverConfig.tlsSettings?.ech === true,
        muxEnabled: serverConfig.multiplexSettings?.enabled === true,
        muxProtocol:
          (serverConfig.multiplexSettings?.protocol as 'h2mux' | 'smux' | 'yamux') || 'h2mux',
        muxMaxConnections: serverConfig.multiplexSettings?.maxConnections,
        muxMinStreams: serverConfig.multiplexSettings?.minStreams,
        muxPadding: serverConfig.multiplexSettings?.padding === true,
      };
      console.log('[TrojanForm] Resetting form with:', formData);
      form.reset(formData);
    }
  }, [serverConfig, form]);

  const handleSubmit = async (values: TrojanFormValues) => {
    console.log('[TrojanForm] Submitting values:', values);
    const config = {
      protocol: 'trojan',
      address: values.address,
      port: values.port,
      password: values.password,
      network: values.network,
      security: values.security,
      tlsSettings:
        values.security === 'tls'
          ? {
              serverName: values.tlsServerName || null,
              allowInsecure: values.tlsAllowInsecure,
              fingerprint: values.tlsFingerprint || 'none',
              alpn: values.alpn ? values.alpn.split(',').map((s) => s.trim()) : undefined,
              ech: values.ech ? true : undefined,
            }
          : null,
      wsSettings:
        values.network === 'ws' || values.network === 'httpupgrade'
          ? {
              path: values.wsPath || '/',
              headers: values.wsHost ? { Host: values.wsHost } : undefined,
            }
          : null,
      multiplexSettings: values.muxEnabled
        ? {
            enabled: true,
            protocol: values.muxProtocol || 'h2mux',
            maxConnections: values.muxMaxConnections,
            minStreams: values.muxMinStreams,
            padding: values.muxPadding === true,
          }
        : undefined,
    };

    try {
      await onSubmit(config);
    } catch (error) {
      console.error('[TrojanForm] Submit failed:', error);
    }
  };

  const isTlsEnabled = form.watch('security') === 'tls';
  const isWebSocketEnabled =
    form.watch('network') === 'ws' || form.watch('network') === 'httpupgrade';

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
              <FormDescription>{t('servers.trojanPasswordDesc')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="network"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('servers.transport')}</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={t('servers.selectTransport')} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="tcp">TCP</SelectItem>
                  <SelectItem value="ws">WebSocket</SelectItem>
                  <SelectItem value="httpupgrade">HTTPUpgrade</SelectItem>
                  <SelectItem value="h2">HTTP/2</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>{t('servers.transportDesc')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="security"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('servers.security')}</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={t('servers.selectSecurity')} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="none">{t('servers.none')}</SelectItem>
                  <SelectItem value="tls">TLS</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>{t('servers.securityDesc')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {isTlsEnabled && (
          <>
            <div className="grid grid-cols-2 gap-4">
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
                name="alpn"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.alpn')}</FormLabel>
                    <FormControl>
                      <Input placeholder="http/1.1" {...field} />
                    </FormControl>
                    <FormDescription>{t('servers.alpnDesc')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="tlsFingerprint"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.fingerprint')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue
                          placeholder={t('servers.selectFingerprint', 'Select TLS Fingerprint')}
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">{t('servers.none', 'None')}</SelectItem>
                      <SelectItem value="chrome">Chrome</SelectItem>
                      <SelectItem value="firefox">Firefox</SelectItem>
                      <SelectItem value="safari">Safari</SelectItem>
                      <SelectItem value="edge">Edge</SelectItem>
                      <SelectItem value="ios">iOS</SelectItem>
                      <SelectItem value="android">Android</SelectItem>
                      <SelectItem value="random">{t('servers.random')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>{t('servers.fingerprintDesc')}</FormDescription>
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

            <EchField control={form.control} t={t} />
          </>
        )}

        {isWebSocketEnabled && (
          <>
            <FormField
              control={form.control}
              name="wsPath"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.wsPath')}</FormLabel>
                  <FormControl>
                    <Input placeholder="" {...field} />
                  </FormControl>
                  <FormDescription>{t('servers.wsPathDesc')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="wsHost"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.wsHost')}</FormLabel>
                  <FormControl>
                    <Input placeholder="example.com" {...field} />
                  </FormControl>
                  <FormDescription>{t('servers.wsHostDesc')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </>
        )}

        <MultiplexFields control={form.control} t={t} disabled={false} />

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
