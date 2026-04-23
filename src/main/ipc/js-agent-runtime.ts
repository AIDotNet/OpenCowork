import { nanoid } from 'nanoid'
import type {
  AgentLoopConfig,
  ToolCallState,
  ToolContext,
  ToolResultContent
} from '../cron/cron-agent-background'
import { runInteractiveAgentLoop } from '../cron/cron-agent-background'
import type { AgentStreamEnvelope } from '../../shared/agent-stream-protocol'
import { AdaptiveEventBatcher } from './adaptive-event-batcher'

type EventHandler = (envelope: AgentStreamEnvelope) => void
type RequestHandler = (id: number | string, method: string, params: unknown) => Promise<unknown>

interface JsAgentRunRequest {
  runId?: string
  messages?: unknown[]
  provider?: unknown
  tools?: unknown[]
  sessionId?: string
  workingFolder?: string
  maxIterations?: number
  forceApproval?: boolean
  pluginId?: string
  pluginChatId?: string
  pluginChatType?: 'p2p' | 'group'
  pluginSenderId?: string
  pluginSenderName?: string
  sshConnectionId?: string
  captureFinalMessages?: boolean
}

type RuntimeMessage = Parameters<typeof runInteractiveAgentLoop>[0][number]

class RuntimeMessageQueue {
  private pending: RuntimeMessage[] = []

  pushMany(messages: RuntimeMessage[]): void {
    this.pending.push(...messages)
  }

  drain(): RuntimeMessage[] {
    if (this.pending.length === 0) return []
    const next = this.pending
    this.pending = []
    return next
  }
}

interface ActiveRun {
  controller: AbortController
  promise: Promise<void>
  sessionId?: string
  messageQueue: RuntimeMessageQueue
}

type RendererToolResult = {
  content: ToolResultContent
  isError?: boolean
  error?: string
}

function isRenderableToolResultArray(value: unknown): value is Exclude<ToolResultContent, string> {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!item || typeof item !== 'object') return false
      const block = item as { type?: unknown; text?: unknown; source?: unknown }
      if (block.type === 'text' && typeof block.text === 'string') return true
      if (block.type === 'image' && block.source && typeof block.source === 'object') {
        const source = block.source as { type?: unknown }
        return source.type === 'base64' || source.type === 'url'
      }
      return false
    })
  )
}

function normalizeRendererToolResult(value: unknown): RendererToolResult {
  if (!value || typeof value !== 'object') {
    return { content: '' }
  }

  const result = value as {
    content?: unknown
    isError?: boolean
    error?: string
  }

  if (typeof result.content === 'string') {
    return {
      content: result.content,
      isError: result.isError === true,
      ...(typeof result.error === 'string' ? { error: result.error } : {})
    }
  }

  if (isRenderableToolResultArray(result.content)) {
    return {
      content: result.content,
      isError: result.isError === true,
      ...(typeof result.error === 'string' ? { error: result.error } : {})
    }
  }

  return {
    content: typeof result.content === 'undefined' ? '' : JSON.stringify(result.content),
    isError: result.isError === true,
    ...(typeof result.error === 'string' ? { error: result.error } : {})
  }
}

export class JsAgentRuntimeManager {
  private running = false
  private onRequestFromSidecar: RequestHandler | null = null
  private activeRuns = new Map<string, ActiveRun>()
  private eventBatcher = new AdaptiveEventBatcher()

  setEventHandler(handler: EventHandler): void {
    this.eventBatcher.setHandler(handler)
  }

  setSessionVisibility(sessionId: string, visible: boolean): void {
    this.eventBatcher.setSessionVisibility(sessionId, visible)
  }

  setRequestHandler(handler: RequestHandler): void {
    this.onRequestFromSidecar = handler
  }

  get isRunning(): boolean {
    return this.running
  }

  async start(): Promise<boolean> {
    this.running = true
    return true
  }

  async ensureStarted(): Promise<boolean> {
    if (!this.running) {
      return this.start()
    }
    return true
  }

  async stop(): Promise<void> {
    this.running = false
    this.eventBatcher.stop()
    const runs = Array.from(this.activeRuns.values())
    for (const run of runs) {
      run.controller.abort()
    }
    await Promise.allSettled(runs.map((run) => run.promise))
    this.activeRuns.clear()
  }

  notify(method: string, params?: unknown): void {
    void method
    void params
    // No-op: the JS runtime does not require reverse notifications.
  }

