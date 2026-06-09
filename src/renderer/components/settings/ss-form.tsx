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
import { Loader2, Shield } from 'lucide-react';
import { MultiplexFields } from './shared/anti-censor-fields';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createSsSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    method: z.string().min(1, t('servers.methodRequired')),
    password: z.string().min(1, t('servers.passwordRequired')),
    plugin: z.string().optional(),
    pluginOptions: z.string().optional(),
    remarks: z.string().optional(),
    // Shadow-TLS v3
    enableShadowTls: z.boolean(),
    shadowTlsPassword: z.string().optional(),
    shadowTlsSni: z.string().optional(),
    shadowTlsFingerprint: z.string().optional(),
    shadowTlsPort: z.number().optional(),
    muxEnabled: z.boolean().optional(),
    muxProtocol: z.enum(['h2mux', 'smux', 'yamux']).optional(),
    muxMaxConnections: z.number().optional(),
    muxMinStreams: z.number().optional(),
    muxPadding: z.boolean().optional(),
  });

type SsFormValues = z.infer<ReturnType<typeof createSsSchema>>;

interface SsFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

const COMMON_METHODS = [
  'aes-128-gcm',
  'aes-256-gcm',
  'chacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
  'aes-128-cfb',
  'aes-192-cfb',
  'aes-256-cfb',
  'aes-128-ctr',
  'aes-192-ctr',
  'aes-256-ctr',
  'rc4-md5',
  'chacha20-ietf',
  'xchacha20-ietf-poly1305',
];

const CIPHER_ALIASES: Record<string, string> = {
  'chacha20-poly1305': 'chacha20-ietf-poly1305',
  'xchacha20-poly1305': 'xchacha20-ietf-poly1305',
};

function normalizeMethod(raw: string | undefined): string {
  if (!raw) return 'aes-256-gcm';
  const lower = raw.toLowerCase().trim();
  const aliased = CIPHER_ALIASES[lower] ?? lower;
  return COMMON_METHODS.find((m) => m === aliased) ?? aliased;
}

