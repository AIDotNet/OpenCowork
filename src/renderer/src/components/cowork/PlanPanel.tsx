import { ClipboardList, FileText, Loader2, Play, PenLine } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Separator } from '@renderer/components/ui/separator'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/textarea'
import { usePlanStore, type Plan, type PlanStatus } from '@renderer/stores/plan-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { sendImplementPlan, sendPlanRevision } from '@renderer/hooks/use-chat-actions'
import { cn } from '@renderer/lib/utils'

function StatusBadge({ status }: { status: PlanStatus }): React.JSX.Element {
  const colorMap: Record<PlanStatus, string> = {
    drafting: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    approved: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20',
    implementing: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
    completed: 'bg-muted text-muted-foreground border-border',
    rejected: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
  }
  const labelMap: Record<PlanStatus, string> = {
    drafting: 'Drafting',
    approved: 'Approved',
    implementing: 'Implementing',
    completed: 'Completed',
    rejected: 'Rejected',
  }
  return (
    <Badge variant="outline" className={cn('text-[10px] font-medium', colorMap[status])}>
      {labelMap[status]}
    </Badge>
  )
}

function extractPlanSummary(plan: Plan): string[] {
  if (plan.specJson) {
    try {
      const parsed = JSON.parse(plan.specJson) as { summary?: unknown }
      if (Array.isArray(parsed.summary)) {
        const items = parsed.summary.map((item) => String(item).trim()).filter(Boolean)
        if (items.length > 0) return items.slice(0, 6)
      }
    } catch {
      // Ignore malformed specJson
    }
  }

  if (plan.content) {
    const lines = plan.content.split('\n').map((line) => line.trim()).filter(Boolean)
    const bullets = lines
      .filter((line) => /^[-*]\s+/.test(line))
      .map((line) => line.replace(/^[-*]\s+/, '').trim())
    const source = bullets.length > 0 ? bullets : lines
    return source.slice(0, 6)
  }

  return []
}

function PlanContent({ plan }: { plan: Plan }): React.JSX.Element {
  const { t } = useTranslation(['cowork', 'common'])
  const planMode = useUIStore((s) => s.planMode)
  const enterPlanMode = useUIStore((s) => s.enterPlanMode)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const isRunning = useAgentStore((s) => activeSessionId ? s.runningSessions[activeSessionId] === 'running' : false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectFeedback, setRejectFeedback] = useState('')

  const summary = extractPlanSummary(plan)
  const hasSummary = summary.length > 0
  const canApprove = !!plan.content && (plan.status === 'drafting' || plan.status === 'rejected') && !isRunning
  const canReject = canApprove

  const handleImplement = (): void => {
    sendImplementPlan(plan.id)
  }

  const handleEditPlan = (): void => {
    usePlanStore.getState().setActivePlan(plan.id)
    usePlanStore.getState().updatePlan(plan.id, { status: 'drafting' })
    enterPlanMode()
  }

  const handleApprove = (): void => {
    usePlanStore.getState().approvePlan(plan.id)
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
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FileText className="size-4 shrink-0 text-violet-500" />
            <h3 className="text-sm font-medium truncate">{plan.title}</h3>
          </div>
        </div>
        <StatusBadge status={plan.status} />
      </div>

      <Separator />

      {/* Summary */}
      <div className="space-y-2">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
          {t('plan.summary', { defaultValue: 'Plan Summary' })}
        </p>
        {hasSummary ? (
          <ul className="list-disc pl-4 text-xs space-y-1 text-foreground/90">
            {summary.map((item, idx) => (
              <li key={`${plan.id}-summary-${idx}`} className="leading-snug">
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground/70">
            {t('plan.noSummary', { defaultValue: 'No summary saved yet.' })}
          </p>
        )}
        {!plan.content && (
          <p className="text-xs text-muted-foreground/60">
            {t('plan.noContent', { defaultValue: 'No plan content saved yet.' })}
          </p>
        )}
        {plan.status === 'rejected' && (
          <p className="text-xs text-red-600/80">
            {t('plan.rejectedHint', { defaultValue: 'Plan rejected. Provide feedback to revise.' })}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        {canApprove && (
          <>
            <Button
              size="sm"
              className="h-7 gap-1.5 bg-green-600 hover:bg-green-700 text-white"
              onClick={handleApprove}
            >
              {t('plan.approve', { defaultValue: 'Approve' })}
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
        {plan.status === 'approved' && !isRunning && (
          <Button
            size="sm"
            className="h-7 gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
            onClick={handleImplement}
          >
            <Play className="size-3" />
            {t('plan.implement', { defaultValue: 'Implement' })}
          </Button>
        )}
        {(plan.status === 'approved' || plan.status === 'implementing') && !planMode && !isRunning && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5"
            onClick={handleEditPlan}
          >
            <PenLine className="size-3" />
            {t('plan.edit', { defaultValue: 'Edit Plan' })}
          </Button>
        )}
      </div>

      {/* Drafting indicator */}
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
            placeholder={t('plan.rejectPlaceholder', { defaultValue: 'Add feedback for a revised plan...' })}
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
  const plan = usePlanStore((s) => {
    if (!activeSessionId) return undefined
    return Object.values(s.plans).find((p) => p.sessionId === activeSessionId)
  })
  const planMode = useUIStore((s) => s.planMode)
  const enterPlanMode = useUIStore((s) => s.enterPlanMode)
  const isRunning = useAgentStore((s) => activeSessionId ? s.runningSessions[activeSessionId] === 'running' : false)

  if (!plan) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <ClipboardList className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          {t('plan.noPlan', { defaultValue: 'No plan for this session' })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          {t('plan.noPlanDesc', { defaultValue: 'Enter Plan Mode to create an implementation plan before coding.' })}
        </p>
        {!planMode && !isRunning && (
          <Button
            variant="outline"
            size="sm"
            className="mt-4 h-7 gap-1.5 text-xs"
            onClick={() => enterPlanMode()}
          >
            <ClipboardList className="size-3" />
            {t('plan.enterPlanMode', { defaultValue: 'Enter Plan Mode' })}
          </Button>
        )}
      </div>
    )
  }

  return <PlanContent plan={plan} />
}
