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

const vmessFormSchema = z.object({
  address: z.string().min(1, 'Address is required'),
  port: z.number().min(1).max(65535),
  uuid: z
    .string()
    .min(1, 'UUID is required')
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID'),
  alterId: z.number().default(0),
  vmessSecurity: z.string().default('auto'),
  network: z.enum(['Tcp', 'Ws', 'H2', 'HttpUpgrade']),
  security: z.enum(['None', 'Tls']),
  tlsServerName: z.string().optional().or(z.literal('')),
  tlsAllowInsecure: z.boolean(),
  tlsFingerprint: z.string().optional().or(z.literal('')),
  wsPath: z.string().optional().or(z.literal('')),
  wsHost: z.string().optional().or(z.literal('')),
  ech: z.boolean().optional(),
  muxEnabled: z.boolean().optional(),
  muxProtocol: z.enum(['h2mux', 'smux', 'yamux']).optional(),
  muxMaxConnections: z.number().optional(),
  muxMinStreams: z.number().optional(),
  muxPadding: z.boolean().optional(),
});

type VmessFormValues = z.infer<typeof vmessFormSchema>;

interface VmessFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function VmessForm({ serverConfig, onSubmit }: VmessFormProps) {
  const { t } = useTranslation();

  const normalizeNetwork = (n: string | undefined): 'Tcp' | 'Ws' | 'H2' | 'HttpUpgrade' => {
    const lower = (n || 'tcp').toLowerCase();
    if (lower === 'ws' || lower === 'websocket') return 'Ws';
    if (lower === 'httpupgrade') return 'HttpUpgrade';
    if (lower === 'h2' || lower === 'http2') return 'H2';
    return 'Tcp';
  };

  const normalizeSecurity = (s: string | undefined): 'None' | 'Tls' => {
    const lower = (s || 'none').toLowerCase();
    if (lower === 'tls') return 'Tls';
    return 'None';
  };

  const getDefaultValues = (): VmessFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'vmess') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        uuid: serverConfig.uuid || '',
        alterId: serverConfig.alterId ?? 0,
        vmessSecurity: serverConfig.vmessSecurity || 'auto',
        network: normalizeNetwork(serverConfig.network),
        security: normalizeSecurity(serverConfig.security),
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        tlsFingerprint: serverConfig.tlsSettings?.fingerprint || 'chrome',
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
    }
    return {
      address: '',
      port: 443,
      uuid: '',
      alterId: 0,
      vmessSecurity: 'auto',
      network: 'Tcp',
      security: 'None',
      tlsServerName: '',
      tlsAllowInsecure: false,
      tlsFingerprint: 'chrome',
      wsPath: '',
      wsHost: '',
      ech: false,
      muxEnabled: false,
      muxProtocol: 'h2mux',
      muxMaxConnections: undefined,
      muxMinStreams: undefined,
      muxPadding: false,
    };
  };

  const form = useForm<any>({
    resolver: zodResolver(vmessFormSchema),
    defaultValues: getDefaultValues(),
  });

  const handleSubmit = async (values: VmessFormValues) => {
    const network = values.network.toLowerCase() as 'tcp' | 'ws' | 'h2' | 'httpupgrade';
    const security = values.security.toLowerCase() as 'none' | 'tls';

    const serverConfig = {
      protocol: 'vmess' as const,
      address: values.address,
      port: values.port,
      uuid: values.uuid,
      alterId: values.alterId,
      vmessSecurity: values.vmessSecurity,
      network,
      security,
      tlsSettings:
        security === 'tls'
          ? {
              serverName: values.tlsServerName?.trim() || null,
              allowInsecure: values.tlsAllowInsecure,
              fingerprint: values.tlsFingerprint || 'chrome',
              ech: values.ech ? true : undefined,
            }
          : null,
      wsSettings:
        network === 'ws' || network === 'httpupgrade'
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

    await onSubmit(serverConfig);
  };

  const isTlsEnabled = form.watch('security') === 'Tls';
  const isWebSocketEnabled =
    form.watch('network') === 'Ws' || form.watch('network') === 'HttpUpgrade';

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
          name="uuid"
          render={({ field }) => (
            <FormItem>
              <FormLabel>UUID</FormLabel>
              <FormControl>
                <Input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" {...field} />
              </FormControl>
              <FormDescription>{t('servers.vmessUuidDesc', 'VMess 用户 UUID')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="alterId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>AlterID</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  placeholder="0"
                  {...field}
                  onChange={(e) => field.onChange(parseInt(e.target.value) || 0)}
                />
              </FormControl>
              <FormDescription>
                {t('servers.alterIdDesc', 'V2Ray 兼容属性，通常设为 0')}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="vmessSecurity"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('servers.encryption')}</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={t('servers.selectEncryption')} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="auto">auto</SelectItem>
                  <SelectItem value="aes-128-gcm">aes-128-gcm</SelectItem>
                  <SelectItem value="chacha20-poly1305">chacha20-poly1305</SelectItem>
                  <SelectItem value="none">none</SelectItem>
                  <SelectItem value="zero">zero</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>{t('servers.vmessSecurityDesc', 'VMess 加密方式')}</FormDescription>
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
                  <SelectItem value="Tcp">TCP</SelectItem>
                  <SelectItem value="Ws">WebSocket</SelectItem>
                  <SelectItem value="HttpUpgrade">HTTPUpgrade</SelectItem>
                  <SelectItem value="H2">HTTP/2</SelectItem>
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
                  <SelectItem value="None">{t('servers.none')}</SelectItem>
                  <SelectItem value="Tls">TLS</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>{t('servers.securityDesc')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {isTlsEnabled && (
          <>
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
