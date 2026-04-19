import type { ProviderConfig, UnifiedMessage } from '@renderer/lib/api/types'
import {
  RESPONSES_SESSION_SCOPE_SIDECAR_TEXT_REQUEST,
  withAuxiliaryResponsesRequestPolicy
} from '@renderer/lib/api/responses-session-policy'
import {
  buildSidecarAgentRunRequest,
  normalizeSidecarAgentEvent,
  normalizeSidecarRecord
} from '@renderer/lib/ipc/sidecar-protocol'

type AgentEventHandler = (event: { type: string; [key: string]: unknown }) => void

/**
 * Bridge client for communicating with the .NET AOT sidecar agent.
 * Routes requests through the Electron main process which manages
 * the sidecar child process via stdio JSON-RPC.
 *
 * This provides the same interface pattern as the existing ipcClient
 * so tools and the agent loop can be migrated incrementally.
 */
class AgentBridgeClient {
  private eventHandlers = new Map<string, Set<AgentEventHandler>>()
  private initialized = false
  private listenerAttached = false

  /**
   * Initialize the bridge: start sidecar and set up event forwarding.
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return true

    const ipc = window.electron.ipcRenderer

    // Listen for agent events forwarded from sidecar via main process
    if (!this.listenerAttached) {
      ipc.on(
        'sidecar:event',
        (_event: unknown, payload: { method: string; params: unknown }) => {
          if (payload.method === 'agent/event-batch') {
            // Unpack batch into individual agent/event dispatches
            const batch = payload.params as {
              runId?: string
              events?: Array<{ type?: string; [key: string]: unknown }>
            } | null
            if (batch?.runId && Array.isArray(batch.events)) {
              for (const evt of batch.events) {
                this.dispatchEvent('agent/event', {
                  runId: batch.runId,
                  event: evt,
                  type: evt?.type ?? 'unknown'
                })
              }
            }
          } else {
            this.dispatchEvent(
              payload.method,
              payload.params as { type: string; [key: string]: unknown }
            )
          }
        }
      )
      this.listenerAttached = true
    }

    // Start the sidecar
    const result = (await ipc.invoke('sidecar:start')) as { ok: boolean }
    if (!result.ok) {
      console.warn('[AgentBridge] Failed to start sidecar')
      return false
    }

    // Initialize the sidecar
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

  /**
   * Send a JSON-RPC request to the sidecar and await the response.
   */
  async request(method: string, params?: unknown): Promise<unknown> {
    return window.electron.ipcRenderer.invoke('sidecar:request', method, params)
  }

  /**
   * Send a JSON-RPC notification to the sidecar (fire-and-forget).
   */
  notify(method: string, params?: unknown): void {
    window.electron.ipcRenderer.send('sidecar:notify', method, params)
  }

  /**
   * Check if the sidecar is currently running.
   */
  async isRunning(): Promise<boolean> {
    const result = (await window.electron.ipcRenderer.invoke('sidecar:status')) as {
      running: boolean
    }
    return result.running
  }

  /**
   * Subscribe to agent events from the sidecar.
   */
  on(eventMethod: string, handler: AgentEventHandler): () => void {
    let handlers = this.eventHandlers.get(eventMethod)
    if (!handlers) {
      handlers = new Set()
      this.eventHandlers.set(eventMethod, handlers)
    }
    handlers.add(handler)

    return () => {
      handlers!.delete(handler)
      if (handlers!.size === 0) {
        this.eventHandlers.delete(eventMethod)
      }
    }
  }

  /**
   * Subscribe to all agent events regardless of method.
   */
  onAnyEvent(handler: AgentEventHandler): () => void {
    return this.on('*', handler)
  }

  private dispatchEvent(method: string, params: { type: string; [key: string]: unknown }): void {
    // Dispatch to specific method handlers
    const handlers = this.eventHandlers.get(method)
    if (handlers) {
      for (const handler of handlers) {
        handler(params)
      }
    }

    // Dispatch to wildcard handlers
    const wildcardHandlers = this.eventHandlers.get('*')
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        handler(params)
      }
    }
  }

  async runAgent(params: unknown): Promise<{ started: boolean; runId: string }> {
    return window.electron.ipcRenderer.invoke('agent:run', params)
  }

  async cancelAgent(runId: string): Promise<{ cancelled: boolean; runId?: string }> {
    return window.electron.ipcRenderer.invoke('agent:cancel', { runId })
  }

  /**
   * Gracefully stop the sidecar.
   */
  async stop(): Promise<void> {
    await window.electron.ipcRenderer.invoke('sidecar:stop')
    this.initialized = false
  }
}

/**
 * Check if a capability is available via the sidecar.
 * Use this to decide whether to route through .NET sidecar or Node.js fallback.
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

      unsubscribe = agentBridge.on('agent/event', (payload) => {
        const record = normalizeSidecarRecord(payload)
        const recordRunId = String(record.runId ?? '')
        if (!recordRunId) return
        const event = normalizeSidecarAgentEvent(record.event)
        if (!event) return

        if (!runId) {
          pendingEvents.push(event)
          return
        }

        if (recordRunId !== runId) return
        handleEvent(event)
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
