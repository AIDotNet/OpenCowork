// Post-reload runtime recovery.
//
// When the renderer reloads mid-run (Vite HMR in dev) or a detached window opens
// on a running session, the agent keeps executing in the main-process worker but
// nothing in the fresh renderer is listening. This module pulls the main-process
// runtime snapshot (agent:runtime-state), rebuilds the sessionId->runId binding
// and running-session status, then subscribes a durable per-run consumer and asks
// main to replay the journalled event tail (agent:attach-run). Replayed frames
// and subsequent live frames flow through the same agentStream dispatch path, so
// the in-progress assistant message is reconstructed as normal streaming would.
//
// This intentionally does NOT resurrect the createSidecarEventStream `for await`
// loop in use-chat-actions — that loop is coupled to run-scoped locals that no
// longer exist after a reload. The consumer here handles only the events needed
// to reconstruct visible state (text, thinking, tool cards) and to finalize on
// terminal; the heavier side effects (task/goal reloads, change tracking) are
// left to the normal path for any run started after the reload.

import type { AgentStreamEvent, ToolCallStateWire } from '../../../../shared/agent-stream-protocol'
import type { ToolCallState } from '@renderer/lib/agent/types'
import type { ToolUseBlock } from '@renderer/lib/api/types'
import { agentStream } from '@renderer/lib/ipc/agent-stream-receiver'
import { agentBridge } from '@renderer/lib/ipc/agent-bridge'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import {
  appendRuntimeContentBlock,
  appendRuntimeThinkingDelta,
  appendRuntimeTextDelta,
  appendRuntimeToolUse,
  addRuntimeMessage,
  completeRuntimeThinking,
  mergeRuntimeMessageUsage,
  setRuntimeThinkingEncryptedContent,
  updateRuntimeToolUseInput
} from '@renderer/lib/agent/session-runtime-router'
import { sessionSidecarRunIds } from '@renderer/lib/agent/session-run-registry'
import { withSessionRuntimeSyncSuppressed } from '@renderer/lib/session-runtime-sync'
import { withAgentRuntimeSyncSuppressed } from '@renderer/lib/agent-runtime-sync'

// Runs this window has already reattached to, so a second reattach pass (e.g.
// worker reconnect after a mount) doesn't double-subscribe.
const reattachedRuns = new Map<string, () => void>()

interface ReattachRunContext {
  runId: string
  sessionId: string
  assistantMessageId: string
  thinkingComplete: boolean
}

function toToolCallState(wire: ToolCallStateWire, sessionId: string): ToolCallState {
  return { ...(wire as unknown as ToolCallState), sessionId }
}

function finalizeReattachedRun(ctx: ReattachRunContext): void {
  const dispose = reattachedRuns.get(ctx.runId)
  if (dispose) {
    dispose()
    reattachedRuns.delete(ctx.runId)
  }
  if (sessionSidecarRunIds.get(ctx.sessionId) === ctx.runId) {
    sessionSidecarRunIds.delete(ctx.sessionId)
  }
  useChatStore.getState().setStreamingMessageId(ctx.sessionId, null)
}

// Apply a single replayed/live event to the store. Returns true when the event
// was terminal so the caller can stop.
function applyReattachEvent(ctx: ReattachRunContext, event: AgentStreamEvent): boolean {
  const { sessionId, assistantMessageId } = ctx

  switch (event.type) {
    case 'thinking_delta':
      appendRuntimeThinkingDelta(sessionId, assistantMessageId, event.thinking)
      return false

    case 'thinking_encrypted':
      setRuntimeThinkingEncryptedContent(
        sessionId,
        assistantMessageId,
        event.content,
        event.provider
      )
      return false

    case 'text_delta':
      // Structured thinking and visible text are separate channels; the first
      // text delta marks the thinking boundary. Reattach doesn't reproduce the
      // provider-specific <think> tag parsing — final state only needs to be
      // correct and the continued stream readable.
      if (!ctx.thinkingComplete) {
        completeRuntimeThinking(sessionId, assistantMessageId)
        ctx.thinkingComplete = true
      }
      appendRuntimeTextDelta(sessionId, assistantMessageId, event.text)
      return false

    case 'tool_use_generated': {
      const block = event.toolUseBlock
      if (block?.id && block.name) {
        appendRuntimeToolUse(sessionId, assistantMessageId, {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
          // Wire and domain extraContent are structurally identical; the wire
          // type widens computerActionType to string.
          ...(block.extraContent
            ? { extraContent: block.extraContent as ToolUseBlock['extraContent'] }
            : {})
        })
      }
      return false
    }

    case 'tool_use_args_delta':
      updateRuntimeToolUseInput(sessionId, assistantMessageId, event.toolCallId, event.partialInput)
      return false

    case 'tool_call_start':
    case 'tool_call_approval_needed':
      useAgentStore.getState().addToolCall(toToolCallState(event.toolCall, sessionId), sessionId)
      return false

    case 'tool_call_update':
    case 'tool_call_result':
      useAgentStore
        .getState()
        .updateToolCall(event.toolCall.id, toToolCallState(event.toolCall, sessionId), sessionId)
      return false

    case 'message_end':
      if (event.usage) {
        mergeRuntimeMessageUsage(sessionId, assistantMessageId, event.usage)
      }
      return false

    case 'image_generated':
      appendRuntimeContentBlock(sessionId, assistantMessageId, event.imageBlock)
      return false

    case 'error':
      appendRuntimeContentBlock(sessionId, assistantMessageId, {
        type: 'agent_error',
        code: 'runtime_error',
        message: event.message,
        ...(event.errorType ? { errorType: event.errorType } : {}),
        ...(event.details ? { details: event.details } : {})
      })
      useAgentStore.getState().setSessionStatus(sessionId, null)
      finalizeReattachedRun(ctx)
      return true

    case 'loop_end':
      useAgentStore.getState().setSessionStatus(sessionId, 'completed')
      finalizeReattachedRun(ctx)
      return true

    default:
      return false
  }
}

