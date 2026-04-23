import type { ProviderConfig, UnifiedMessage } from '@renderer/lib/api/types'
import {
  RESPONSES_SESSION_SCOPE_SIDECAR_TEXT_REQUEST,
  withAuxiliaryResponsesRequestPolicy
} from '@renderer/lib/api/responses-session-policy'
import { buildSidecarAgentRunRequest } from '@renderer/lib/ipc/sidecar-protocol'
import { agentStream } from '@renderer/lib/ipc/agent-stream-receiver'
import { toAgentEvent } from '@renderer/lib/agent/stream-event-adapter'

class AgentBridgeClient {
  private initialized = false

  async initialize(): Promise<boolean> {
    if (this.initialized) return true

    const ipc = window.electron.ipcRenderer

    const result = (await ipc.invoke('sidecar:start')) as { ok: boolean }
    if (!result.ok) {
      console.warn('[AgentBridge] Failed to start sidecar')
      return false
    }

    try {
      await this.request('initialize', {
        workingFolder: undefined
      })
      this.initialized = true
      return true
    } catch (err) {
      console.error('[AgentBridge] Initialize failed:', err)
      return false
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    return window.electron.ipcRenderer.invoke('sidecar:request', method, params)
  }

  notify(method: string, params?: unknown): void {
    window.electron.ipcRenderer.send('sidecar:notify', method, params)
  }

  async isRunning(): Promise<boolean> {
    const result = (await window.electron.ipcRenderer.invoke('sidecar:status')) as {
      running: boolean
    }
    return result.running
  }

  async runAgent(params: unknown): Promise<{ started: boolean; runId: string }> {
    return window.electron.ipcRenderer.invoke('agent:run', params)
  }

  async cancelAgent(runId: string): Promise<{ cancelled: boolean; runId?: string }> {
    return window.electron.ipcRenderer.invoke('agent:cancel', { runId })
  }

  async appendAgentMessages(
    runId: string,
    messages: UnifiedMessage[]
  ): Promise<{ appended: boolean; runId?: string; count: number }> {
    return window.electron.ipcRenderer.invoke('agent:append-messages', {
      runId,
      messages
    })
  }

  async stop(): Promise<void> {
    await window.electron.ipcRenderer.invoke('sidecar:stop')
    this.initialized = false
  }
}

/**
 * Check if a capability is available via the main-process runtime bridge.
 */
export async function canSidecarHandle(capability: string): Promise<boolean> {
  try {
    return await window.electron.ipcRenderer.invoke('sidecar:can-handle', capability)
  } catch {
    return false
  }
}

/**
 * Singleton bridge client instance.
 */
export const agentBridge = new AgentBridgeClient()

export function runSidecarCleanup(unsubscribe: (() => void) | null): void {
  if (unsubscribe) {
    unsubscribe()
  }
}

export async function runSidecarTextRequest(args: {
  provider: ProviderConfig
  messages: UnifiedMessage[]
  signal?: AbortSignal
  maxIterations?: number
  responsesSessionScope?: string
}): Promise<string> {
  const provider = withAuxiliaryResponsesRequestPolicy(
    args.provider,
    args.responsesSessionScope ?? RESPONSES_SESSION_SCOPE_SIDECAR_TEXT_REQUEST
  )
  const sidecarRequest = buildSidecarAgentRunRequest({
    messages: args.messages,
    provider,
    tools: [],
    maxIterations: args.maxIterations ?? 1,
    forceApproval: false
  })
  if (!sidecarRequest) {
    throw new Error('Sidecar request build failed')
  }

  const supportsAgentRun = await canSidecarHandle('agent.run')
  const supportsProvider = await canSidecarHandle(`provider.${provider.type}`)
  if (!supportsAgentRun || !supportsProvider) {
    throw new Error('Sidecar capability unavailable')
  }

  const initialized = await agentBridge.initialize()
  if (!initialized) {
    throw new Error('Sidecar unavailable')
  }

  let text = ''
  let settled = false
  let unsubscribe: (() => void) | null = null
  let runId = ''
  const pendingEvents: Array<{ type: string; [key: string]: unknown }> = []

  try {
    await new Promise<void>((resolve, reject) => {
      const handleEvent = (event: { type: string; [key: string]: unknown }): void => {
        switch (event.type) {
          case 'text_delta':
            if (typeof event.text === 'string' && event.text) text += event.text
            break
          case 'error':
            settled = true
            args.signal?.removeEventListener('abort', abortHandler)
            reject(event.error instanceof Error ? event.error : new Error(String(event.error)))
            break
          case 'loop_end':
            settled = true
            args.signal?.removeEventListener('abort', abortHandler)
            resolve()
            break
          default:
            break
        }
      }

      const onAbort = async (): Promise<void> => {
        try {
          if (runId) {
            await agentBridge.cancelAgent(runId)
          }
        } catch {
          // ignore cancellation races
        }
        reject(new Error('aborted'))
      }

      if (args.signal?.aborted) {
        void onAbort()
        return
      }

      const abortHandler = (): void => {
        void onAbort()
      }
      args.signal?.addEventListener('abort', abortHandler, { once: true })

      unsubscribe = agentStream.subscribeAll((eventRunId, _sessionId, streamEvent) => {
        const event = toAgentEvent(streamEvent)
        if (!event) return

        if (!runId) {
          pendingEvents.push(event as unknown as { type: string; [key: string]: unknown })
          return
        }

        if (eventRunId !== runId) return
        handleEvent(event as unknown as { type: string; [key: string]: unknown })
      })

      void (async () => {
        try {
          const result = await agentBridge.runAgent(sidecarRequest)
          runId = result.runId
          for (const event of pendingEvents.splice(0, pendingEvents.length)) {
            handleEvent(event)
            if (settled) break
          }
        } catch (error) {
          args.signal?.removeEventListener('abort', abortHandler)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    })
  } finally {
    runSidecarCleanup(unsubscribe)
    if (!settled) {
      try {
        await agentBridge.cancelAgent(runId)
      } catch {
        // ignore cancellation races
      }
    }
  }

  return text
}