export function SsForm({ serverConfig, onSubmit }: SsFormProps) {
  const { t } = useTranslation();
  const ssFormSchema = createSsSchema(t);

  const isSs = serverConfig?.protocol?.toLowerCase() === 'shadowsocks';
  const hasShadowTls = isSs && !!serverConfig?.shadowTlsSettings;

  const form = useForm<SsFormValues>({
    resolver: zodResolver(ssFormSchema),
    defaultValues: {
      address: isSs ? (serverConfig?.address ?? '') : '',
      port: isSs ? (serverConfig?.port ?? 8388) : 8388,
      method: normalizeMethod(isSs ? serverConfig?.shadowsocksSettings?.method : undefined),
      password: isSs ? (serverConfig?.shadowsocksSettings?.password ?? '') : '',
      plugin: isSs ? (serverConfig?.shadowsocksSettings?.plugin ?? '') : '',
      pluginOptions: isSs ? (serverConfig?.shadowsocksSettings?.pluginOptions ?? '') : '',
      remarks: isSs ? (serverConfig?.name ?? '') : '',
      enableShadowTls: hasShadowTls,
      shadowTlsPassword: hasShadowTls ? (serverConfig?.shadowTlsSettings?.password ?? '') : '',
      shadowTlsSni: hasShadowTls ? (serverConfig?.shadowTlsSettings?.sni ?? '') : '',
      shadowTlsFingerprint: hasShadowTls
        ? (serverConfig?.shadowTlsSettings?.fingerprint ?? 'chrome')
        : 'chrome',
      shadowTlsPort: hasShadowTls
        ? (serverConfig?.shadowTlsSettings?.port ?? undefined)
        : undefined,
      muxEnabled: isSs ? serverConfig?.multiplexSettings?.enabled === true : false,
      muxProtocol: isSs
        ? (serverConfig?.multiplexSettings?.protocol as 'h2mux' | 'smux' | 'yamux') || 'h2mux'
        : 'h2mux',
      muxMaxConnections: isSs ? serverConfig?.multiplexSettings?.maxConnections : undefined,
      muxMinStreams: isSs ? serverConfig?.multiplexSettings?.minStreams : undefined,
      muxPadding: isSs ? serverConfig?.multiplexSettings?.padding === true : false,
    },
  });

  const enableShadowTls = form.watch('enableShadowTls');

  const handleSubmit = async (values: SsFormValues) => {
    const config: any = {
      protocol: 'shadowsocks' as const,
      address: values.address,
      port: values.port,
      name: values.remarks || `${values.address}:${values.port}`,
      shadowsocksSettings: {
        method: values.method,
        password: values.password,
        plugin: values.plugin || undefined,
        pluginOptions: values.pluginOptions || undefined,
      },
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

    if (values.enableShadowTls && values.shadowTlsPassword && values.shadowTlsSni) {
      config.shadowTlsSettings = {
        password: values.shadowTlsPassword,
        sni: values.shadowTlsSni,
        fingerprint: values.shadowTlsFingerprint || 'chrome',
        port: values.shadowTlsPort || undefined,
      };
    }

    await onSubmit(config);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <FormField
          control={form.control}
          name="remarks"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('servers.remarks')}</FormLabel>
              <FormControl>
                <Input placeholder={t('servers.remarksPlaceholder')} {...field} />
              </FormControl>
              <FormDescription>{t('servers.remarksDesc')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

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
                  placeholder="8388"
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
          name="method"
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
                  {(() => {
                    const sortedMethods = [...COMMON_METHODS];
                    if (field.value && !COMMON_METHODS.includes(field.value)) {
                      sortedMethods.unshift(field.value);
                    }
                    return sortedMethods.map((method) => (
                      <SelectItem key={method} value={method}>
                        {method}
                      </SelectItem>
                    ));
                  })()}
                </SelectContent>
              </Select>
              <FormDescription>{t('servers.ssEncryptionDesc')}</FormDescription>
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
              <FormDescription>{t('servers.ssPasswordDesc')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="plugin"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {t('servers.plugin')} ({t('servers.optional')})
                </FormLabel>
                <FormControl>
                  <Input placeholder="obfs-local" {...field} />
                </FormControl>
                <FormDescription>{t('servers.pluginDesc')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="pluginOptions"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {t('servers.pluginOptions')} ({t('servers.optional')})
                </FormLabel>
                <FormControl>
                  <Input placeholder="obfs=http;obfs-host=..." {...field} />
                </FormControl>
                <FormDescription>{t('servers.pluginOptionsDesc')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Shadow-TLS v3 */}
        <div className="border rounded-lg p-4 space-y-4">
          <FormField
            control={form.control}
            name="enableShadowTls"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center space-x-3 space-y-0">
                <FormControl>
                  <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
                <div className="space-y-1 leading-none">
                  <FormLabel className="flex items-center gap-1.5 cursor-pointer">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    {t('servers.enableShadowTls', 'Enable Shadow-TLS v3')}
                  </FormLabel>
                  <FormDescription>
                    {t(
                      'servers.enableShadowTlsDesc',
                      'Wrap Shadowsocks with a TLS obfuscation tunnel'
                    )}
                  </FormDescription>
                </div>
              </FormItem>
            )}
          />

          {enableShadowTls && (
            <div className="space-y-4 pt-2 border-t">
              <FormField
                control={form.control}
                name="shadowTlsPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.shadowTlsPassword')}</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder={t('servers.shadowTlsPasswordPlaceholder')}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="shadowTlsSni"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('servers.sniValue')}</FormLabel>
                      <FormControl>
                        <Input placeholder="www.microsoft.com" {...field} />
                      </FormControl>
                      <FormDescription>{t('servers.shadowTlsSniDesc')}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="shadowTlsPort"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {t('servers.realPort')} ({t('servers.optional')})
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          placeholder={t('servers.realPortPlaceholder')}
                          {...field}
                          value={field.value ?? ''}
                          onChange={(e) => {
                            const val = e.target.value;
                            field.onChange(val ? parseInt(val) : undefined);
                          }}
                        />
                      </FormControl>
                      <FormDescription>{t('servers.realPortDesc')}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="shadowTlsFingerprint"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.fingerprint')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
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
            </div>
          )}
        </div>

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
