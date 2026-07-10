import { Check, CircleX, Clock3, Loader2, Maximize2, ScrollText, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { OrchestrationMember } from '@renderer/lib/orchestration/types'
import { cn } from '@renderer/lib/utils'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'

function getMemberIcon(): React.JSX.Element {
  return <UserRound className="size-[17px]" strokeWidth={1.8} aria-hidden="true" />
}

function getMemberDescription(member: OrchestrationMember, waitingLabel: string): string {
  return (
    member.latestAction ||
    member.summary ||
    member.currentTaskLabel ||
    member.description ||
    waitingLabel
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function getPromptText(member: OrchestrationMember): string {
  return member.prompt?.trim() || member.description?.trim() || ''
}

function MemberHoverContent({ member }: { member: OrchestrationMember }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const promptText = getPromptText(member)

  return (
    <HoverCardContent
      side="top"
      align="start"
      className="w-[min(32rem,calc(100vw-3rem))] border-white/10 bg-[#141414]/98 p-0 text-white shadow-2xl backdrop-blur"
    >
      <div className="space-y-3 p-3">
        <div className="flex items-center gap-2 border-b border-white/10 pb-3">
          <div className="flex size-8 items-center justify-center rounded-full border border-white/10 bg-[#1b1b1b] text-white/82">
            {getMemberIcon()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-white/88">{member.name}</div>
            <div className="mt-0.5 text-[11px] text-white/45">
              {member.agentName || member.role || t('subAgent.label', { defaultValue: 'subAgent' })}
            </div>
          </div>
        </div>

        {promptText ? (
          <section className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-white/40">
              <ScrollText className="size-3" />
              <span>{t('subAgent.prompt', { defaultValue: 'Prompt' })}</span>
            </div>
            <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[12px] leading-5 text-white/72">
              {promptText}
            </div>
          </section>
        ) : (
          <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-2.5 py-2 text-[12px] text-white/45">
            {t('subAgent.promptEmpty', { defaultValue: 'No prompt available' })}
          </div>
        )}
      </div>
    </HoverCardContent>
  )
}

export function OrchestrationMemberStrip({
  members,
  onOpenMember
}: {
  members: OrchestrationMember[]
  onOpenMember?: (member: OrchestrationMember) => void
}): React.JSX.Element {
  const { t } = useTranslation('chat')

  return (
    <div className="space-y-1.5">
      {members.slice(0, 6).map((member) => {
        const isWorking = member.status === 'working'
        const isFailed = member.status === 'failed'
        const isCompleted = member.status === 'completed'
        const isStopped = member.status === 'stopped'
        const statusLabel = isWorking
          ? t('subAgent.working')
          : isFailed
            ? t('subAgent.failed')
            : isCompleted
              ? t('subAgent.done')
              : isStopped
                ? t('subAgent.stopped', { defaultValue: 'stopped' })
                : t('subAgent.queued')
        const waitingLabel = t('subAgent.waiting', { defaultValue: 'Waiting to execute' })
        const failureFallback = t('subAgent.failureUnknown', {
          defaultValue: 'SubAgent execution failed'
        })
        const detailText =
          isFailed && member.errorMessage?.trim()
            ? normalizeInlineText(member.errorMessage)
            : getMemberDescription(member, isFailed ? failureFallback : waitingLabel)
        const metaText = [
          member.iteration > 0 ? t('subAgent.iter', { count: member.iteration }) : '',
          member.toolCallCount > 0 ? t('subAgent.calls', { count: member.toolCallCount }) : '',
          member.model?.trim() || ''
        ]
          .filter(Boolean)
          .join(' · ')
        const openLabel = t('subAgent.openNamedInPanel', {
          name: member.name,
          defaultValue: `Open ${member.name} in side panel`
        })
        const card = (
          <div
            aria-busy={isWorking}
            className={cn(
              'relative overflow-hidden rounded-lg border border-transparent bg-background/35',
              'transition-[background-color,border-color,box-shadow,transform] duration-150',
              'hover:-translate-y-px hover:border-border/65 hover:bg-background/70 hover:shadow-sm',
              'dark:bg-white/[0.035] dark:hover:border-white/[0.09] dark:hover:bg-white/[0.06]',
              member.isSelected && 'border-emerald-500/25 ring-1 ring-emerald-500/15',
              isFailed &&
                'border-destructive/20 bg-destructive/[0.035] hover:border-destructive/30 hover:bg-destructive/[0.05]'
            )}
          >
            {isWorking ? (
              <span className="absolute inset-y-2 left-0 w-px rounded-full bg-emerald-400/70 shadow-[0_0_8px_rgba(52,211,153,0.38)]" />
            ) : null}

            <button
              type="button"
              onClick={() => onOpenMember?.(member)}
              title={`${member.name} · ${detailText}`}
              className="w-full px-3 py-2.5 pr-12 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <div
                  className={cn(
                    'relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-violet-500/20 bg-violet-500/[0.07] text-violet-600',
                    'dark:border-violet-300/[0.14] dark:bg-violet-300/[0.07] dark:text-violet-200/80'
                  )}
                >
                  {getMemberIcon()}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-foreground/88">
                      {member.name}
                    </span>
                    <span
                      className={cn(
                        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium',
                        isWorking &&
                          'border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-600 dark:text-emerald-300',
                        isFailed && 'border-destructive/20 bg-destructive/[0.07] text-destructive',
                        isCompleted && 'border-border/55 text-muted-foreground',
                        !isWorking &&
                          !isFailed &&
                          !isCompleted &&
                          'border-amber-500/20 bg-amber-500/[0.06] text-amber-600 dark:text-amber-300'
                      )}
                      role="status"
                    >
                      {isWorking ? (
                        <Loader2 className="size-2.5 motion-safe:animate-spin" aria-hidden="true" />
                      ) : isFailed ? (
                        <CircleX className="size-2.5" aria-hidden="true" />
                      ) : isCompleted ? (
                        <Check className="size-2.5" aria-hidden="true" />
                      ) : (
                        <Clock3 className="size-2.5" aria-hidden="true" />
                      )}
                      <span>{statusLabel}</span>
                    </span>
                  </div>

                  <p
                    className={cn(
                      'mt-1 text-[12px] leading-4',
                      isFailed
                        ? 'line-clamp-2 break-words text-destructive/85'
                        : 'truncate text-muted-foreground/75'
                    )}
                    title={isFailed ? detailText : undefined}
                  >
                    {detailText}
                  </p>

                  {metaText ? (
                    <p className="mt-1 truncate text-[10px] leading-4 text-muted-foreground/50">
                      {metaText}
                    </p>
                  ) : null}
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => onOpenMember?.(member)}
              className={cn(
                'group/expand absolute right-3 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg bg-muted/55 text-muted-foreground',
                'transition-[color,background-color,transform] duration-150',
                'hover:bg-muted hover:text-foreground active:-translate-y-1/2 active:scale-95',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                'dark:bg-white/[0.055] dark:hover:bg-white/[0.09]'
              )}
              title={openLabel}
              aria-label={openLabel}
            >
              <Maximize2 className="size-3.5 transition-transform duration-150 group-hover/expand:scale-105" />
            </button>
          </div>
        )

        return member.prompt?.trim() || member.description?.trim() ? (
          <HoverCard key={member.id}>
            <HoverCardTrigger asChild>{card}</HoverCardTrigger>
            <MemberHoverContent member={member} />
          </HoverCard>
        ) : (
          <div key={member.id}>{card}</div>
        )
      })}
    </div>
  )
}
