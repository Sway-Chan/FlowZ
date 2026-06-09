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

const createVlessSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    uuid: z
      .string()
      .min(1, t('servers.uuidRequired'))
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        t('servers.uuidInvalid')
      ),
    encryption: z.string().optional(),
    flow: z.string().optional(),
    network: z.enum(['Tcp', 'Ws', 'H2', 'HttpUpgrade']),
    security: z.enum(['None', 'Tls', 'Reality']),
    tlsServerName: z.string().optional(),
    tlsAllowInsecure: z.boolean(),
    tlsFingerprint: z.string().optional(),
    realityPublicKey: z.string().optional(),
    realityShortId: z.string().optional(),
    wsPath: z.string().optional(),
    wsHost: z.string().optional(),
    ech: z.boolean().optional(),
    muxEnabled: z.boolean().optional(),
    muxProtocol: z.enum(['h2mux', 'smux', 'yamux']).optional(),
    muxMaxConnections: z.number().optional(),
    muxMinStreams: z.number().optional(),
    muxPadding: z.boolean().optional(),
  });

type VlessFormValues = z.infer<ReturnType<typeof createVlessSchema>>;

interface VlessFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function VlessForm({ serverConfig, onSubmit }: VlessFormProps) {
  const { t } = useTranslation();
  const vlessFormSchema = createVlessSchema(t);

  const normalizeNetwork = (n: string | undefined): 'Tcp' | 'Ws' | 'H2' | 'HttpUpgrade' => {
    const lower = (n || 'tcp').toLowerCase();
    if (lower === 'ws' || lower === 'websocket') return 'Ws';
    if (lower === 'httpupgrade') return 'HttpUpgrade';
    if (lower === 'h2' || lower === 'http2') return 'H2';
    return 'Tcp';
  };

  const normalizeSecurity = (s: string | undefined): 'None' | 'Tls' | 'Reality' => {
    const lower = (s || 'tls').toLowerCase();
    if (lower === 'none') return 'None';
    if (lower === 'reality') return 'Reality';
    return 'Tls';
  };

  const getDefaultValues = (): VlessFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'vless') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        uuid: serverConfig.uuid || '',
        encryption: serverConfig.encryption?.toLowerCase() || 'none',
        flow: serverConfig.flow || '',
        network: normalizeNetwork(serverConfig.network),
        security: normalizeSecurity(serverConfig.security),
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        tlsFingerprint: serverConfig.tlsSettings?.fingerprint || 'chrome',
        realityPublicKey: serverConfig.realitySettings?.publicKey || '',
        realityShortId: serverConfig.realitySettings?.shortId || '',
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
      encryption: 'none',
      flow: '',
      network: 'Tcp',
      security: 'Tls',
      tlsServerName: '',
      tlsAllowInsecure: false,
      tlsFingerprint: 'chrome',
      realityPublicKey: '',
      realityShortId: '',
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

  const form = useForm<VlessFormValues>({
    resolver: zodResolver(vlessFormSchema),
    defaultValues: getDefaultValues(),
  });

  const handleSubmit = async (values: VlessFormValues) => {
    const network = values.network.toLowerCase() as 'tcp' | 'ws' | 'h2' | 'httpupgrade';
    const security = values.security.toLowerCase() as 'none' | 'tls' | 'reality';

    const serverConfig = {
      protocol: 'vless' as const,
      address: values.address,
      port: values.port,
      uuid: values.uuid,
      encryption: values.encryption || 'none',
      flow: values.flow || undefined,
      network,
      security,
      tlsSettings:
        security === 'tls' || security === 'reality'
          ? {
              serverName: values.tlsServerName?.trim() || null,
              allowInsecure: security === 'tls' ? values.tlsAllowInsecure : false,
              fingerprint: values.tlsFingerprint || 'chrome',
              ech: values.ech ? true : undefined,
            }
          : null,
      realitySettings:
        security === 'reality'
          ? {
              publicKey: values.realityPublicKey?.trim() || '',
              shortId: values.realityShortId?.trim() || undefined,
            }
          : null,
      wsSettings:
        network === 'ws' || network === 'httpupgrade'
          ? {
              path: values.wsPath || '/',
              headers: values.wsHost ? { Host: values.wsHost } : undefined,
            }
          : null,
      multiplexSettings:
        values.muxEnabled && values.flow !== 'xtls-rprx-vision'
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
  const isRealityEnabled = form.watch('security') === 'Reality';
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
              <FormDescription>{t('servers.uuidDesc')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="encryption"
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
                  <SelectItem value="none">none</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>{t('servers.vlessEncryptionDesc')}</FormDescription>
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
                  <SelectItem value="Reality">Reality</SelectItem>
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

        {isRealityEnabled && (
          <>
            <FormField
              control={form.control}
              name="tlsServerName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.realityTarget')}</FormLabel>
                  <FormControl>
                    <Input placeholder="www.microsoft.com" {...field} />
                  </FormControl>
                  <FormDescription>{t('servers.realityTargetDesc')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="realityPublicKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Public Key</FormLabel>
                  <FormControl>
                    <Input placeholder={t('servers.publicKeyPlaceholder')} {...field} />
                  </FormControl>
                  <FormDescription>{t('servers.publicKeyDesc')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="realityShortId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.shortId')}</FormLabel>
                  <FormControl>
                    <Input placeholder={t('servers.shortIdPlaceholder')} {...field} />
                  </FormControl>
                  <FormDescription>{t('servers.shortIdDesc')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="tlsFingerprint"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>TLS 指纹</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="选择 TLS 指纹" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">{t('servers.none', '无')}</SelectItem>
                      <SelectItem value="chrome">Chrome</SelectItem>
                      <SelectItem value="firefox">Firefox</SelectItem>
                      <SelectItem value="safari">Safari</SelectItem>
                      <SelectItem value="edge">Edge</SelectItem>
                      <SelectItem value="ios">iOS</SelectItem>
                      <SelectItem value="android">Android</SelectItem>
                      <SelectItem value="random">随机</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>uTLS 客户端指纹伪装</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flow"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Flow ({t('servers.optional')})</FormLabel>
                  <Select
                    onValueChange={(v) => field.onChange(v === '_none' ? '' : v)}
                    value={field.value || '_none'}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={t('servers.selectFlow', 'Select Flow')} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="_none">{t('servers.none')}</SelectItem>
                      <SelectItem value="xtls-rprx-vision">xtls-rprx-vision</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {t(
                      'servers.flowDesc',
                      'XTLS flow control, Reality recommends xtls-rprx-vision'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
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

        <MultiplexFields
          control={form.control}
          t={t}
          disabled={form.watch('flow') === 'xtls-rprx-vision'}
          disabledReason={t(
            'servers.multiplexVisionConflict',
            'Multiplex 与 xtls-rprx-vision flow 不兼容，已禁用。'
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
