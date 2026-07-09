import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RefreshCw,
  FileJson,
  ShieldCheck,
  Ban,
  PauseCircle,
  PlayCircle,
  ChevronDown,
  ChevronRight,
  HelpCircle
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Switch } from '@renderer/components/ui/switch'
import { Separator } from '@renderer/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useChatStore } from '@renderer/stores/chat-store'
import { useHooksStore } from '@renderer/stores/hooks-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import {
  HOOK_EVENT_NAMES,
  type HookDefinitionView,
  type HookEventName,
  type HooksListArgs,
  type HookTrustStatus
} from '../../../../shared/hooks/types'

const STATUS_CLASS: Record<HookTrustStatus, string> = {
  pending: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  trusted: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  denied: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  disabled: 'border-muted-foreground/30 bg-muted text-muted-foreground',
  invalid: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  changed: 'border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300'
}

export function HooksPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [collapsedEvents, setCollapsedEvents] = useState<Set<HookEventName>>(() => new Set())
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const sessions = useChatStore((state) => state.sessions)
  const hooksEnabled = useSettingsStore((state) => state.hooksEnabled)
  const updateSettings = useSettingsStore((state) => state.updateSettings)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const context = useMemo<HooksListArgs>(
    () => ({
      sessionId: activeSession?.id,
      projectId: activeSession?.projectId,
      projectRoot: activeSession?.workingFolder,
      sshConnectionId: activeSession?.sshConnectionId ?? null
    }),
    [
      activeSession?.id,
      activeSession?.projectId,
      activeSession?.workingFolder,
      activeSession?.sshConnectionId
    ]
  )
  const {
    list,
    loading,
    error,
    load,
    reload,
    trust,
    deny,
    setDisabled,
    openSource,
    openUserConfig
  } = useHooksStore()
  const runtimeEnabled = list?.runtime.enabled ?? hooksEnabled
  const restartRequired = !!list && runtimeEnabled !== hooksEnabled
  const sourceErrors = (list?.sources ?? []).filter((source) => source.error)
  const hookGroups = useMemo(
    () =>
      HOOK_EVENT_NAMES.map((eventName) => ({
        eventName,
        hooks: (list?.hooks ?? []).filter((hook) => hook.eventName === eventName)
      })),
    [list?.hooks]
  )

  useEffect(() => {
    void load(context)
  }, [context, load])

  const handleAction = async (action: () => Promise<void>, success: string): Promise<void> => {
    try {
      await action()
      toast.success(success)
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const toggleEvent = (eventName: HookEventName): void => {
    setCollapsedEvents((current) => {
      const next = new Set(current)
      if (next.has(eventName)) {
        next.delete(eventName)
      } else {
        next.add(eventName)
      }
      return next
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('hooks.title', { defaultValue: 'Hooks' })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('hooks.subtitle', {
              defaultValue: 'Manage OpenCowork lifecycle hooks.'
            })}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reload(context)}
            disabled={loading}
          >
            <RefreshCw className="mr-2 size-4" />
            {t('hooks.actions.refresh', { defaultValue: 'Refresh' })}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void openUserConfig()}>
            <FileJson className="mr-2 size-4" />
            {t('hooks.actions.openConfig', { defaultValue: 'Open user config' })}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-3 text-sm">
          {error}
        </div>
      )}

      <section className="rounded-2xl border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium">
                {t('hooks.feature.title', { defaultValue: 'Enable hooks' })}
              </h2>
              <Badge variant="secondary">
                {t('hooks.feature.preview', { defaultValue: 'Preview' })}
              </Badge>
              <Badge variant={runtimeEnabled ? 'outline' : 'secondary'}>
                {runtimeEnabled
                  ? t('hooks.feature.runtimeOn', { defaultValue: 'Active this session' })
                  : t('hooks.feature.runtimeOff', { defaultValue: 'Inactive this session' })}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('hooks.feature.description', {
                defaultValue: 'Takes effect after restarting OpenCowork.'
              })}
            </p>
            {restartRequired && (
              <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                {hooksEnabled
                  ? t('hooks.feature.restartToEnable', {
                      defaultValue: 'Restart OpenCowork to start running hooks.'
                    })
                  : t('hooks.feature.restartToDisable', {
                      defaultValue:
                        'Hooks remain active in this app session. Restart OpenCowork to stop running them.'
                    })}
              </p>
            )}
          </div>
          <Switch
            checked={hooksEnabled}
            onCheckedChange={(checked) => updateSettings({ hooksEnabled: checked })}
            aria-label={t('hooks.feature.title', { defaultValue: 'Enable hooks' })}
          />
        </div>
      </section>

      {sourceErrors.length > 0 && (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-300">
          {sourceErrors.map((source) => (
            <div key={source.id}>{source.error}</div>
          ))}
        </div>
      )}

      <section className="rounded-2xl border bg-card shadow-sm">
        <div className="flex items-center justify-between gap-3 p-4">
          <div className="font-medium">{t('hooks.list.title', { defaultValue: 'All hooks' })}</div>
          <Badge variant="secondary">{list?.summary.total ?? 0}</Badge>
        </div>
        <Separator />
        <div className="divide-y">
          {!list && loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {t('hooks.loading', { defaultValue: 'Loading hooks...' })}
            </div>
          ) : (
            hookGroups.map(({ eventName, hooks }) => (
              <HookEventGroup
                key={eventName}
                eventName={eventName}
                hooks={hooks}
                collapsed={collapsedEvents.has(eventName)}
                onToggle={() => toggleEvent(eventName)}
                renderHook={(hook) => (
                  <HookRow
                    key={`${hook.id}:${hook.trustKey}`}
                    hook={hook}
                    onTrust={() =>
                      handleAction(
                        () => trust(hook, context),
                        t('hooks.toasts.trusted', { defaultValue: 'Hook allowed' })
                      )
                    }
                    onDeny={() =>
                      handleAction(
                        () => deny(hook, context),
                        t('hooks.toasts.denied', { defaultValue: 'Hook ignored' })
                      )
                    }
                    onDisable={() =>
                      handleAction(
                        () => setDisabled(hook, hook.trustStatus !== 'disabled', context),
                        hook.trustStatus === 'disabled'
                          ? t('hooks.toasts.enabled', { defaultValue: 'Hook enabled' })
                          : t('hooks.toasts.disabled', { defaultValue: 'Hook disabled' })
                      )
                    }
                    onOpenConfig={() =>
                      handleAction(
                        () => openSource(hook, 'config', context),
                        t('hooks.toasts.opened', { defaultValue: 'Opened source' })
                      )
                    }
                    onOpenArtifact={() =>
                      handleAction(
                        () => openSource(hook, 'artifact', context),
                        t('hooks.toasts.opened', { defaultValue: 'Opened source' })
                      )
                    }
                  />
                )}
              />
            ))
          )}
        </div>
      </section>
    </div>
  )
}

