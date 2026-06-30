import type {
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  ToolCallExtraContent,
  UnifiedMessage
} from '@renderer/lib/api/types'
import type { CompressionResult } from '@renderer/lib/agent/context-compression'
import type { AgentEvent } from '@renderer/lib/agent/types'
import {
  RESPONSES_SESSION_SCOPE_SIDECAR_TEXT_REQUEST,
  withAuxiliaryResponsesRequestPolicy
} from '@renderer/lib/api/responses-session-policy'
import {
  buildSidecarAgentRunRequest,
  isNativeSidecarProviderConfig
} from '@renderer/lib/ipc/sidecar-protocol'
import { agentStream } from '@renderer/lib/ipc/agent-stream-receiver'
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { toAgentEvent } from '@renderer/lib/agent/stream-event-adapter'
import { toMessagePackChannel } from '../../../../shared/messagepack/binary-ipc'

class AgentBridgeClient {
  private initialized = false

  async initialize(): Promise<boolean> {
    if (this.initialized) return true

    const result = (await ipcClient.invoke('sidecar:start')) as { ok: boolean }
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

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    return await invokeMessagePackBinary(toMessagePackChannel('sidecar:request'), {
      method,
      params,
      timeoutMs
    })
  }

  notify(method: string, params?: unknown): void {
    ipcClient.send('sidecar:notify', method, params)
  }

  async isRunning(): Promise<boolean> {
    const result = (await ipcClient.invoke('sidecar:status')) as {
      running: boolean
    }
    return result.running
  }

  async runAgent(params: unknown): Promise<{ started: boolean; runId: string }> {
    return await invokeMessagePackBinary<{ started: boolean; runId: string }>(
      toMessagePackChannel('agent:run'),
      params
    )
  }

  async cancelAgent(runId: string): Promise<{ cancelled: boolean; runId?: string }> {
    return await invokeMessagePackBinary<{ cancelled: boolean; runId?: string }>(
      toMessagePackChannel('agent:cancel'),
      { runId }
    )
  }

  async appendAgentMessages(
    runId: string,
    messages: UnifiedMessage[]
  ): Promise<{ appended: boolean; runId?: string; count: number }> {
    return await invokeMessagePackBinary<{ appended: boolean; runId?: string; count: number }>(
      toMessagePackChannel('agent:append-messages'),
      {
        runId,
        messages
      }
    )
  }

  async stop(): Promise<void> {
    await ipcClient.invoke('sidecar:stop')
    this.initialized = false
  }
}

/**
 * Check if a capability is available via the main-process runtime bridge.
 */
