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
import { Loader2 } from 'lucide-react';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createSnellSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired', 'Address is required')),
    port: z.number().min(1).max(65535),
    psk: z.string().min(1, t('servers.passwordRequired', 'Password/PSK is required')),
    version: z.number().min(1).max(5),
    obfs: z.enum(['none', 'http', 'tls']),
    obfsHost: z.string().optional(),
    remarks: z.string().optional(),
  });

type SnellFormValues = z.infer<ReturnType<typeof createSnellSchema>>;

interface SnellFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function SnellForm({ serverConfig, onSubmit }: SnellFormProps) {
  const { t } = useTranslation();
  const snellFormSchema = createSnellSchema(t);

  const isSnell = serverConfig?.protocol?.toLowerCase() === 'snell';

  const form = useForm<SnellFormValues>({
    resolver: zodResolver(snellFormSchema),
    defaultValues: {
      address: isSnell ? (serverConfig?.address ?? '') : '',
      port: isSnell ? (serverConfig?.port ?? 50371) : 50371,
      psk: isSnell ? (serverConfig?.snellSettings?.psk ?? '') : '',
      version: isSnell ? (serverConfig?.snellSettings?.version ?? 4) : 4,
      obfs: isSnell ? (serverConfig?.snellSettings?.obfs ?? 'none') : 'none',
      obfsHost: isSnell ? (serverConfig?.snellSettings?.obfsHost ?? '') : '',
      remarks: isSnell ? (serverConfig?.name ?? '') : '',
    },
  });

  const obfsType = form.watch('obfs');

  const handleSubmit = async (values: SnellFormValues) => {
    const config: any = {
      protocol: 'snell' as const,
      address: values.address,
      port: values.port,
      name: values.remarks || `${values.address}:${values.port}`,
      snellSettings: {
        psk: values.psk,
        version: values.version,
        obfs: values.obfs,
        obfsHost: values.obfsHost || undefined,
      },
    };

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
              <FormLabel>{t('servers.remarks', 'Remarks')}</FormLabel>
              <FormControl>
                <Input placeholder={t('servers.remarksPlaceholder', 'My Server')} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('servers.serverAddress', 'Server Address')}</FormLabel>
              <FormControl>
                <Input placeholder="example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="port"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('servers.port', 'Port')}</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  placeholder="50371"
                  {...field}
                  onChange={(e) => field.onChange(parseInt(e.target.value) || 0)}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="psk"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('servers.password', 'Password / PSK')}</FormLabel>
                <FormControl>
                  <Input type="password" placeholder="Pre-shared Key" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="version"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('servers.snellVersion', 'Snell Version')}</FormLabel>
                <Select
                  onValueChange={(v) => field.onChange(parseInt(v))}
                  value={field.value.toString()}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select version" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {[1, 2, 3, 4, 5].map((v) => (
                      <SelectItem key={v} value={v.toString()}>
                        v{v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="obfs"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('servers.obfs', 'Obfuscation')}</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select Obfuscation" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="tls">TLS</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {obfsType !== 'none' && (
          <FormField
            control={form.control}
            name="obfsHost"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('servers.obfsHost', 'Obfs Host')}</FormLabel>
                <FormControl>
                  <Input placeholder="bing.com" {...field} />
                </FormControl>
                <FormDescription>
                  {t('servers.obfsHostDesc', 'Host used for obfuscation')}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <div className="flex gap-4">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('common.save', 'Save')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => form.reset()}
            disabled={form.formState.isSubmitting}
          >
            {t('common.reset', 'Reset')}
          </Button>
        </div>
      </form>
    </Form>
  );
}