function HookEventGroup({
  eventName,
  hooks,
  collapsed,
  onToggle,
  renderHook
}: {
  eventName: HookEventName
  hooks: HookDefinitionView[]
  collapsed: boolean
  onToggle: () => void
  renderHook: (hook: HookDefinitionView) => React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('settings')

  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-muted/40"
        onClick={onToggle}
      >
        <div className="flex min-w-0 items-center gap-2">
          {collapsed ? (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="font-medium">{eventName}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={(event) => event.stopPropagation()}
              >
                <HelpCircle className="size-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent>{t(`hooks.events.${eventName}.description`)}</TooltipContent>
          </Tooltip>
        </div>
        <Badge variant={hooks.length > 0 ? 'outline' : 'secondary'}>{hooks.length}</Badge>
      </button>
      {!collapsed && (
        <div className="border-t bg-muted/10">
          {hooks.length === 0 ? (
            <div className="p-5 pl-10 text-sm text-muted-foreground">
              {t('hooks.emptyForEvent', { defaultValue: 'No hooks for this lifecycle event.' })}
            </div>
          ) : (
            <div className="divide-y">{hooks.map(renderHook)}</div>
          )}
        </div>
      )}
    </div>
  )
}

function HookRow({
  hook,
  onTrust,
  onDeny,
  onDisable,
  onOpenConfig,
  onOpenArtifact
}: {
  hook: HookDefinitionView
  onTrust: () => void
  onDeny: () => void
  onDisable: () => void
  onOpenConfig: () => void
  onOpenArtifact: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const canReview = hook.trustStatus !== 'invalid' && !hook.configDisabled
  const canToggle = !hook.configDisabled
  const artifact = hook.artifactHashes[0]
  return (
    <div className="p-4 pl-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={STATUS_CLASS[hook.trustStatus]} variant="outline">
              {t(`hooks.status.${hook.trustStatus}`, { defaultValue: hook.trustStatus })}
            </Badge>
            <span className="text-xs text-muted-foreground">matcher: {hook.matcher || '*'}</span>
          </div>
          <div className="mt-2 break-all rounded-xl bg-muted/50 p-3 font-mono text-xs">
            {hook.resolvedCommand}
          </div>
          <div className="mt-2 grid gap-1 text-xs text-muted-foreground md:grid-cols-2">
            <div className="truncate">cwd: {hook.resolvedCwd}</div>
            <div>timeout: {hook.timeoutSeconds}s</div>
            <div className="truncate">definition: {hook.definitionHash.slice(0, 16)}</div>
            <div className="truncate">
              artifact: {artifact ? `${artifact.status}:${artifact.hash.slice(0, 16)}` : 'none'}
            </div>
          </div>
          {hook.validationErrors.length > 0 && (
            <div className="mt-2 space-y-1 text-xs text-red-600 dark:text-red-300">
              {hook.validationErrors.map((item) => (
                <div key={item}>{item}</div>
              ))}
            </div>
          )}
          {hook.lastRun && (
            <div className="mt-2 text-xs text-muted-foreground">
              last run: {hook.lastRun.status} · {new Date(hook.lastRun.startedAt).toLocaleString()}
            </div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={!canReview} onClick={onTrust}>
            <ShieldCheck className="mr-2 size-4" />
            {t('hooks.actions.trust', { defaultValue: 'Trust' })}
          </Button>
          <Button size="sm" variant="outline" disabled={!canReview} onClick={onDeny}>
            <Ban className="mr-2 size-4" />
            {t('hooks.actions.deny', { defaultValue: 'Deny' })}
          </Button>
          <Button size="sm" variant="outline" disabled={!canToggle} onClick={onDisable}>
            {hook.trustStatus === 'disabled' ? (
              <PlayCircle className="mr-2 size-4" />
            ) : (
              <PauseCircle className="mr-2 size-4" />
            )}
            {hook.trustStatus === 'disabled'
              ? t('hooks.actions.enable', { defaultValue: 'Enable' })
              : t('hooks.actions.disable', { defaultValue: 'Disable' })}
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenConfig}>
            {t('hooks.actions.openConfigShort', { defaultValue: 'Config' })}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onOpenArtifact}
            disabled={!artifact || artifact.status === 'untracked'}
          >
            {t('hooks.actions.openArtifact', { defaultValue: 'Script' })}
          </Button>
        </div>
      </div>
    </div>
  )
}
