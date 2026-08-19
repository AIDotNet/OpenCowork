import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Ban, CircleCheck, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { SettingsPanel, SettingsSection } from './settings-primitives'
import {
  createPermissionRuleId,
  isCommandRuleTool,
  validatePermissionRulePattern,
  type PermissionPolicy,
  type PermissionRule,
  type PermissionRuleMode
} from '../../../../shared/permission-policy'

const SUGGESTED_WHITELIST_TOOLS = ['Write', 'Edit', 'Delete', 'NotebookEdit']

export function PermissionPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const policy = useSettingsStore((state) => state.permissionPolicy)
  const autoApprove = useSettingsStore((state) => state.autoApprove)
  const updateSettings = useSettingsStore((state) => state.updateSettings)
  const [toolInput, setToolInput] = useState('')

  const setPolicy = (next: PermissionPolicy): void => {
    updateSettings({ permissionPolicy: next })
  }

  const addTool = (name: string): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (policy.whitelistedTools.includes(trimmed)) {
      toast.warning(t('permission.tools.duplicate'))
      return
    }
    setPolicy({ ...policy, whitelistedTools: [...policy.whitelistedTools, trimmed] })
    setToolInput('')
  }

  const removeTool = (name: string): void => {
    setPolicy({
      ...policy,
      whitelistedTools: policy.whitelistedTools.filter((entry) => entry !== name)
    })
  }

  const suggestions = SUGGESTED_WHITELIST_TOOLS.filter(
    (name) => !policy.whitelistedTools.includes(name)
  )
  const hasCommandToolWhitelisted = policy.whitelistedTools.some((entry) =>
    isCommandRuleTool(entry)
  )

  return (
    <SettingsPanel title={t('permission.title')} description={t('permission.subtitle')}>
      <SettingsSection
        id="auto-approve"
        tone={autoApprove ? 'danger' : 'default'}
        title={t('general.autoApprove')}
        description={t('general.autoApproveDesc')}
        actions={
          <Switch
            checked={autoApprove}
            onCheckedChange={async (checked) => {
              if (checked) {
                const ok = await confirm({ title: t('general.autoApproveWarning') })
                if (!ok) return
              }
              updateSettings({ autoApprove: checked })
            }}
          />
        }
      >
        {autoApprove ? (
          <p className="text-xs text-destructive">{t('general.autoApproveWarning')}</p>
        ) : null}
      </SettingsSection>

      <SettingsSection
        id="whitelist-master"
        title={t('permission.master.title')}
        description={t('permission.master.description')}
        actions={
          <Switch
            checked={policy.enabled}
            onCheckedChange={(checked) => setPolicy({ ...policy, enabled: checked })}
          />
        }
      >
        <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
          <p>{t('permission.precedence.description')}</p>
          <p className="mt-2">{t('permission.wildcardHelp')}</p>
        </div>
      </SettingsSection>

      <SettingsSection
        id="whitelist"
        icon={<ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" />}
        title={t('permission.tools.title')}
        description={t('permission.tools.description')}
        actions={<Badge variant="secondary">{policy.whitelistedTools.length}</Badge>}
      >
        {hasCommandToolWhitelisted && (
          <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
            {t('permission.tools.commandToolWarning')}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {policy.whitelistedTools.length === 0 && (
            <span className="text-sm text-muted-foreground">{t('permission.tools.empty')}</span>
          )}
          {policy.whitelistedTools.map((name) => (
            <Badge key={name} variant="outline" className="gap-1 pr-1 font-mono">
              {name}
              <button
                type="button"
                className="rounded-sm p-0.5 hover:bg-muted"
                aria-label={t('permission.tools.remove', { tool: name })}
                onClick={() => removeTool(name)}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={toolInput}
            placeholder={t('permission.tools.placeholder')}
            className="max-w-72 font-mono text-xs"
            onChange={(event) => setToolInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addTool(toolInput)
            }}
          />
          <Button variant="outline" size="sm" onClick={() => addTool(toolInput)}>
            <Plus className="mr-1 size-4" />
            {t('permission.tools.add')}
          </Button>
        </div>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t('permission.tools.suggestions')}
            </span>
            {suggestions.map((name) => (
              <button key={name} type="button" onClick={() => addTool(name)}>
                <Badge variant="secondary" className="cursor-pointer font-mono hover:bg-muted">
                  {name}
                </Badge>
              </button>
            ))}
          </div>
        )}
      </SettingsSection>

      <RuleListSection
        sectionId="bash-rules"
        icon={<CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />}
        title={t('permission.bashAllow.title')}
        description={t('permission.bashAllow.description')}
        rules={policy.bashAllowRules}
        onChange={(rules) => setPolicy({ ...policy, bashAllowRules: rules })}
      />

      <RuleListSection
        sectionId="bash-deny-rules"
        icon={<Ban className="size-4 text-red-600 dark:text-red-400" />}
        title={t('permission.bashDeny.title')}
        description={t('permission.bashDeny.description')}
        rules={policy.bashDenyRules}
        onChange={(rules) => setPolicy({ ...policy, bashDenyRules: rules })}
      />
    </SettingsPanel>
  )
}

function RuleListSection(props: {
  sectionId: string
  icon: React.ReactNode
  title: string
  description: string
  rules: PermissionRule[]
  onChange: (rules: PermissionRule[]) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const addRule = (): void => {
    props.onChange([
      ...props.rules,
      { id: createPermissionRuleId(), pattern: '', mode: 'wildcard', enabled: true }
    ])
  }
  const updateRule = (next: PermissionRule): void => {
    props.onChange(props.rules.map((rule) => (rule.id === next.id ? next : rule)))
  }
  const deleteRule = (id: string): void => {
    props.onChange(props.rules.filter((rule) => rule.id !== id))
  }

  return (
    <SettingsSection
      id={props.sectionId}
      icon={props.icon}
      title={props.title}
      description={props.description}
      actions={
        <>
          <Badge variant="secondary">{props.rules.length}</Badge>
          <Button variant="outline" size="sm" onClick={addRule}>
            <Plus className="mr-1 size-4" />
            {t('permission.rules.add')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col divide-y">
        {props.rules.length === 0 && (
          <span className="py-2 text-sm text-muted-foreground">{t('permission.rules.empty')}</span>
        )}
        {props.rules.map((rule) => (
          <RuleRow key={rule.id} rule={rule} onChange={updateRule} onDelete={deleteRule} />
        ))}
      </div>
    </SettingsSection>
  )
}

function RuleRow(props: {
  rule: PermissionRule
  onChange: (rule: PermissionRule) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const { rule } = props
  const error = validatePermissionRulePattern(rule)

  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={rule.pattern}
          placeholder={t('permission.rules.patternPlaceholder')}
          className={`min-w-64 flex-1 font-mono text-xs ${
            error ? 'border-red-500 focus-visible:ring-red-500' : ''
          }`}
          onChange={(event) => props.onChange({ ...rule, pattern: event.target.value })}
        />
        <Select
          value={rule.mode}
          onValueChange={(mode) => props.onChange({ ...rule, mode: mode as PermissionRuleMode })}
        >
          <SelectTrigger className="w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="wildcard">{t('permission.rules.modeWildcard')}</SelectItem>
            <SelectItem value="regex">{t('permission.rules.modeRegex')}</SelectItem>
          </SelectContent>
        </Select>
        <Switch
          checked={rule.enabled}
          onCheckedChange={(enabled) => props.onChange({ ...rule, enabled })}
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('permission.rules.delete')}
          onClick={() => props.onDelete(rule.id)}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">
          {t('permission.rules.invalidPattern', { error })}
        </p>
      )}
    </div>
  )
}