async function reattachOneRun(
  runId: string,
  sessionId: string,
  status: 'running' | 'completed' | 'error',
  assistantMessageId: string | null
): Promise<void> {
  if (reattachedRuns.has(runId)) return

  // Ensure the session's recent messages are resident so the assistant message
  // the deltas land in exists (or can be located) before replay.
  try {
    await useChatStore.getState().loadRecentSessionMessages(sessionId, true)
  } catch {
    // Non-fatal — a missing message id is handled below by seeding one.
  }

  // Resolve the landing assistant message (pure reads). assistantMessageId comes
  // from the main-process observation of set_streaming_message; fall back to the
  // last assistant message, or a synthetic id we seed below.
  const residentMessages = useChatStore.getState().getSessionMessages(sessionId)
  let landingId = assistantMessageId
  let needsSeed = false
  if (landingId) {
    needsSeed = !residentMessages.some((m) => m.id === landingId)
  } else {
    const lastAssistant = [...residentMessages].reverse().find((m) => m.role === 'assistant')
    landingId = lastAssistant?.id ?? `reattach-${runId}`
    needsSeed = !lastAssistant
  }
  const resolvedLandingId: string = landingId ?? `reattach-${runId}`

  // All store writes here are local-only (suppressed): each window reattaches
  // from its own journal replay, so re-broadcasting the seed/bindings would make
  // sibling windows double-apply.
  withAgentRuntimeSyncSuppressed(() => {
    withSessionRuntimeSyncSuppressed(() => {
      if (needsSeed) {
        addRuntimeMessage(sessionId, {
          id: resolvedLandingId,
          role: 'assistant',
          content: [],
          createdAt: Date.now()
        })
      }
      // Rebuild the runtime bindings a reload wiped.
      sessionSidecarRunIds.set(sessionId, runId)
      useChatStore.getState().setStreamingMessageId(sessionId, resolvedLandingId)
      useAgentStore.getState().setSessionStatus(sessionId, status === 'error' ? null : 'running')
      useAgentStore.getState().setRunning(true)
    })
  })

  const ctx: ReattachRunContext = {
    runId,
    sessionId,
    assistantMessageId: resolvedLandingId,
    thinkingComplete: false
  }

  // Subscribe BEFORE requesting replay so no frame emitted between the snapshot
  // and the attach call is missed. agent-stream-receiver dedupes by seq, so any
  // overlap with the replayed tail is harmless.
  const unsubscribe = agentStream.subscribe(runId, (event) => {
    // Apply locally only — do not re-broadcast to other windows. Each window
    // reattaches from its own journal replay, so cross-window emit would cause
    // sibling windows to double-apply the same delta.
    withAgentRuntimeSyncSuppressed(() => {
      withSessionRuntimeSyncSuppressed(() => {
        applyReattachEvent(ctx, event)
      })
    })
  })
  reattachedRuns.set(runId, unsubscribe)

  const sinceSeq = agentStream.getLastSeq(runId) ?? -1
  try {
    await agentBridge.attachRun(runId, sinceSeq, sessionId)
  } catch (error) {
    console.warn(
      `[RuntimeReattach] attachRun failed for ${runId}:`,
      error instanceof Error ? error.message : String(error)
    )
  }
}

/**
 * Pull the main-process runtime snapshot and reattach to active runs. Pass a
 * sessionId to restrict recovery to a single session (detached window view).
 */
export async function reattachActiveRuns(options?: { sessionId?: string }): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof agentBridge.getRuntimeState>>
  try {
    snapshot = await agentBridge.getRuntimeState()
  } catch (error) {
    console.warn(
      '[RuntimeReattach] getRuntimeState failed:',
      error instanceof Error ? error.message : String(error)
    )
    return
  }

  const scopeSessionId = options?.sessionId?.trim()
  const runs = scopeSessionId
    ? snapshot.runs.filter((run) => run.sessionId === scopeSessionId)
    : snapshot.runs

  for (const run of runs) {
    // A completed run still in the journal (terminal-retention window) means the
    // run ended; reattaching would just replay a finished stream. Skip it — the
    // messages are already persisted and loaded from the DB.
    if (run.status !== 'running') continue
    await reattachOneRun(run.runId, run.sessionId, run.status, run.assistantMessageId)
  }
}
