import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Pause,
  Pencil,
  Play,
  Plus,
  Save,
  Target,
  Trash2,
  Zap
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { cn } from '@renderer/lib/utils'
import {
  formatGoalElapsedSeconds,
  formatGoalTokens,
  goalStatusLabel,
  validateGoalObjective
} from '@renderer/lib/agent/goal-context'
import {
  EMPTY_SESSION_GOAL_EVENTS,
  useGoalStore,
  type SessionGoal,
  type SessionGoalEvent,
  type SessionGoalEventType
} from '@renderer/stores/goal-store'
import { useChatActions } from '@renderer/hooks/use-chat-actions'

const BLOCKER_EVENT_TYPES = new Set<SessionGoalEventType>([
  'budget_limited',
  'completion_deferred',
  'stall_paused',
  'auto_continue_blocked'
])

function eventMetadataNumber(event: SessionGoalEvent, key: string): number | null {
  const value = event.metadata?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function eventMetadataString(event: SessionGoalEvent, key: string): string | null {
  const value = event.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function useGoalSession(sessionId?: string | null): {
  goal: SessionGoal | undefined
  events: SessionGoalEvent[]
} {
  const goal = useGoalStore((s) => (sessionId ? s.goalsBySession[sessionId] : undefined))
  const events = useGoalStore((s) =>
    sessionId
      ? (s.goalEventsBySession[sessionId] ?? EMPTY_SESSION_GOAL_EVENTS)
      : EMPTY_SESSION_GOAL_EVENTS
  )

  React.useEffect(() => {
    if (!sessionId) return
    void useGoalStore.getState().loadGoalForSession(sessionId)
  }, [sessionId])

  React.useEffect(() => {
    if (!sessionId) return
    void useGoalStore
      .getState()
      .loadGoalEventsForSession(sessionId, { goalId: goal?.goalId, force: true })
  }, [sessionId, goal?.goalId])

  return { goal, events }
}

function statusTone(status?: SessionGoal['status']): string {
  switch (status) {
    case 'active':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
    case 'paused':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300'
    case 'budget_limited':
      return 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300'
    case 'complete':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300'
    default:
      return 'border-border/70 bg-muted/30 text-muted-foreground'
  }
}

function GoalStatusBadge({ status }: { status?: SessionGoal['status'] }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const fallback = status ? goalStatusLabel(status) : 'not set'
  return (
    <span className={cn('rounded border px-1.5 py-0.5 text-[10px]', statusTone(status))}>
      {status ? t(`goal.status.${status}`, { defaultValue: fallback }) : t('goal.notSet')}
    </span>
  )
}

function GoalUsageLine({ goal }: { goal?: SessionGoal }): React.JSX.Element {
  const { t } = useTranslation('chat')
  if (!goal) {
    return <span>{t('goal.noUsage')}</span>
  }
  const tokenText =
    goal.tokenBudget !== undefined && goal.tokenBudget !== null
      ? t('goal.tokensWithBudget', {
          used: formatGoalTokens(goal.tokensUsed),
          budget: formatGoalTokens(goal.tokenBudget)
        })
      : t('goal.tokensOnly', { tokens: formatGoalTokens(goal.tokensUsed) })
  return (
    <>
      <span>{formatGoalElapsedSeconds(goal.timeUsedSeconds)}</span>
      <span>{tokenText}</span>
    </>
  )
}

function formatGoalEvent(
  event: SessionGoalEvent,
  t: TFunction
): {
  title: string
  detail: string | null
} {
  const tokenDelta = eventMetadataNumber(event, 'tokenDelta')
  const timeDelta = eventMetadataNumber(event, 'timeDeltaSeconds')
  const from = eventMetadataString(event, 'from')
  const to = eventMetadataString(event, 'to')

  switch (event.eventType) {
    case 'usage_accounted':
      return {
        title: t('goal.events.usage_accounted'),
        detail:
          tokenDelta !== null || timeDelta !== null
            ? t('goal.events.usageDetail', {
                tokens: formatGoalTokens(tokenDelta ?? 0),
                time: formatGoalElapsedSeconds(timeDelta ?? 0)
              })
            : null
      }
    case 'status_changed':
      return {
        title: t('goal.events.status_changed'),
        detail:
          from && to
            ? t('goal.events.statusDetail', {
                from: t(`goal.status.${from}`, { defaultValue: from }),
                to: t(`goal.status.${to}`, { defaultValue: to })
              })
            : null
      }
    default:
      return {
        title: t(`goal.events.${event.eventType}`, { defaultValue: event.eventType }),
        detail: event.message ?? null
      }
  }
}

function GoalEventTimeline({ events }: { events: SessionGoalEvent[] }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const visibleEvents = events.slice(0, 8)
  if (visibleEvents.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('goal.timelineEmpty')}</p>
  }
  return (
    <div className="space-y-2">
      {visibleEvents.map((event) => {
        const formatted = formatGoalEvent(event, t)
        return (
          <div key={event.id} className="flex gap-2 text-xs">
            <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary/70" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{formatted.title}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {new Date(event.createdAt).toLocaleTimeString()}
                </span>
              </div>
              {formatted.detail ? (
                <p className="mt-0.5 line-clamp-2 break-words text-[11px] text-muted-foreground">
                  {formatted.detail}
                </p>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LatestGoalNotice({ events }: { events: SessionGoalEvent[] }): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const latest = events.find((event) => BLOCKER_EVENT_TYPES.has(event.eventType))
  if (!latest) return null
  const formatted = formatGoalEvent(latest, t)
  return (
    <div className="flex items-start gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
      <span className="line-clamp-2 break-words">{formatted.detail ?? formatted.title}</span>
    </div>
  )
}

function useGoalActions(
  sessionId?: string | null,
  goal?: SessionGoal
): {
  open: boolean
  objectiveDraft: string
  tokenBudgetDraft: string
  saving: boolean
  clearing: boolean
  setOpen: (open: boolean) => void
  setObjectiveDraft: (value: string) => void
  setTokenBudgetDraft: (value: string) => void
  openManager: () => void
  saveGoal: () => Promise<void>
  clearGoal: () => Promise<void>
  setGoalStatus: (status: 'active' | 'paused') => Promise<void>
} {
  const { t } = useTranslation('chat')
  const { t: tCommon } = useTranslation('common')
  const { sendMessage } = useChatActions()
  const [open, setOpen] = React.useState(false)
  const [objectiveDraft, setObjectiveDraft] = React.useState('')
  const [tokenBudgetDraft, setTokenBudgetDraft] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [clearing, setClearing] = React.useState(false)

  const continueGoal = React.useCallback(
    (targetSessionId: string): void => {
      queueMicrotask(() => {
        void sendMessage('', undefined, 'continue', targetSessionId, null)
      })
    },
    [sendMessage]
  )

  const openManager = React.useCallback(() => {
    setObjectiveDraft(goal?.objective ?? '')
    setTokenBudgetDraft(
      goal?.tokenBudget !== undefined && goal.tokenBudget !== null ? String(goal.tokenBudget) : ''
    )
    setOpen(true)
  }, [goal])

  const parseGoalTokenBudget = React.useCallback((): {
    tokenBudget: number | null
    error?: string
  } => {
    const raw = tokenBudgetDraft.trim()
    if (!raw) return { tokenBudget: null }
    if (!/^\d+$/.test(raw)) {
      return { tokenBudget: null, error: t('goal.errors.invalidBudget') }
    }
    const tokenBudget = Number(raw)
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) {
      return { tokenBudget: null, error: t('goal.errors.invalidBudget') }
    }
    return { tokenBudget }
  }, [tokenBudgetDraft, t])

  const setGoalStatus = React.useCallback(
    async (status: 'active' | 'paused'): Promise<void> => {
      if (!sessionId) return
      const result = await useGoalStore.getState().updateGoal(sessionId, { status })
      if (!result.success) {
        toast.error(t('goal.toasts.updateFailed'), { description: result.error })
        return
      }
      if (status === 'active' && result.goal?.status === 'budget_limited') {
        toast.info(t('goal.toasts.budgetStillExhausted'), {
          description: t('goal.toasts.increaseBudget')
        })
        return
      }
      if (status === 'active' && result.goal?.status === 'active') {
        continueGoal(sessionId)
      }
    },
    [continueGoal, sessionId, t]
  )

  const clearGoal = React.useCallback(async (): Promise<void> => {
    if (!sessionId || !goal) return
    const confirmed = await confirm({
      title: t('goal.clearConfirmTitle'),
      description: t('goal.clearConfirmDesc'),
      confirmLabel: tCommon('action.clear'),
      variant: 'destructive'
    })
    if (!confirmed) return
    setClearing(true)
    const result = await useGoalStore.getState().clearGoal(sessionId)
    setClearing(false)
    if (!result.success) {
      toast.error(t('goal.toasts.clearFailed'), { description: result.error })
      return
    }
    setOpen(false)
    setObjectiveDraft('')
    setTokenBudgetDraft('')
  }, [goal, sessionId, t, tCommon])

  const saveGoal = React.useCallback(async (): Promise<void> => {
    if (!sessionId) return
    const objective = objectiveDraft.trim()
    const validation = validateGoalObjective(objective)
    if (validation) {
      toast.error(t('goal.toasts.objectiveInvalid'), { description: validation })
      return
    }
    const budget = parseGoalTokenBudget()
    if (budget.error) {
      toast.error(t('goal.toasts.budgetInvalid'), { description: budget.error })
      return
    }

    setSaving(true)
    const result = goal
      ? await useGoalStore.getState().updateGoal(sessionId, {
          objective,
          tokenBudget: budget.tokenBudget
        })
      : await useGoalStore.getState().setGoal({
          sessionId,
          objective,
          tokenBudget: budget.tokenBudget
        })
    setSaving(false)
    if (!result.success) {
      toast.error(goal ? t('goal.toasts.updateFailed') : t('goal.toasts.createFailed'), {
        description: result.error
      })
      return
    }
    setOpen(false)
    if (result.goal?.status === 'active') {
      continueGoal(sessionId)
    }
  }, [continueGoal, goal, objectiveDraft, parseGoalTokenBudget, sessionId, t])

  return {
    open,
    objectiveDraft,
    tokenBudgetDraft,
    saving,
    clearing,
    setOpen,
    setObjectiveDraft,
    setTokenBudgetDraft,
    openManager,
    saveGoal,
    clearGoal,
    setGoalStatus
  }
}

function GoalManagerDialog({
  goal,
  events,
  actions
}: {
  goal?: SessionGoal
  events: SessionGoalEvent[]
  actions: ReturnType<typeof useGoalActions>
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const { t: tCommon } = useTranslation('common')
  const budgetPct =
    goal?.tokenBudget !== undefined && goal.tokenBudget !== null
      ? Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)
      : null

  return (
    <Dialog open={actions.open} onOpenChange={actions.setOpen}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="size-4" />
            {t('goal.managerTitle')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <div className="rounded-md border border-border/70 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('goal.statusLabel')}
              </div>
              <div className="mt-1 text-sm font-medium">
                <GoalStatusBadge status={goal?.status} />
              </div>
            </div>
            <div className="rounded-md border border-border/70 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('goal.tokensLabel')}
              </div>
              <div className="mt-1 text-sm font-medium">
                {formatGoalTokens(goal?.tokensUsed ?? 0)}
              </div>
            </div>
            <div className="rounded-md border border-border/70 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('goal.budgetLabel')}
              </div>
              <div className="mt-1 text-sm font-medium">
                {goal?.tokenBudget !== undefined && goal.tokenBudget !== null
                  ? formatGoalTokens(goal.tokenBudget)
                  : t('goal.none')}
              </div>
            </div>
            <div className="rounded-md border border-border/70 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('goal.timeLabel')}
              </div>
              <div className="mt-1 text-sm font-medium">
                {formatGoalElapsedSeconds(goal?.timeUsedSeconds ?? 0)}
              </div>
            </div>
          </div>

          {budgetPct !== null ? (
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>{t('goal.budgetProgress')}</span>
                <span>{budgetPct.toFixed(0)}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    budgetPct >= 100 ? 'bg-red-500' : 'bg-emerald-500'
                  )}
                  style={{ width: `${budgetPct}%` }}
                />
              </div>
            </div>
          ) : null}

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t('goal.objectiveLabel')}
            </span>
            <Textarea
              className="min-h-32 resize-y text-sm"
              value={actions.objectiveDraft}
              onChange={(event) => actions.setObjectiveDraft(event.target.value)}
              placeholder={t('goal.objectivePlaceholder')}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t('goal.tokenBudgetLabel')}
            </span>
            <Input
              inputMode="numeric"
              value={actions.tokenBudgetDraft}
              onChange={(event) => actions.setTokenBudgetDraft(event.target.value)}
              placeholder={t('goal.optional')}
            />
          </label>

          <div className="space-y-2 rounded-md border border-border/70 p-3">
            <div className="text-xs font-medium text-muted-foreground">{t('goal.timeline')}</div>
            <GoalEventTimeline events={events} />
          </div>
        </div>
        <DialogFooter className="items-center justify-between gap-2 sm:justify-between">
          <div className="flex items-center gap-1">
            {goal?.status === 'active' ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => void actions.setGoalStatus('paused')}
              >
                <Pause className="size-3.5" />
                {t('goal.pause')}
              </Button>
            ) : goal ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => void actions.setGoalStatus('active')}
              >
                <Play className="size-3.5" />
                {goal.status === 'complete' ? t('goal.start') : t('goal.resume')}
              </Button>
            ) : null}
            {goal && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-destructive"
                disabled={actions.clearing}
                onClick={() => void actions.clearGoal()}
              >
                <Trash2 className="size-3.5" />
                {t('goal.clear')}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => actions.setOpen(false)}
            >
              {tCommon('action.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5"
              disabled={actions.saving}
              onClick={() => void actions.saveGoal()}
            >
              <Save className="size-3.5" />
              {t('goal.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function GoalSessionBar({
  sessionId,
  className
}: {
  sessionId?: string | null
  className?: string
}): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const { goal, events } = useGoalSession(sessionId)
  const actions = useGoalActions(sessionId, goal)

  if (!sessionId) return null

  return (
    <>
      <div
        className={cn(
          'mb-2 rounded-lg border border-border/70 bg-background/80 px-3 py-2 shadow-sm',
          className
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Target className="size-3.5 shrink-0 text-primary/80" />
            <span className="shrink-0 text-xs font-medium">{t('goal.title')}</span>
            <GoalStatusBadge status={goal?.status} />
            {goal ? (
              <span className="min-w-0 truncate text-xs text-foreground/85">{goal.objective}</span>
            ) : (
              <span className="text-xs text-muted-foreground">{t('goal.noSessionGoal')}</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Clock className="size-3" />
            <GoalUsageLine goal={goal} />
          </div>
          <div className="flex items-center gap-1">
            {goal?.status === 'active' ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title={t('goal.pause')}
                onClick={() => void actions.setGoalStatus('paused')}
              >
                <Pause className="size-3.5" />
              </Button>
            ) : goal && goal.status !== 'complete' ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title={t('goal.resume')}
                onClick={() => void actions.setGoalStatus('active')}
              >
                <Play className="size-3.5" />
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              title={goal ? t('goal.manage') : t('goal.set')}
              onClick={actions.openManager}
            >
              {goal ? <Pencil className="size-3.5" /> : <Plus className="size-3.5" />}
              {goal ? t('goal.manage') : t('goal.set')}
            </Button>
          </div>
        </div>
        {goal ? (
          <div className="mt-2">
            <LatestGoalNotice events={events} />
          </div>
        ) : null}
      </div>
      <GoalManagerDialog goal={goal} events={events} actions={actions} />
    </>
  )
}

export function GoalPanelCard({
  sessionId,
  className
}: {
  sessionId?: string | null
  className?: string
}): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const { goal, events } = useGoalSession(sessionId)
  const actions = useGoalActions(sessionId, goal)

  if (!sessionId) return null

  return (
    <>
      <div className={cn('space-y-2', className)}>
        <div className="flex items-center justify-between gap-2">
          <h4 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Target className="size-3.5" />
            {t('goal.title')}
          </h4>
          <GoalStatusBadge status={goal?.status} />
        </div>
        {goal ? (
          <>
            <p className="line-clamp-4 break-words text-xs leading-relaxed text-foreground/85">
              {goal.objective}
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <GoalUsageLine goal={goal} />
            </div>
            <LatestGoalNotice events={events} />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t('goal.noSessionGoal')}</p>
        )}
        <div className="flex items-center gap-1">
          {goal?.status === 'active' ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              title={t('goal.pause')}
              onClick={() => void actions.setGoalStatus('paused')}
            >
              <Pause className="size-3.5" />
            </Button>
          ) : goal && goal.status !== 'complete' ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              title={t('goal.resume')}
              onClick={() => void actions.setGoalStatus('active')}
            >
              <Play className="size-3.5" />
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            title={goal ? t('goal.manage') : t('goal.set')}
            onClick={actions.openManager}
          >
            {goal ? <Pencil className="size-3.5" /> : <Plus className="size-3.5" />}
            {goal ? t('goal.manage') : t('goal.set')}
          </Button>
          {goal && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-destructive/80"
              title={t('goal.clear')}
              onClick={() => void actions.clearGoal()}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
          {goal?.status === 'complete' ? (
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-sky-500">
              <CheckCircle2 className="size-3" />
              {t('goal.completeAudit')}
            </span>
          ) : goal?.status === 'active' ? (
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-emerald-500">
              <Zap className="size-3" />
              {t('goal.autoContinueOn')}
            </span>
          ) : null}
        </div>
      </div>
      <GoalManagerDialog goal={goal} events={events} actions={actions} />
    </>
  )
}
