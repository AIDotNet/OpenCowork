import * as React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  CheckCircle2,
  ClipboardList,
  Loader2,
  MessageSquarePlus,
  Play,
  TriangleAlert
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
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
import { sendImplementPlan, sendImplementPlanInNewSession } from '@renderer/hooks/use-chat-actions'
import { cn } from '@renderer/lib/utils'

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
  const { t } = useTranslation('chat')
  const parsedPayload = React.useMemo(() => parsePlanReviewPayload(output), [output])
  const outputText = React.useMemo(() => outputAsText(output), [output])
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const hasStreamingMessage = useChatStore((s) =>
    activeSessionId ? Boolean(s.streamingMessages[activeSessionId]) : false
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
  const isRunning = useAgentStore((s) => s.isSessionActive(activeSessionId)) || hasStreamingMessage

  const isProcessing = !payload && (status === 'running' || status === 'streaming' || isLive)
  const isError = status === 'error' || isStructuredToolErrorText(outputText)
  const displayStatus: PlanStatus =
    plan?.status ?? (payload?.awaitingUserReview ? 'awaiting_review' : 'drafting')
  const statusAppearance = getStatusAppearance(displayStatus)

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
        <Badge
          variant="outline"
          className={cn('shrink-0 text-[10px] font-medium', statusAppearance.badgeClassName)}
        >
          {t(statusAppearance.labelKey, { defaultValue: statusAppearance.defaultValue })}
        </Badge>
      </div>

      {payload.content.trim() ? (
        <div className="mt-4 max-h-[420px] overflow-y-auto rounded-xl border border-border/60 bg-muted/15 px-4 py-3">
          <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:mb-2 prose-headings:mt-4 prose-p:my-2 prose-ul:my-2 prose-li:my-1 prose-pre:bg-muted prose-pre:px-3 prose-pre:py-2 prose-code:before:content-none prose-code:after:content-none">
            <Markdown remarkPlugins={[remarkGfm]}>{payload.content}</Markdown>
          </div>
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
                void sendImplementPlan(payload.planId)
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
                void sendImplementPlanInNewSession(payload.planId)
              }}
              disabled={isRunning}
            >
              <MessageSquarePlus className="size-3.5" />
              {t('planReview.executeInNewSession', { defaultValue: 'Execute in new session' })}
            </Button>
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
      </div>
    </div>
  )
}
