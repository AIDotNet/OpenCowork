import type { AgentStreamEvent } from '../../../shared/agent-stream-protocol'
import { recordSessionCompaction } from './session-compaction'

/**
 * Records the compaction cut for every run, whatever started it.
 *
 * All Worker stream frames — interactive, cron, channel auto-reply — funnel
 * through the durable event consumer into `RuntimeProjectionHost.ingestFrame`,
 * so this is the one place where "context was compressed" is observed for all
 * execution paths. Recording it in the renderer instead is what left headless
 * runs replaying their entire history after every compression.
 */
export function recordCompactionEvents(sessionId: string, events: AgentStreamEvent[]): void {
  for (const event of events) {
    if (event?.type !== 'context_compressed') continue
    // A failed summarizer leaves the context untouched, so there is nothing to cut.
    if (event.summarizerFailed === true) continue
    const summaryMessage = event.compactSummaryMessage
    if (!summaryMessage?.id) {
      console.warn('[CompactionRecorder] context_compressed without a summary message', {
        sessionId
      })
      continue
    }

    // Fire and forget: the commit is idempotent per summary id, so a replayed
    // frame from the durable outbox records the same cut instead of a second one.
    void recordSessionCompaction({
      sessionId,
      summaryMessage: {
        id: summaryMessage.id,
        role: summaryMessage.role,
        content: summaryMessage.content,
        createdAt: summaryMessage.createdAt
      },
      compactedMessageIds: event.compactedMessageIds ?? [],
      keepMessageIds: event.assistantMessageId ? [event.assistantMessageId] : [],
      compactedMessageCount: event.keptMessageCount ?? 0,
      trigger: 'auto',
      preTokens: event.preTokens ?? 0
    })
  }
}