  async request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    void timeoutMs
    switch (method) {
      case 'initialize':
      case 'ping':
        await this.ensureStarted()
        return { ok: true }
      case 'shutdown':
        await this.stop()
        return { ok: true }
      case 'capabilities/check': {
        const capability =
          params &&
          typeof params === 'object' &&
          typeof (params as { capability?: unknown }).capability === 'string'
            ? ((params as { capability: string }).capability ?? '')
            : ''
        return { supported: this.supportsCapability(capability) }
      }
      case 'agent/run':
        return this.startRun(params as JsAgentRunRequest)
      case 'agent/append-messages':
        return this.appendRunMessages(params)
      case 'agent/cancel':
        return this.cancelRun(params)
      case 'fs/grep':
        throw new Error('UNSUPPORTED_IN_JS_RUNTIME')
      default:
        throw new Error(`Unsupported JS runtime request: ${method}`)
    }
  }

  private supportsCapability(capability: string): boolean {
    if (!capability) return false
    if (capability === 'agent.run') return true
    if (capability === 'desktop.input') return true
    if (capability.startsWith('provider.')) {
      return true
    }
    return false
  }

  private emitAgentEvent(runId: string, sessionId: string | undefined, event: unknown): void {
    const record = event as Record<string, unknown>
    this.eventBatcher.push(runId, sessionId ?? '', record)
  }

  private async startRun(params: JsAgentRunRequest): Promise<{ started: true; runId: string }> {
    await this.ensureStarted()

    const runId =
      typeof params.runId === 'string' && params.runId.trim() ? params.runId.trim() : nanoid()
    const controller = new AbortController()
    const messageQueue = new RuntimeMessageQueue()

    const toolCtx: ToolContext = {
      sessionId: params.sessionId,
      workingFolder: params.workingFolder,
      signal: controller.signal,
      agentRunId: runId,
      ...(params.pluginId ? { pluginId: params.pluginId } : {}),
      ...(params.pluginChatId ? { pluginChatId: params.pluginChatId } : {}),
      ...(params.pluginChatType ? { pluginChatType: params.pluginChatType } : {}),
      ...(params.pluginSenderId ? { pluginSenderId: params.pluginSenderId } : {}),
      ...(params.pluginSenderName ? { pluginSenderName: params.pluginSenderName } : {}),
      ...(params.sshConnectionId ? { sshConnectionId: params.sshConnectionId } : {}),
      sharedState: {},
      fallbackToolExecutor: async (name, input, ctx) => {
        return await this.requestRendererTool(name, input, ctx)
      },
      resolveRequiresApproval: async (name, input, ctx) => {
        return await this.requestRendererApprovalProbe(name, input, ctx)
      }
    }

    const loopConfig: AgentLoopConfig = {
      maxIterations:
        typeof params.maxIterations === 'number' && Number.isFinite(params.maxIterations)
          ? params.maxIterations
          : 0,
      provider: (params.provider ?? {}) as AgentLoopConfig['provider'],
      tools: Array.isArray(params.tools) ? (params.tools as AgentLoopConfig['tools']) : [],
      signal: controller.signal,
      forceApproval: params.forceApproval === true,
      messageQueue,
      captureFinalMessages: params.captureFinalMessages === true,
      onApprovalNeeded: async (toolCall) => {
        return await this.requestUserApproval(runId, params.sessionId, toolCall)
      }
    }

    const sessionId = params.sessionId

    const runPromise = (async () => {
      try {
        const messages = Array.isArray(params.messages)
          ? (params.messages as Parameters<typeof runInteractiveAgentLoop>[0])
          : []
        let eventsSinceYield = 0
        for await (const event of runInteractiveAgentLoop(messages, loopConfig, toolCtx)) {
          this.emitAgentEvent(runId, sessionId, event)
          eventsSinceYield++
          if (eventsSinceYield >= 20) {
            eventsSinceYield = 0
            await new Promise<void>((r) => setImmediate(r))
          }
        }
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error))
        this.emitAgentEvent(runId, sessionId, {
          type: 'error',
          error: {
            message: normalized.message,
            type: normalized.name
          },
          errorType: normalized.name,
          details: normalized.message,
          stackTrace: normalized.stack
        })
        this.emitAgentEvent(runId, sessionId, {
          type: 'loop_end',
          reason: controller.signal.aborted ? 'aborted' : 'error'
        })
      } finally {
        this.eventBatcher.flush(runId)
        this.eventBatcher.cleanupRun(runId)
        this.activeRuns.delete(runId)
      }
    })()

    this.activeRuns.set(runId, {
      controller,
      promise: runPromise,
      sessionId: params.sessionId,
      messageQueue
    })

    return { started: true, runId }
  }

  private async appendRunMessages(
    params: unknown
  ): Promise<{ appended: boolean; runId?: string; count: number }> {
    const runId =
      params &&
      typeof params === 'object' &&
      typeof (params as { runId?: unknown }).runId === 'string'
        ? ((params as { runId: string }).runId ?? '')
        : ''

    if (!runId) {
      return { appended: false, count: 0 }
    }

    const activeRun = this.activeRuns.get(runId)
    if (!activeRun) {
      return { appended: false, runId, count: 0 }
    }

    const messages =
      params &&
      typeof params === 'object' &&
      Array.isArray((params as { messages?: unknown[] }).messages)
        ? ((params as { messages: RuntimeMessage[] }).messages ?? [])
        : []

    if (messages.length > 0) {
      activeRun.messageQueue.pushMany(messages)
    }

    return { appended: true, runId, count: messages.length }
  }

  private async cancelRun(params: unknown): Promise<{ cancelled: boolean; runId?: string }> {
    const runId =
      params &&
      typeof params === 'object' &&
      typeof (params as { runId?: unknown }).runId === 'string'
        ? ((params as { runId: string }).runId ?? '')
        : ''

    if (!runId) {
      return { cancelled: false }
    }

    const activeRun = this.activeRuns.get(runId)
    if (!activeRun) {
      return { cancelled: false, runId }
    }

    activeRun.controller.abort()
    return { cancelled: true, runId }
  }

  private async requestUserApproval(
    runId: string,
    sessionId: string | undefined,
    toolCall: ToolCallState
  ): Promise<boolean> {
    if (!this.onRequestFromSidecar) return false

    const requestId = `js-runtime-approval-${runId}-${toolCall.id}-${nanoid(6)}`
    const result = (await this.onRequestFromSidecar(requestId, 'approval/request', {
      runId,
      ...(sessionId ? { sessionId } : {}),
      toolCall
    })) as { approved?: boolean } | null

    return result?.approved === true
  }

  private async requestRendererApprovalProbe(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<boolean> {
    if (!this.onRequestFromSidecar) return true

    const requestId = `js-runtime-approval-probe-${nanoid(8)}`
    const result = (await this.onRequestFromSidecar(requestId, 'renderer/tool-request', {
      toolName: `${name}#requiresApproval`,
      input,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.workingFolder ? { workingFolder: ctx.workingFolder } : {}),
      ...(ctx.currentToolUseId ? { currentToolUseId: ctx.currentToolUseId } : {}),
      ...(ctx.agentRunId ? { agentRunId: ctx.agentRunId } : {}),
      ...(ctx.pluginId ? { pluginId: ctx.pluginId } : {}),
      ...(ctx.pluginChatId ? { pluginChatId: ctx.pluginChatId } : {}),
      ...(ctx.pluginChatType ? { pluginChatType: ctx.pluginChatType } : {}),
      ...(ctx.pluginSenderId ? { pluginSenderId: ctx.pluginSenderId } : {}),
      ...(ctx.pluginSenderName ? { pluginSenderName: ctx.pluginSenderName } : {}),
      ...(ctx.sshConnectionId ? { sshConnectionId: ctx.sshConnectionId } : {})
    })) as { requiresApproval?: boolean } | null

    return result?.requiresApproval === true
  }

  private async requestRendererTool(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<RendererToolResult> {
    if (!this.onRequestFromSidecar) {
      return {
        content: '',
        isError: true,
        error: `No renderer tool bridge for ${name}`
      }
    }

    const requestId = `js-runtime-tool-${nanoid(8)}`
    const result = await this.onRequestFromSidecar(requestId, 'renderer/tool-request', {
      toolName: name,
      input,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.workingFolder ? { workingFolder: ctx.workingFolder } : {}),
      ...(ctx.currentToolUseId ? { currentToolUseId: ctx.currentToolUseId } : {}),
      ...(ctx.agentRunId ? { agentRunId: ctx.agentRunId } : {}),
      ...(ctx.pluginId ? { pluginId: ctx.pluginId } : {}),
      ...(ctx.pluginChatId ? { pluginChatId: ctx.pluginChatId } : {}),
      ...(ctx.pluginChatType ? { pluginChatType: ctx.pluginChatType } : {}),
      ...(ctx.pluginSenderId ? { pluginSenderId: ctx.pluginSenderId } : {}),
      ...(ctx.pluginSenderName ? { pluginSenderName: ctx.pluginSenderName } : {}),
      ...(ctx.sshConnectionId ? { sshConnectionId: ctx.sshConnectionId } : {})
    })

    return normalizeRendererToolResult(result)
  }
}
