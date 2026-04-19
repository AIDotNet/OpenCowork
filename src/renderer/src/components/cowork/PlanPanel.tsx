import { ClipboardList, FileText, Loader2, PenLine, CheckCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Separator } from '@renderer/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/textarea'
import { usePlanStore, type Plan, type PlanStatus } from '@renderer/stores/plan-store'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  sendImplementPlan,
  sendImplementPlanInNewSession,
  sendPlanRevision
} from '@renderer/hooks/use-chat-actions'
import { cn } from '@renderer/lib/utils'

function StatusBadge({ status }: { status: PlanStatus }): React.JSX.Element {
  const colorMap: Record<PlanStatus, string> = {
    drafting: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    awaiting_review: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    approved: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20',
    implementing: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
    completed: 'bg-muted text-muted-foreground border-border',
    rejected: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20'
  }
  const labelMap: Record<PlanStatus, string> = {
    drafting: 'Drafting',
    awaiting_review: 'Awaiting Review',
    approved: 'Approved',
    implementing: 'Implementing',
    completed: 'Completed',
    rejected: 'Rejected'
  }
  return (
    <Badge variant="outline" className={cn('text-[10px] font-medium', colorMap[status])}>
      {labelMap[status]}
    </Badge>
  )
}

async function readPlanContent(filePath?: string): Promise<string> {
  if (!filePath) return ''
  const result = await ipcClient.invoke(IPC.FS_READ_FILE, { path: filePath })
  if (result && typeof result === 'object' && 'error' in result) {
    return ''
  }
  return typeof result === 'string' ? result : ''
}

