import * as React from 'react'
import Markdown from 'react-markdown'
import {
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  Download,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  PenLine,
  Play,
  TriangleAlert
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/textarea'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { usePlanStore, type Plan, type PlanStatus } from '@renderer/stores/plan-store'
import { useUIStore } from '@renderer/stores/ui-store'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ToolResultContent } from '@renderer/lib/api/types'
import {
  decodeStructuredToolResult,
  isStructuredToolErrorText
} from '@renderer/lib/tools/tool-result-format'
import {
  sendImplementPlan,
  sendImplementPlanInNewSession,
  sendPlanRevision
} from '@renderer/hooks/use-chat-actions'
import {
  PlanExecutionModelSelect,
  resolvePlanExecutionDefaultModel,
  type PlanExecutionModelSelection
} from '@renderer/components/chat/PlanExecuteDialog'
import {
  presentPlanReviewInRightPanel,
  resolveSessionSshConnectionId
} from '@renderer/lib/plan-review-panel'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { cn } from '@renderer/lib/utils'
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from '@renderer/lib/preview/viewers/markdown-components'

interface PlanReviewCardProps {
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  isLive: boolean
  sessionId?: string | null
}

interface PlanReviewPayload {
  awaitingUserReview: boolean
  status: string
  planId: string
  title: string
  content: string
  filePath?: string
  message?: string
}

