import type { AgentStreamEvent } from '../../../shared/agent-stream-protocol'
import { isRunScopedAssistantMessageId } from '../../../shared/runtime-projection/reducer'
import { getRuntimeRegistry } from '../runtime-registry'
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
        meta: summaryMessage.meta,
        createdAt: summaryMessage.createdAt
      },
      compactedMessageIds: event.compactedMessageIds ?? [],
      keepMessageIds: resolveKeepMessageIds(sessionId, event.assistantMessageId),
      compactedMessageCount: event.keptMessageCount ?? 0,
      trigger: 'auto',
      preTokens: event.preTokens ?? 0
    })
  }
}

/**
 * The turn the cut must spare, named in host terms.
 *
 * The Worker reports the turn it was streaming by its own handle
 * (`asst:<runId>`); no transcript row carries that id, so recording it spares
 * nothing. The turn then drops out of the model-visible history on the next
 * request even though the tool results it produced after the compaction point
 * survive the cut, leaving those results without the `tool_use` blocks they
 * answer — and the transcript divider, keyed off the same id, falls back to the
 * summary row's own position instead of the compaction point. The host-local id
 * for that turn is the streaming message id the renderer announces on
 * `session-runtime:sync`, which the registry tracks per session.
 */
function resolveKeepMessageIds(sessionId: string, workerAssistantMessageId?: string): string[] {
  const streamingMessageId = getRuntimeRegistry().getStreamingMessageId(sessionId)
  if (streamingMessageId) return [streamingMessageId]

  // Hosted-only runs (cron, channel auto-reply) assemble their own turn and own
  // no desktop row, so an unresolvable handle means there is nothing to spare.
  if (!workerAssistantMessageId || isRunScopedAssistantMessageId(workerAssistantMessageId)) {
    return []
  }
  return [workerAssistantMessageId]
}