export async function canSidecarHandle(capability: string): Promise<boolean> {
  try {
    return Boolean(await ipcClient.invoke('sidecar:can-handle', capability))
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

function normalizeProviderToolInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function toProviderErrorEvent(error: unknown): StreamEvent {
  return {
    type: 'error',
    error: {
      type: error instanceof Error ? error.name || 'sidecar_error' : 'sidecar_error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function mapAgentEventToProviderEvents(
  event: AgentEvent,
  startedToolIds: Set<string>
): StreamEvent[] {
  switch (event.type) {
    case 'text_delta':
      return [{ type: 'text_delta', text: event.text }]
    case 'thinking_delta':
      return [{ type: 'thinking_delta', thinking: event.thinking }]
    case 'thinking_encrypted':
      return [
        {
          type: 'thinking_encrypted',
          thinkingEncryptedContent: event.thinkingEncryptedContent,
          thinkingEncryptedProvider: event.thinkingEncryptedProvider
        }
      ]
    case 'image_generation_started':
      return [{ type: 'image_generation_started' }]
    case 'image_generation_partial':
      return [
        {
          type: 'image_generation_partial',
          imageBlock: event.imageBlock,
          ...(event.partialImageIndex !== undefined
            ? { partialImageIndex: event.partialImageIndex }
            : {})
        }
      ]
    case 'image_generated':
      return [{ type: 'image_generated', imageBlock: event.imageBlock }]
    case 'image_error':
      return [{ type: 'image_error', imageError: event.imageError }]
    case 'request_debug':
      return [{ type: 'request_debug', debugInfo: event.debugInfo }]
    case 'message_end':
      return [
        {
          type: 'message_end',
          usage: event.usage,
          timing: event.timing,
          providerResponseId: event.providerResponseId,
          stopReason: event.stopReason
        }
      ]
    case 'tool_use_streaming_start': {
      const toolCallId = event.toolCallId
      if (!toolCallId) return []
      startedToolIds.add(toolCallId)
      return [
        {
          type: 'tool_call_start',
          toolCallId,
          toolName: event.toolName,
          ...(event.toolCallExtraContent
            ? { toolCallExtraContent: event.toolCallExtraContent as ToolCallExtraContent }
            : {})
        }
      ]
    }
    case 'tool_use_generated': {
      const block = event.toolUseBlock
      if (!block?.id || !block.name) return []
      const events: StreamEvent[] = []
      if (!startedToolIds.has(block.id)) {
        startedToolIds.add(block.id)
        events.push({
          type: 'tool_call_start',
          toolCallId: block.id,
          toolName: block.name,
          ...(block.extraContent ? { toolCallExtraContent: block.extraContent } : {})
        })
      }
      events.push({
        type: 'tool_call_end',
        toolCallId: block.id,
        toolName: block.name,
        toolCallInput: normalizeProviderToolInput(block.input),
        ...(block.extraContent ? { toolCallExtraContent: block.extraContent } : {})
      })
      return events
    }
    case 'error':
      return [toProviderErrorEvent(event.error)]
    default:
      return []
  }
}

export async function* streamSidecarProviderTurn(args: {
  provider: ProviderConfig
  messages: UnifiedMessage[]
  tools: ToolDefinition[]
  signal?: AbortSignal
}): AsyncGenerator<StreamEvent> {
  if (!isNativeSidecarProviderConfig(args.provider)) {
    yield {
      type: 'error',
      error: {
        type: 'native_unavailable',
        message: `${args.provider.type} requires the .NET Native Worker for execution.`
      }
    }
    return
  }

  const sidecarRequest = buildSidecarAgentRunRequest({
    messages: args.messages,
    provider: args.provider,
    tools: args.tools,
    maxIterations: 1,
    forceApproval: false,
    providerTurnOnly: true
  })
  if (!sidecarRequest) {
    yield {
      type: 'error',
      error: {
        type: 'request_build_failed',
        message: 'Sidecar provider request build failed.'
      }
    }
    return
  }

  try {
    const supportsAgentRun = await canSidecarHandle('agent.run')
    const supportsProvider = await canSidecarHandle(`provider.${args.provider.type}`)
    if (!supportsAgentRun || !supportsProvider) {
      yield {
        type: 'error',
        error: {
          type: 'native_unavailable',
          message: `${args.provider.type} is not available in the .NET Native Worker.`
        }
      }
      return
    }

    const initialized = await agentBridge.initialize()
    if (!initialized) {
      yield {
        type: 'error',
        error: {
          type: 'native_unavailable',
          message: 'Sidecar unavailable.'
        }
      }
      return
    }

    const queue: StreamEvent[] = []
    const pendingEvents: Array<{ runId: string; event: { type: string; [key: string]: unknown } }> =
      []
    const startedToolIds = new Set<string>()
    let finished = false
    let notify: (() => void) | null = null
    let runId = ''
    let abortCleanup: (() => void) | null = null

    const wake = (): void => {
      if (!notify) return
      const resume = notify
      notify = null
      resume()
    }

    const pushProviderEvents = (events: StreamEvent[]): void => {
      if (events.length === 0) return
      for (const event of events) {
        queue.push(event)
      }
      if (events.some((event) => event.type === 'error')) {
        finished = true
      }
      wake()
    }

    const dispatchAgentEvent = (event: { type: string; [key: string]: unknown }): void => {
      if (event.type === 'loop_end') {
        finished = true
        wake()
        return
      }
      pushProviderEvents(
        mapAgentEventToProviderEvents(event as unknown as AgentEvent, startedToolIds)
      )
    }

    const unsubscribe = agentStream.subscribeAll((eventRunId, _sessionId, streamEvent) => {
      const event = toAgentEvent(streamEvent)
      if (!event) return

      if (!runId) {
        pendingEvents.push({
          runId: eventRunId,
          event: event as unknown as { type: string; [key: string]: unknown }
        })
        return
      }

      if (eventRunId && eventRunId !== runId) return
      dispatchAgentEvent(event as unknown as { type: string; [key: string]: unknown })
    })

    try {
      const result = await agentBridge.runAgent(sidecarRequest)
      runId = result.runId
      console.log('[AgentBridge] sidecar provider turn started', {
        runId,
        providerType: args.provider.type,
        model: args.provider.model
      })

      if (args.signal) {
        if (args.signal.aborted) {
          void agentBridge.cancelAgent(runId).catch(() => {})
          finished = true
        } else {
          const onAbort = (): void => {
            void agentBridge.cancelAgent(runId).catch(() => {})
            finished = true
            wake()
          }
          args.signal.addEventListener('abort', onAbort, { once: true })
          abortCleanup = () => args.signal?.removeEventListener('abort', onAbort)
        }
      }

      for (const pending of pendingEvents.splice(0, pendingEvents.length)) {
        if (pending.runId && pending.runId !== runId) continue
        dispatchAgentEvent(pending.event)
        if (finished) break
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
      unsubscribe()
    }
  } catch (error) {
    yield toProviderErrorEvent(error)
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

  if (!isNativeSidecarProviderConfig(provider)) {
    throw new Error('Sidecar capability unavailable')
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
  const pendingEvents: Array<{ runId: string; event: { type: string; [key: string]: unknown } }> =
    []

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
          pendingEvents.push({
            runId: eventRunId,
            event: event as unknown as { type: string; [key: string]: unknown }
          })
          return
        }

        if (eventRunId !== runId) return
        handleEvent(event as unknown as { type: string; [key: string]: unknown })
      })

      void (async () => {
        try {
          const result = await agentBridge.runAgent(sidecarRequest)
          runId = result.runId
          for (const pending of pendingEvents.splice(0, pendingEvents.length)) {
            if (pending.runId && pending.runId !== runId) continue
            handleEvent(pending.event)
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

export async function runSidecarContextCompression(args: {
  provider: ProviderConfig
  messages: UnifiedMessage[]
  signal?: AbortSignal
  preserveCount?: number
  focusPrompt?: string
  pinnedContext?: string
  trigger?: 'auto' | 'manual'
  preTokens?: number
}): Promise<{ messages: UnifiedMessage[]; result: CompressionResult }> {
  if (args.signal?.aborted) {
    throw new Error('aborted')
  }

  const initialized = await agentBridge.initialize()
  if (!initialized) {
    throw new Error('Sidecar unavailable')
  }

  const result = await invokeMessagePackBinary<{ messages: UnifiedMessage[]; result: CompressionResult }>(
    toMessagePackChannel('agent:compress-context'),
    {
      provider: args.provider,
      messages: args.messages,
      ...(typeof args.preserveCount === 'number' && Number.isFinite(args.preserveCount)
        ? { preserveCount: args.preserveCount }
        : {}),
      ...(args.focusPrompt ? { focusPrompt: args.focusPrompt } : {}),
      ...(args.pinnedContext ? { pinnedContext: args.pinnedContext } : {}),
      ...(args.trigger ? { trigger: args.trigger } : {}),
      ...(typeof args.preTokens === 'number' && Number.isFinite(args.preTokens)
        ? { preTokens: args.preTokens }
        : {})
    }
  )

  if (args.signal?.aborted) {
    throw new Error('aborted')
  }

  return result
}
