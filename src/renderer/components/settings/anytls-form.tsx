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
import { EchField } from './shared/anti-censor-fields';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

// 注意：zod schema 在组件外，我们需要在组件内使用 useTranslation 或者保留这里，并在渲染时翻译错误。
// 为了简单起见，这里我们保持默认中文，并在下面使用 t() 覆盖，或者直接在 FormMessage 处处理（比较复杂）。
// 更好的做法是将 schema 的构建移到组件内部，或者接受 t 函数。
// 这里我们将 schema 的构建移到组件内部，以便使用 t()。
// 所以我们移除外部定义的 schema。
// 我们可以创建一个动态创建 schema 的函数
const createAnyTlsSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    password: z.string().min(1, t('servers.passwordRequired')),
    security: z.enum(['tls', 'reality']),
    tlsServerName: z.string().optional(),
    tlsFingerprint: z.string().optional(),
    tlsAllowInsecure: z.boolean(),
    realityPublicKey: z.string().optional(),
    realityShortId: z.string().optional(),
    ech: z.boolean().optional(),
  });

type AnyTlsFormValues = z.infer<ReturnType<typeof createAnyTlsSchema>>;

interface AnyTlsFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function AnyTlsForm({ serverConfig, onSubmit }: AnyTlsFormProps) {
  const { t } = useTranslation();
  const anyTlsFormSchema = createAnyTlsSchema(t);

  const getDefaultValues = (): AnyTlsFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'anytls') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        password: serverConfig.password || '',
        security: (serverConfig.security === 'reality' ? 'reality' : 'tls') as 'tls' | 'reality',
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsFingerprint: serverConfig.tlsSettings?.fingerprint || 'chrome',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        realityPublicKey: serverConfig.realitySettings?.publicKey || '',
        realityShortId: serverConfig.realitySettings?.shortId || '',
        ech: serverConfig.tlsSettings?.ech === true,
      };
    }
    return {
      address: '',
      port: 443,
      password: '',
      security: 'tls',
      tlsServerName: '',
      tlsFingerprint: 'chrome',
      tlsAllowInsecure: false,
      realityPublicKey: '',
      realityShortId: '',
      ech: false,
    };
  };

  const form = useForm<AnyTlsFormValues>({
    resolver: zodResolver(anyTlsFormSchema),
    defaultValues: getDefaultValues(),
  });

  useEffect(() => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'anytls') {
      form.reset(getDefaultValues());
    }
  }, [serverConfig]);

  const handleSubmit = async (values: AnyTlsFormValues) => {
    const config: any = {
      protocol: 'anytls' as const,
      address: values.address,
      port: values.port,
      password: values.password,
      security: values.security,
      tlsSettings: {
        serverName: values.tlsServerName?.trim() || undefined,
        fingerprint: values.tlsFingerprint || 'chrome',
        allowInsecure: values.security === 'tls' ? values.tlsAllowInsecure : false,
        ech: values.ech ? true : undefined,
      },
    };

    if (values.security === 'reality') {
      config.realitySettings = {
        publicKey: values.realityPublicKey?.trim() || '',
        shortId: values.realityShortId?.trim() || undefined,
      };
    }

    await onSubmit(config);
  };

  const isTls = form.watch('security') === 'tls';
  const isReality = form.watch('security') === 'reality';

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
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="security"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('servers.securityType')}</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="tls">TLS</SelectItem>
                  <SelectItem value="reality">Reality</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>{t('servers.securityTypeDesc')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* TLS 配置 */}
        {isTls && (
          <>
            <FormField
              control={form.control}
              name="tlsServerName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>SNI ({t('servers.optional')})</FormLabel>
                  <FormControl>
                    <Input placeholder="example.com" {...field} />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'servers.sniDesc',
                      'TLS Server Name Indication, leave blank to use server address'
                    )}
                  </FormDescription>
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

        {/* Reality 配置 */}
        {isReality && (
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
                  <FormMessage />
                </FormItem>
              )}
            />
          </>
        )}

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
