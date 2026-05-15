import type { AgentEvent } from '@renderer/lib/agent/types'
import type { AgentStreamEvent } from '../../../../shared/agent-stream-protocol'
import { agentBridge } from '@renderer/lib/ipc/agent-bridge'
import { agentStream } from '@renderer/lib/ipc/agent-stream-receiver'
import { toAgentEvent, toSubAgentEvent } from './stream-event-adapter'
import { subAgentEvents } from '@renderer/lib/agent/sub-agents/events'
import type { SidecarAgentRunRequest } from '@renderer/lib/ipc/sidecar-protocol'

export interface RunAgentViaSidecarOptions {
  signal?: AbortSignal
  onRunIdAssigned?: (runId: string) => void
  routeSubAgentEventsToBus?: boolean
}

export function runAgentViaSidecar(
  request: SidecarAgentRunRequest,
  options: RunAgentViaSidecarOptions = {}
): AsyncIterable<AgentEvent> {
  const { signal, onRunIdAssigned, routeSubAgentEventsToBus = true } = options
  return {
    async *[Symbol.asyncIterator]() {
      const initialized = await agentBridge.initialize()
      if (!initialized) {
        throw new Error('Sidecar unavailable')
      }

      const queue: AgentEvent[] = []
      const pendingEvents: Array<{ runId: string; event: AgentStreamEvent }> = []
      let finished = false
      let notify: (() => void) | null = null
      let runId = ''
      let abortCleanup: (() => void) | null = null

      const wake = (): void => {
        if (notify) {
          const resume = notify
          notify = null
          resume()
        }
      }

      const pushEvent = (normalized: AgentEvent): void => {
        queue.push(normalized)
        if (normalized.type === 'loop_end' || normalized.type === 'error') {
          finished = true
        }
        wake()
      }

      const dispatchStreamEvent = (event: AgentStreamEvent): void => {
        const subEvent = toSubAgentEvent(event)
        if (subEvent) {
          if (routeSubAgentEventsToBus) {
            subAgentEvents.emit(request.sessionId ?? null, subEvent)
            return
          }
        }

        const agentEvent = toAgentEvent(event)
        if (agentEvent) {
          pushEvent(agentEvent)
        }
      }

      const unsub = agentStream.subscribeAll((eventRunId, _sessionId, event) => {
        if (!runId) {
          pendingEvents.push({ runId: eventRunId, event })
          return
        }

        if (eventRunId && eventRunId !== runId) return
        dispatchStreamEvent(event)
      })

      try {
        const result = await agentBridge.runAgent(request)
        runId = result.runId
        onRunIdAssigned?.(runId)

        if (signal) {
          if (signal.aborted) {
            void agentBridge.cancelAgent(runId).catch(() => {})
          } else {
            const onAbort = (): void => {
              void agentBridge.cancelAgent(runId).catch(() => {})
            }
            signal.addEventListener('abort', onAbort, { once: true })
            abortCleanup = () => signal.removeEventListener('abort', onAbort)
          }
        }

        const pendingSnapshot = pendingEvents.splice(0, pendingEvents.length)
        for (const pending of pendingSnapshot) {
          if (pending.runId && pending.runId !== runId) continue
          dispatchStreamEvent(pending.event)
        }

        while (!finished || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve
            })
            continue
          }
          const next = queue.shift()
          if (next) yield next
        }
      } finally {
        abortCleanup?.()
        unsub()
      }
    }
  }
}
