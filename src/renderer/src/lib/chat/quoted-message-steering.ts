import type { ContentBlock, UnifiedMessage } from '@renderer/lib/api/types'

/**
 * Delivery routing for a quoted ("steer") prompt — a message the user types while
 * an agent run is already in flight.
 *
 * There are two routes, and picking the wrong one is the whole reason this module
 * exists as a separate, tested unit:
 *
 * - `inject` — hand the message to the *running* worker run through
 *   `agent/append-messages`. The agent loop drains its queue at the top of every
 *   iteration (`OpenAIChatRuntime.RunAgentLoop` -> `DrainQueuedMessages`), so the
 *   model sees the steer as soon as the in-flight provider request returns. The
 *   loop also refuses to finish while that queue is non-empty
 *   (`TryCloseMessageQueueIfEmpty`), so a steer injected during the final turn
 *   still gets answered inside the same run. This is what steering means and what
 *   the user expects.
 *
 * - `queue` — park it in the renderer's pending-message queue. That queue is only
 *   drained after the entire run ends, and dispatching it starts a *brand new*
 *   run. The agent therefore keeps working on the superseded instruction for the
 *   rest of the current run.
 *
 * `queue` is the fallback, never the default.
 *
 * Why this is spelled out at length: the bug has been reintroduced more than once,
 * because both routes render the optimistic bubble immediately. Nothing looks
 * broken in the transcript — the only symptom is that the agent ignores the steer
 * until the run finishes, which reads like a model problem rather than a routing
 * problem. The renderer's injection call has also been lost wholesale before, when
 * the agent loop moved out of the renderer and `lib/agent/shared-runtime.ts` (which
 * owned the only `appendAgentMessages` caller) was deleted with it. If you are
 * refactoring the run host again, this call has to move with it.
 */
export type QuotedDeliveryPlan =
  | { route: 'inject'; runId: string }
  | { route: 'queue'; reason: QuotedQueueReason }

export type QuotedQueueReason =
  /** No run is in flight, so a normal new turn is already the immediate path. */
  | 'no_active_run'
  /**
   * A run is in flight but its worker runId is unknown to this renderer (for
   * example a reload landed before `runtime-reattach` rebuilt the binding).
   * Without a runId there is nothing to inject into.
   */
  | 'unknown_run_id'
  /**
   * The message needs work that only the full `sendMessage` pipeline does —
   * slash-command expansion and `@file` reads happen there, not here. Injecting
   * the raw text would silently send an unexpanded `/command` to the model.
   */
  | 'needs_full_send_pipeline'

export interface QuotedDeliveryInput {
  /** Active worker runId for this session, from `sessionSidecarRunIds`. */
  activeRunId: string | null | undefined
  /** Whether the session currently has a run in flight. */
  hasActiveRun: boolean
  /** The quoted entry carries a slash / system command that still needs expanding. */
  hasCommand: boolean
  /** The quoted entry carries `@file` references that still need reading. */
  hasSelectedFileReferences: boolean
}

export function planQuotedMessageDelivery(input: QuotedDeliveryInput): QuotedDeliveryPlan {
  if (!input.hasActiveRun) return { route: 'queue', reason: 'no_active_run' }
  if (input.hasCommand || input.hasSelectedFileReferences) {
    return { route: 'queue', reason: 'needs_full_send_pipeline' }
  }
  const runId = input.activeRunId?.trim()
  if (!runId) return { route: 'queue', reason: 'unknown_run_id' }
  return { route: 'inject', runId }
}

/**
 * Mirrors `QUEUED_MESSAGE_SYSTEM_REMIND`, but for the mid-run case: the model is
 * about to see a new user turn appear between its own tool results and its next
 * response, which is not a shape it meets during normal training-time dialogue.
 * Say plainly that the user interrupted, so it re-plans instead of finishing the
 * superseded task first.
 */
export const STEERING_MESSAGE_SYSTEM_REMIND = `<system-reminder>
The user sent this message while you were still working on the previous request.
It was inserted into the conversation at the current tool-call boundary, so it is
newer than everything above it. Treat it as the latest instruction: re-plan if it
changes the task, and answer it directly rather than finishing the superseded work first.
</system-reminder>`

/**
 * Builds the message handed to the worker. The steering reminder is prepended to
 * the wire copy only — the transcript keeps the user's own text, so the bubble the
 * user sees never shows this scaffolding.
 */
export function buildSteeringWireMessage(rendered: UnifiedMessage): UnifiedMessage {
  const reminder: ContentBlock = { type: 'text', text: STEERING_MESSAGE_SYSTEM_REMIND }
  const content: ContentBlock[] =
    typeof rendered.content === 'string'
      ? [reminder, { type: 'text', text: rendered.content }]
      : [reminder, ...rendered.content]

  return {
    ...rendered,
    content,
    // The transcript row keeps `quotedPending` until the worker confirms the
    // steer landed; the wire copy must not, or request assembly on a later turn
    // would shuffle this message to the tail a second time.
    meta: stripQuotedPending(rendered.meta)
  }
}

function stripQuotedPending(meta: UnifiedMessage['meta']): UnifiedMessage['meta'] {
  if (!meta?.quotedPending) return meta
  const { quotedPending: _quotedPending, ...rest } = meta
  return Object.keys(rest).length > 0 ? rest : undefined
}

/** Mirrors `isToolResultOnlyUserMessage` in components/chat/transcript-utils. */
function isToolResultOnlyUserMessage(message: UnifiedMessage): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === 'tool_result')
  )
}

/**
 * Moves an injected steer message into the transcript position the worker gave it,
 * and clears the `quotedPending` marker.
 *
 * The optimistic bubble is appended the moment the user sends it, so it lands
 * directly after the streaming assistant message and *before* the tool_result rows
 * of the tool call that was still running:
 *
 *     assistant(text + tool_use)
 *     user(steer)            <- appended here
 *     user(tool_result)      <- arrives at iteration_end
 *
 * The worker put the steer after those results instead, because it drains its
 * injected-message queue at the top of the next iteration. Left as-is, the next
 * request assembled from this transcript would carry a user turn between an
 * assistant's tool_use and its tool_result, which providers that require
 * contiguous tool pairs reject.
 *
 * `quotedPending` papers over that while the run is live — request assembly moves
 * flagged messages to the request tail — but the flag cannot stay on forever, or
 * every later turn re-presents this steer as the newest instruction. So the swap
 * happens once, at run completion, when nothing is appending to the transcript
 * anymore.
 *
 * Returns null when there is nothing to change.
 */
export function reorderSteerMessageAfterToolResults(
  messages: UnifiedMessage[],
  steerMessageId: string
): UnifiedMessage[] | null {
  const index = messages.findIndex((message) => message.id === steerMessageId)
  if (index < 0) return null

  const steer = messages[index]
  let end = index + 1
  while (end < messages.length && isToolResultOnlyUserMessage(messages[end])) end++

  const settled: UnifiedMessage = { ...steer, meta: stripQuotedPending(steer.meta) }
  if (end === index + 1) {
    if (settled.meta === steer.meta) return null
    return [...messages.slice(0, index), settled, ...messages.slice(index + 1)]
  }

  return [
    ...messages.slice(0, index),
    ...messages.slice(index + 1, end),
    settled,
    ...messages.slice(end)
  ]
}