function PlanContent({ plan, content }: { plan: Plan; content: string }): React.JSX.Element {
  const { t } = useTranslation(['cowork', 'common'])
  const planMode = useUIStore((s) => s.planMode)
  const enterPlanMode = useUIStore((s) => s.enterPlanMode)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const hasStreamingMessage = useChatStore((s) =>
    activeSessionId ? Boolean(s.streamingMessages[activeSessionId]) : false
  )
  const isRunning = useAgentStore((s) => s.isSessionActive(activeSessionId)) || hasStreamingMessage
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectFeedback, setRejectFeedback] = useState('')

  const canExecute = !!content.trim() && plan.status === 'awaiting_review' && !isRunning
  const canReject = canExecute
  const canEdit =
    !planMode &&
    !isRunning &&
    ['awaiting_review', 'approved', 'implementing', 'rejected'].includes(plan.status)

  const handleConfirmExecute = (): void => {
    void sendImplementPlan(plan.id)
  }

  const handleExecuteInNewSession = (): void => {
    void sendImplementPlanInNewSession(plan.id)
  }

  const handleEditPlan = (): void => {
    usePlanStore.getState().setActivePlan(plan.id)
    usePlanStore.getState().updatePlan(plan.id, { status: 'drafting' })
    enterPlanMode(plan.sessionId)
  }

  const handleRejectConfirm = (): void => {
    const feedback = rejectFeedback.trim()
    if (!feedback) return
    setRejectOpen(false)
    setRejectFeedback('')
    sendPlanRevision(plan.id, feedback)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FileText className="size-4 shrink-0 text-violet-500" />
            <h3 className="text-sm font-medium truncate">{plan.title}</h3>
          </div>
          {plan.filePath && (
            <p className="mt-1 text-[10px] text-muted-foreground truncate">{plan.filePath}</p>
          )}
        </div>
        <StatusBadge status={plan.status} />
      </div>

      <Separator />

      <div className="space-y-2">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
          {t('plan.content', { defaultValue: 'Plan Content' })}
        </p>
        {content.trim() ? (
          <div className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed max-h-[400px] overflow-y-auto rounded-md border border-border/50 bg-muted/30 p-3">
            {content}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground/70">
            {t('plan.noContent', { defaultValue: 'No plan content saved yet.' })}
          </p>
        )}
        {plan.status === 'rejected' && (
          <p className="text-xs text-red-600/80">
            {t('plan.rejectedHint', { defaultValue: 'Plan rejected. Provide feedback to revise.' })}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        {canExecute && (
          <>
            <Button
              size="sm"
              className="h-7 gap-1.5 bg-green-600 hover:bg-green-700 text-white"
              onClick={handleConfirmExecute}
            >
              <CheckCircle className="size-3" />
              {t('plan.confirmExecute', { defaultValue: 'Confirm Execute' })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5"
              onClick={handleExecuteInNewSession}
            >
              {t('plan.executeInNewSession', { defaultValue: 'New Session Execute' })}
            </Button>
            {canReject && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5"
                onClick={() => setRejectOpen(true)}
              >
                {t('plan.reject', { defaultValue: 'Reject' })}
              </Button>
            )}
          </>
        )}
        {canEdit && (
          <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={handleEditPlan}>
            <PenLine className="size-3" />
            {t('plan.edit', { defaultValue: 'Edit Plan' })}
          </Button>
        )}
      </div>

      {(plan.status === 'drafting' || plan.status === 'rejected') && planMode && (
        <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/5 rounded-md px-3 py-2">
          <Loader2 className="size-3.5 animate-spin" />
          {t('plan.drafting', { defaultValue: 'Plan is being drafted...' })}
        </div>
      )}

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('plan.rejectTitle', { defaultValue: 'Reject Plan' })}</DialogTitle>
            <DialogDescription>
              {t('plan.rejectDesc', { defaultValue: 'Explain why the plan should be revised.' })}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectFeedback}
            onChange={(event) => setRejectFeedback(event.target.value)}
            placeholder={t('plan.rejectPlaceholder', {
              defaultValue: 'Add feedback for a revised plan...'
            })}
            className="min-h-[100px]"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>
              {t('action.cancel', { ns: 'common', defaultValue: 'Cancel' })}
            </Button>
            <Button
              variant="destructive"
              onClick={handleRejectConfirm}
              disabled={!rejectFeedback.trim()}
            >
              {t('plan.rejectConfirm', { defaultValue: 'Reject Plan' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function PlanPanel(): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const planSummary = usePlanStore(
    useShallow((s) => {
      if (!activeSessionId) return undefined
      return s.getPlanBySession(activeSessionId)
    })
  )
  const planMode = useUIStore((s) => s.planMode)
  const enterPlanMode = useUIStore((s) => s.enterPlanMode)
  const hasStreamingMessage = useChatStore((s) =>
    activeSessionId ? Boolean(s.streamingMessages[activeSessionId]) : false
  )
  const isRunning = useAgentStore((s) => s.isSessionActive(activeSessionId)) || hasStreamingMessage

  const [plan, setPlan] = useState<Plan | undefined>(planSummary)
  const [content, setContent] = useState('')

  useEffect(() => {
    setPlan(planSummary)
  }, [planSummary])

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    const load = async (): Promise<void> => {
      if (!activeSessionId || !planSummary?.id) {
        setPlan(planSummary)
        setContent('')
        return
      }

      const loadedPlan = await usePlanStore.getState().loadPlanForSession(activeSessionId)
      if (cancelled) return
      const nextPlan = loadedPlan ?? planSummary
      setPlan(nextPlan)

      const nextContent = await readPlanContent(nextPlan?.filePath)
      if (!cancelled) {
        setContent(nextContent)
      }

      const watchedFilePath = nextPlan?.filePath
      if (watchedFilePath) {
        await ipcClient.invoke(IPC.FS_WATCH_FILE, { path: watchedFilePath })
        unsubscribe = ipcClient.on(IPC.FS_FILE_CHANGED, (payload) => {
          const changedPath =
            payload && typeof payload === 'object' && 'path' in (payload as Record<string, unknown>)
              ? String((payload as { path?: unknown }).path ?? '')
              : ''
          if (changedPath !== watchedFilePath) return
          void readPlanContent(watchedFilePath).then((updated) => {
            if (!cancelled) {
              setContent(updated)
            }
          })
        })
      }
    }

    void load()

    return () => {
      cancelled = true
      if (planSummary?.filePath) {
        void ipcClient.invoke(IPC.FS_UNWATCH_FILE, { path: planSummary.filePath })
      }
      unsubscribe?.()
    }
  }, [activeSessionId, planSummary, planSummary?.id, planSummary?.filePath])

  if (!plan) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <ClipboardList className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          {t('plan.noPlan', { defaultValue: 'No plan for this session' })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          {t('plan.noPlanDesc', {
            defaultValue: 'Enter Plan Mode to create an implementation plan before coding.'
          })}
        </p>
        {!planMode && !isRunning && (
          <Button
            variant="outline"
            size="sm"
            className="mt-4 h-7 gap-1.5 text-xs"
            onClick={() => enterPlanMode(activeSessionId)}
          >
            <ClipboardList className="size-3" />
            {t('plan.enterPlanMode', { defaultValue: 'Enter Plan Mode' })}
          </Button>
        )}
      </div>
    )
  }

  return <PlanContent plan={plan} content={content} />
}