function outputAsText(output: ToolResultContent | undefined): string {
  if (!output) return ''
  if (typeof output === 'string') return output
  return output
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

function parsePlanReviewPayload(output: ToolResultContent | undefined): PlanReviewPayload | null {
  const text = outputAsText(output)
  if (!text) return null
  const parsed = decodeStructuredToolResult(text)
  if (!parsed || Array.isArray(parsed)) return null

  const planId = typeof parsed.plan_id === 'string' ? parsed.plan_id.trim() : ''
  if (!planId) return null

  return {
    awaitingUserReview: parsed.awaiting_user_review === true,
    status: typeof parsed.status === 'string' ? parsed.status : '',
    planId,
    title: typeof parsed.title === 'string' ? parsed.title : 'Plan',
    content: typeof parsed.content === 'string' ? parsed.content : '',
    filePath: typeof parsed.plan_file_path === 'string' ? parsed.plan_file_path : undefined,
    message: typeof parsed.message === 'string' ? parsed.message : undefined
  }
}

function buildPlanReviewPayloadFromPlan(plan: Plan | undefined): PlanReviewPayload | null {
  if (!plan || plan.status === 'drafting') return null

  return {
    awaitingUserReview: plan.status === 'awaiting_review',
    status: plan.status,
    planId: plan.id,
    title: plan.title,
    content: plan.content ?? '',
    filePath: plan.filePath
  }
}

/**
 * The `plans` row never stores plan content — only the plan file does. So whenever the card falls
 * back to store state (lost plan UI update, dormant-memory release, reopened transcript) the file
 * is the only source for the plan body.
 */
async function readPlanFileContent(
  filePath: string,
  sshConnectionId: string | undefined
): Promise<string> {
  try {
    const result = await ipcClient.invoke(
      sshConnectionId ? IPC.SSH_FS_READ_FILE : IPC.FS_READ_FILE,
      sshConnectionId ? { connectionId: sshConnectionId, path: filePath } : { path: filePath }
    )
    return typeof result === 'string' ? result : ''
  } catch {
    return ''
  }
}

function planDownloadFileName(payload: PlanReviewPayload): string {
  const base = payload.filePath?.split(/[\\/]/).pop()
  if (base) return base
  const slug = payload.title
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'plan'}.md`
}

function downloadPlanMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function getStatusAppearance(status: PlanStatus): {
  badgeClassName: string
  labelKey: string
  defaultValue: string
} {
  switch (status) {
    case 'awaiting_review':
      return {
        badgeClassName: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        labelKey: 'planReview.awaitingReview',
        defaultValue: 'Pending review'
      }
    case 'approved':
      return {
        badgeClassName:
          'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        labelKey: 'planReview.approved',
        defaultValue: 'Approved'
      }
    case 'implementing':
      return {
        badgeClassName: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300',
        labelKey: 'planReview.implementing',
        defaultValue: 'Implementing'
      }
    case 'completed':
      return {
        badgeClassName: 'border-border bg-muted text-muted-foreground',
        labelKey: 'planReview.completed',
        defaultValue: 'Completed'
      }
    case 'rejected':
      return {
        badgeClassName: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
        labelKey: 'planReview.rejected',
        defaultValue: 'Pending revision'
      }
    default:
      return {
        badgeClassName: 'border-border bg-muted text-muted-foreground',
        labelKey: 'planReview.drafting',
        defaultValue: 'Draft'
      }
  }
}

export function PlanReviewCard({
  output,
  status,
  isLive,
  sessionId
}: PlanReviewCardProps): React.JSX.Element {
  const { t } = useTranslation(['chat', 'common'])
  const parsedPayload = React.useMemo(() => parsePlanReviewPayload(output), [output])
  const outputText = React.useMemo(() => outputAsText(output), [output])
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  // The plan actions are gated on the session that owns this card, not on whichever session
  // happens to be in the foreground, so a run elsewhere cannot disable them.
  const cardSessionId = sessionId ?? activeSessionId
  const hasStreamingMessage = useChatStore((s) =>
    cardSessionId ? Boolean(s.streamingMessages[cardSessionId]) : false
  )
  const fallbackPlan = usePlanStore((s) =>
    parsedPayload?.planId
      ? undefined
      : sessionId
        ? s.getPlanBySession(sessionId)
        : activeSessionId
          ? s.getPlanBySession(activeSessionId)
          : undefined
  )
  const payload = parsedPayload ?? buildPlanReviewPayloadFromPlan(fallbackPlan)
  const plan = usePlanStore((s) => (payload?.planId ? s.plans[payload.planId] : undefined))
  const executionSession = useChatStore((s) =>
    payload?.planId ? s.getLatestSessionByPlanId(payload.planId) : undefined
  )
  // Only this session's in-flight turn may hold the actions back, which is exactly what decides
  // whether a send dispatches or queues. `isSessionActive` also counts activity that outlives the
  // turn — a background command left running, an open team, a sub-agent record that never got its
  // end event — and in Cowork mode at least one of those is usually still around when the plan
  // lands, which left Implement stuck on its spinner for the rest of the session.
  const isRunning = useAgentStore((s) => s.isSessionRunActive(cardSessionId)) || hasStreamingMessage

  const executionSessionId = sessionId ?? activeSessionId ?? plan?.sessionId ?? ''
  const [executionModel, setExecutionModel] = React.useState<PlanExecutionModelSelection>(() =>
    resolvePlanExecutionDefaultModel(executionSessionId)
  )
  const [copied, setCopied] = React.useState(false)
  const [revisionOpen, setRevisionOpen] = React.useState(false)
  const [revisionFeedback, setRevisionFeedback] = React.useState('')
  const [filePlanContent, setFilePlanContent] = React.useState('')
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const [contentTruncated, setContentTruncated] = React.useState(false)
  const payloadContent = payload?.content ?? ''
  const planContent = payloadContent || filePlanContent
  const planFilePath = payload?.filePath

  React.useEffect(() => {
    if (!executionSessionId) return
    setExecutionModel(resolvePlanExecutionDefaultModel(executionSessionId))
  }, [executionSessionId, payload?.planId])

  React.useEffect(() => {
    if (payloadContent || !planFilePath) {
      setFilePlanContent('')
      return
    }

    let cancelled = false
    const sshConnectionId = resolveSessionSshConnectionId(sessionId ?? activeSessionId)
    void readPlanFileContent(planFilePath, sshConnectionId).then((loaded) => {
      if (!cancelled) setFilePlanContent(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [activeSessionId, payloadContent, planFilePath, sessionId])

  React.useEffect(() => {
    const el = contentRef.current
    if (!el) {
      setContentTruncated(false)
      return
    }
    const measure = (): void => {
      setContentTruncated(el.scrollHeight > el.clientHeight + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    if (el.firstElementChild) {
      observer.observe(el.firstElementChild)
    }
    return () => observer.disconnect()
  }, [planContent])

  const isProcessing = !payload && (status === 'running' || status === 'streaming' || isLive)
  const isError = status === 'error' || isStructuredToolErrorText(outputText)
  const displayStatus: PlanStatus =
    plan?.status ?? (payload?.awaitingUserReview ? 'awaiting_review' : 'drafting')
  const statusAppearance = getStatusAppearance(displayStatus)
  const presentKey = payload ? `${payload.planId}:${plan?.updatedAt ?? planContent.length}` : ''

  if (isProcessing) {
    return (
      <div className="my-3 rounded-xl border border-border/70 bg-background/70 p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm text-foreground">
          <Loader2 className="size-4 animate-spin text-amber-500" />
          <span>
            {t('planReview.processing', { defaultValue: 'Preparing plan review content...' })}
          </span>
        </div>
      </div>
    )
  }

  if (isError || !payload) {
    return (
      <div className="my-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <TriangleAlert className="size-4 text-red-500" />
          <span>
            {t('planReview.errorTitle', { defaultValue: 'Plan review card render failed' })}
          </span>
        </div>
        {outputText && (
          <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg border border-red-500/20 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
            {outputText}
          </pre>
        )}
      </div>
    )
  }

  const hasPlanContent = planContent.trim().length > 0

  const handleCopyPlan = (): void => {
    void navigator.clipboard.writeText(planContent)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const handleDownloadPlan = (): void => {
    downloadPlanMarkdown(planDownloadFileName(payload), planContent)
  }

  const handleExpandPlan = (): void => {
    const targetSessionId = sessionId ?? activeSessionId ?? undefined
    presentPlanReviewInRightPanel({
      presentKey,
      title: payload.title,
      content: planContent,
      filePath: payload.filePath,
      sessionId: targetSessionId,
      force: true
    })
  }

  const handleRequestRevision = (): void => {
    const feedback = revisionFeedback.trim()
    if (!feedback) return
    setRevisionOpen(false)
    setRevisionFeedback('')
    void sendPlanRevision(payload.planId, feedback)
  }

  return (
    <div className="my-3 rounded-2xl border border-border/70 bg-background/80 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ClipboardList className="size-4 shrink-0 text-primary" />
            <div className="truncate text-base font-semibold text-foreground">{payload.title}</div>
          </div>
          {payload.filePath && (
            <div className="mt-1 text-xs text-muted-foreground">
              {t('planReview.planFile', { defaultValue: 'Plan file' })}: {payload.filePath}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge
            variant="outline"
            className={cn('text-[10px] font-medium', statusAppearance.badgeClassName)}
          >
            {t(statusAppearance.labelKey, { defaultValue: statusAppearance.defaultValue })}
          </Badge>
          {hasPlanContent && (
            <>
              <button
                type="button"
                onClick={handleDownloadPlan}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={t('planReview.download', { defaultValue: 'Download plan' })}
                aria-label={t('planReview.download', { defaultValue: 'Download plan' })}
              >
                <Download className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={handleCopyPlan}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={t('planReview.copy', { defaultValue: 'Copy plan' })}
                aria-label={t('planReview.copy', { defaultValue: 'Copy plan' })}
              >
                {copied ? (
                  <Check className="size-3.5 text-emerald-500" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
            </>
          )}
          {(hasPlanContent || payload.filePath) && (
            <button
              type="button"
              onClick={handleExpandPlan}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t('planReview.expand', { defaultValue: 'Expand in side panel' })}
              aria-label={t('planReview.expand', { defaultValue: 'Expand in side panel' })}
            >
              <Maximize2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {hasPlanContent ? (
        <div
          ref={contentRef}
          className="relative mt-4 max-h-[220px] overflow-hidden rounded-xl border border-border/60 bg-muted/15 px-4 py-3"
        >
          <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:mb-2 prose-headings:mt-4 prose-p:my-2 prose-ul:my-2 prose-li:my-1 prose-pre:bg-muted prose-pre:px-3 prose-pre:py-2 prose-code:before:content-none prose-code:after:content-none">
            <Markdown
              remarkPlugins={MARKDOWN_REMARK_PLUGINS}
              rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
            >
              {planContent}
            </Markdown>
          </div>
          {contentTruncated && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 rounded-b-xl bg-gradient-to-t from-background to-transparent" />
          )}
        </div>
      ) : payload.message ? (
        <div className="mt-4 rounded-xl border border-border/60 bg-muted/15 px-4 py-3 text-sm text-muted-foreground">
          {payload.message}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {displayStatus === 'awaiting_review' && (
          <>
            <Button
              size="sm"
              className="h-8 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={() => {
                void sendImplementPlan(payload.planId, { modelSelection: executionModel })
              }}
              disabled={isRunning}
            >
              {isRunning ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              {t('planReview.implement', { defaultValue: 'Implement this plan' })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => {
                void sendImplementPlanInNewSession(payload.planId, {
                  modelSelection: executionModel
                })
              }}
              disabled={isRunning}
            >
              <MessageSquarePlus className="size-3.5" />
              {t('planReview.executeInNewSession', { defaultValue: 'Execute in new session' })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setRevisionOpen(true)}
              disabled={isRunning}
            >
              <PenLine className="size-3.5" />
              {t('planReview.requestRevision', { defaultValue: 'Request revision' })}
            </Button>
            <PlanExecutionModelSelect
              sessionId={executionSessionId}
              value={executionModel}
              onChange={setExecutionModel}
              className="h-8 w-[11.5rem] shrink-0 text-xs"
            />
          </>
        )}
        {displayStatus === 'implementing' && (
          <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-300">
            <Loader2 className="size-3.5 animate-spin" />
            <span>
              {executionSession && executionSession.id !== activeSessionId
                ? t('planReview.runningInSession', {
                    defaultValue: 'This plan is running in session “{{title}}”.',
                    title: executionSession.title || 'New Conversation'
                  })
                : t('planReview.runningHint', {
                    defaultValue: 'The current session is implementing this plan.'
                  })}
            </span>
            {executionSession && executionSession.id !== activeSessionId && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => {
                  useChatStore.getState().setActiveSession(executionSession.id)
                  useUIStore.getState().navigateToSession(executionSession.id)
                }}
              >
                {t('planReview.openExecutionSession', { defaultValue: 'Open execution session' })}
              </Button>
            )}
          </div>
        )}
        {displayStatus === 'approved' && (
          <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-300">
            <CheckCircle2 className="size-3.5" />
            <span>
              {t('planReview.approvedHint', { defaultValue: 'This plan has been approved.' })}
            </span>
          </div>
        )}
        {displayStatus === 'rejected' && (
          <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-300">
            <PenLine className="size-3.5" />
            <span>
              {t('planReview.rejectedHint', {
                defaultValue: 'Revision requested. The agent is reworking this plan.'
              })}
            </span>
          </div>
        )}
      </div>

      <Dialog open={revisionOpen} onOpenChange={setRevisionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('planReview.revisionTitle', { defaultValue: 'Request plan revision' })}
            </DialogTitle>
            <DialogDescription>
              {t('planReview.revisionDesc', {
                defaultValue:
                  'Describe what should change. The agent re-enters plan mode and rewrites the plan.'
              })}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={revisionFeedback}
            onChange={(event) => setRevisionFeedback(event.target.value)}
            placeholder={t('planReview.revisionPlaceholder', {
              defaultValue: 'For example: split step 3 into migration and rollout.'
            })}
            className="min-h-[120px]"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevisionOpen(false)}>
              {t('action.cancel', { ns: 'common', defaultValue: 'Cancel' })}
            </Button>
            <Button onClick={handleRequestRevision} disabled={!revisionFeedback.trim()}>
              {t('planReview.revisionSubmit', { defaultValue: 'Send revision request' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
