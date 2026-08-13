import type { ToolCallStatus } from '@renderer/lib/agent/types'

export type SubAgentPresentationPhase = 'queued' | 'running' | 'completed' | 'error'

export type SubAgentPresentationTracked = {
  isRunning: boolean
  isQueued?: boolean
  success: boolean | null
  errorMessage: string | null
}

export type SubAgentPresentation = {
  isError: boolean
  isQueued: boolean
  isRunning: boolean
  phase: SubAgentPresentationPhase
}

const LIVE_TOOL_STATUSES = new Set<string>(['running', 'streaming', 'pending_approval'])

export function resolveSubAgentPresentation(options: {
  hasToolResult: boolean
  isLive?: boolean
  liveToolStatus?: ToolCallStatus | 'completed'
  toolResultIsError?: boolean
  tracked?: SubAgentPresentationTracked | null
}): SubAgentPresentation {
  const tracked = options.tracked
  if (tracked) {
    const isQueued = Boolean(tracked.isQueued)
    const isRunning = tracked.isRunning && !isQueued
    const isError = tracked.success === false || Boolean(tracked.errorMessage)
    return {
      isQueued,
      isRunning,
      isError,
      phase: isQueued ? 'queued' : isRunning ? 'running' : isError ? 'error' : 'completed'
    }
  }

  const liveStatus = options.liveToolStatus
  if (liveStatus && LIVE_TOOL_STATUSES.has(liveStatus)) {
    return { isQueued: false, isRunning: true, isError: false, phase: 'running' }
  }
  if (liveStatus === 'error' || options.toolResultIsError) {
    return { isQueued: false, isRunning: false, isError: true, phase: 'error' }
  }
  if (options.hasToolResult || liveStatus === 'completed' || liveStatus === 'canceled') {
    return { isQueued: false, isRunning: false, isError: false, phase: 'completed' }
  }

  // Task tool_use can appear (chat transcript / runtime overlay) before the
  // Native Worker emits sub_agent_start. Treat that gap as in-flight instead
  // of defaulting to "done", which desynced the transcript card from the panel.
  return { isQueued: false, isRunning: true, isError: false, phase: 'running' }
}
