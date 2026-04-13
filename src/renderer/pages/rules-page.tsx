import { useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { RuleDialog } from '@/components/rules/rule-dialog';
import { DeleteRuleDialog } from '@/components/rules/delete-rule-dialog';
import type { DomainRule } from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import { BypassProcessSettings } from '@/components/settings/bypass-process-settings';

export function RulesPage() {
  const { t } = useTranslation();
  const config = useAppStore((state) => state.config);
  const updateCustomRule = useAppStore((state) => state.updateCustomRule);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<DomainRule | null>(null);
  const [deletingRule, setDeletingRule] = useState<DomainRule | null>(null);

  const customRules = config?.customRules || [];

  const handleToggleRule = async (rule: DomainRule) => {
    await updateCustomRule({
      ...rule,
      enabled: !rule.enabled,
    });
  };

  const handleEditRule = (rule: DomainRule) => {
    setEditingRule(rule);
  };

  const handleDeleteRule = (rule: DomainRule) => {
    setDeletingRule(rule);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">{t('rules.customRules')}</h2>
          <p className="text-muted-foreground mt-1">{t('rules.customRulesDesc')}</p>
        </div>
        <Button onClick={() => setIsAddDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t('rules.addRule')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('rules.ruleList')}</CardTitle>
          <CardDescription>{t('rules.ruleListDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {customRules.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground mb-4">{t('rules.noRules')}</p>
              <Button variant="outline" onClick={() => setIsAddDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                {t('rules.addFirstRule')}
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50px]">{t('rules.enable')}</TableHead>
                  <TableHead>{t('rules.domain')}</TableHead>
                  <TableHead className="w-[160px]">{t('rules.policy')}</TableHead>
                  <TableHead className="w-[120px] text-right">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customRules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell>
                      <Switch
                        checked={rule.enabled}
                        onCheckedChange={() => handleToggleRule(rule)}
                      />
                    </TableCell>
                    <TableCell className="font-mono">
                      <div className="flex flex-col gap-1 max-w-[400px]">
                        {/* Remarks Row */}
                        {rule.remarks && (
                          <div
                            className="text-sm font-semibold truncate text-foreground"
                            title={rule.remarks}
                          >
                            {rule.remarks}
                          </div>
                        )}

                        {/* Domain rows */}
                        {rule.domains.length > 0 && (
                          <div className="text-sm truncate" title={rule.domains.join(', ')}>
                            {rule.domains.length <= 3 ? (
                              rule.domains.join(', ')
                            ) : (
                              <>
                                {rule.domains.slice(0, 3).join(', ')}
                                <span className="text-muted-foreground ml-1">
                                  +{rule.domains.length - 3}
                                </span>
                              </>
                            )}
                          </div>
                        )}

                        {/* IP CIDR rows */}
                        {rule.ipCidr && rule.ipCidr.length > 0 && (
                          <div
                            className="text-xs text-muted-foreground truncate"
                            title={rule.ipCidr.join(', ')}
                          >
                            <Badge
                              variant="outline"
                              className="scale-[0.8] origin-left mr-1 h-4 px-1 py-0 font-sans tracking-tight opacity-70"
                            >
                              IP
                            </Badge>
                            {rule.ipCidr.length <= 3 ? (
                              rule.ipCidr.join(', ')
                            ) : (
                              <>
                                {rule.ipCidr.slice(0, 3).join(', ')}
                                <span className="ml-1">+{rule.ipCidr.length - 3}</span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant={rule.action === 'proxy' ? 'default' : 'secondary'}>
                          {rule.action === 'proxy'
                            ? t('rules.proxy')
                            : rule.action === 'direct'
                              ? t('rules.direct')
                              : t('rules.block')}
                        </Badge>
                        {rule.bypassFakeIP && (
                          <Badge
                            variant="outline"
                            className="text-xs text-muted-foreground whitespace-nowrap"
                          >
                            {t('rules.realDns')}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => handleEditRule(rule)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteRule(rule)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('rules.ruleInstructions')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>{t('rules.instruction1')}</p>
          <p>{t('rules.instruction2')}</p>
          <p>{t('rules.instruction3')}</p>
          <p>{t('rules.instruction4')}</p>
          <p>{t('rules.instruction5')}</p>
          <p dangerouslySetInnerHTML={{ __html: t('rules.instruction6') }} />
        </CardContent>
      </Card>

      {/* Bypass Process Settings */}
      <BypassProcessSettings />

      {/* Add Rule Dialog */}
      <RuleDialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen} mode="add" />

      {/* Edit Rule Dialog */}
      {editingRule && (
        <RuleDialog
          open={!!editingRule}
          onOpenChange={(open: boolean) => !open && setEditingRule(null)}
          mode="edit"
          rule={editingRule}
        />
      )}

      {/* Delete Rule Dialog */}
      {deletingRule && (
        <DeleteRuleDialog
          open={!!deletingRule}
          onOpenChange={(open: boolean) => !open && setDeletingRule(null)}
          rule={deletingRule}
        />
      )}
    </div>
  );
}
