import type {
  AgentStreamEnvelope,
  AgentStreamEvent,
  ToolCallStateWire,
  ToolResultWire,
  TokenUsageWire,
  RequestTimingWire,
  ImageBlockWire,
  ImageErrorWire,
  RequestDebugInfoWire,
  MessageWire,
  ContentBlockWire,
  ToolCallExtraContentWire
} from '../../shared/agent-stream-protocol'
import {
  AGENT_STREAM_PROTOCOL_VERSION,
  AGGREGATABLE_EVENT_TYPES
} from '../../shared/agent-stream-protocol'

// ---- Configuration ----

export interface AdaptiveEventBatcherConfig {
  foregroundFlushMs: number
  backgroundFlushMs: number
  maxBufferSize: number
  idleTimeoutMs: number
}

const DEFAULT_CONFIG: AdaptiveEventBatcherConfig = {
  foregroundFlushMs: 33,
  backgroundFlushMs: 150,
  maxBufferSize: 200,
  idleTimeoutMs: 200
}

// ---- Per-run accumulator state ----

interface RunAccumulator {
  runId: string
  sessionId: string
  seq: number
  textDelta: string
  thinkingDelta: string
  toolArgsDelta: Map<string, Record<string, unknown>>
  pendingControl: AgentStreamEvent[]
  timer: ReturnType<typeof setTimeout> | null
  lastEventAt: number
}

// ---- Batcher ----

export type EnvelopeHandler = (envelope: AgentStreamEnvelope) => void

export class AdaptiveEventBatcher {
  private config: AdaptiveEventBatcherConfig
  private runs = new Map<string, RunAccumulator>()
  private visibleSessions = new Set<string>()
  private handler: EnvelopeHandler | null = null

  constructor(config?: Partial<AdaptiveEventBatcherConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  setHandler(handler: EnvelopeHandler): void {
    this.handler = handler
  }

  setSessionVisibility(sessionId: string, visible: boolean): void {
    if (visible) {
      this.visibleSessions.add(sessionId)
    } else {
      this.visibleSessions.delete(sessionId)
    }
  }

  push(runId: string, sessionId: string, rawEvent: Record<string, unknown>): void {
    const event = mapToStreamEvent(rawEvent)
    if (!event) return

    let acc = this.runs.get(runId)
    if (!acc) {
      acc = {
        runId,
        sessionId,
        seq: 0,
        textDelta: '',
        thinkingDelta: '',
        toolArgsDelta: new Map(),
        pendingControl: [],
        timer: null,
        lastEventAt: Date.now()
      }
      this.runs.set(runId, acc)
    }
    acc.lastEventAt = Date.now()

    if (AGGREGATABLE_EVENT_TYPES.has(event.type)) {
      this.accumulate(acc, event)
      this.scheduleFlush(acc)
      return
    }

    // Control event: flush pending deltas first (preserve ordering), then send immediately
    this.flushAccumulated(acc)
    this.emit(acc, [event])

    // Clean up run state on terminal events
    if (event.type === 'loop_end' || event.type === 'error') {
      this.cleanupRun(runId)
    }
  }

  flush(runId: string): void {
    const acc = this.runs.get(runId)
    if (acc) this.flushAccumulated(acc)
  }

  flushAll(): void {
    for (const acc of this.runs.values()) {
      this.flushAccumulated(acc)
    }
  }

  stop(): void {
    for (const acc of this.runs.values()) {
      this.flushAccumulated(acc)
      if (acc.timer !== null) {
        clearTimeout(acc.timer)
        acc.timer = null
      }
    }
    this.runs.clear()
  }

  cleanupRun(runId: string): void {
    const acc = this.runs.get(runId)
    if (!acc) return
    if (acc.timer !== null) {
      clearTimeout(acc.timer)
      acc.timer = null
    }
    this.runs.delete(runId)
  }

  // ---- Internal ----

  private accumulate(acc: RunAccumulator, event: AgentStreamEvent): void {
    switch (event.type) {
      case 'text_delta':
        acc.textDelta += event.text
        break
      case 'thinking_delta':
        acc.thinkingDelta += event.thinking
        break
      case 'tool_use_args_delta':
        acc.toolArgsDelta.set(event.toolCallId, event.partialInput)
        break
    }

    if (this.accumulatedSize(acc) >= this.config.maxBufferSize) {
      this.flushAccumulated(acc)
    }
  }

  private accumulatedSize(acc: RunAccumulator): number {
    return acc.textDelta.length + acc.thinkingDelta.length + acc.toolArgsDelta.size
  }

  private flushAccumulated(acc: RunAccumulator): void {
    if (acc.timer !== null) {
      clearTimeout(acc.timer)
      acc.timer = null
    }

    const events: AgentStreamEvent[] = []

    if (acc.textDelta) {
      events.push({ type: 'text_delta', text: acc.textDelta })
      acc.textDelta = ''
    }

    if (acc.thinkingDelta) {
      events.push({ type: 'thinking_delta', thinking: acc.thinkingDelta })
      acc.thinkingDelta = ''
    }

    for (const [toolCallId, partialInput] of acc.toolArgsDelta) {
      events.push({ type: 'tool_use_args_delta', toolCallId, partialInput })
    }
    acc.toolArgsDelta.clear()

    if (events.length > 0) {
      this.emit(acc, events)
    }
  }

  private scheduleFlush(acc: RunAccumulator): void {
    if (acc.timer !== null) return

    const intervalMs = this.visibleSessions.has(acc.sessionId)
      ? this.config.foregroundFlushMs
      : this.config.backgroundFlushMs

    acc.timer = setTimeout(() => {
      acc.timer = null
      this.flushAccumulated(acc)
    }, intervalMs)
  }

  private emit(acc: RunAccumulator, events: AgentStreamEvent[]): void {
    if (events.length === 0 || !this.handler) return

    const envelope: AgentStreamEnvelope = {
      v: AGENT_STREAM_PROTOCOL_VERSION,
      runId: acc.runId,
      sessionId: acc.sessionId,
      seq: acc.seq++,
      events
    }
    this.handler(envelope)
  }
}

// ---- Event mapping: InteractiveAgentEvent (Record) → AgentStreamEvent ----

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown): boolean {
  return value === true
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function mapToolCallState(raw: unknown): ToolCallStateWire | null {
  const tc = rec(raw)
  const id = str(tc.id)
  const name = str(tc.name)
  if (!id) return null

  const statusRaw = str(tc.status, 'completed')
  const status =
    statusRaw === 'streaming' ||
    statusRaw === 'pending_approval' ||
    statusRaw === 'running' ||
    statusRaw === 'completed' ||
    statusRaw === 'error' ||
    statusRaw === 'canceled'
      ? statusRaw
      : 'completed'

  return {
    id,
    name,
    input: rec(tc.input),
    status,
    ...(tc.output !== undefined ? { output: normalizeToolOutput(tc.output) } : {}),
    ...(typeof tc.error === 'string' ? { error: tc.error } : {}),
    requiresApproval: bool(tc.requiresApproval),
    ...(tc.extraContent ? { extraContent: tc.extraContent as ToolCallExtraContentWire } : {}),
    ...(tc.startedAt !== undefined ? { startedAt: num(tc.startedAt, Date.now()) } : {}),
    ...(tc.completedAt !== undefined ? { completedAt: num(tc.completedAt, Date.now()) } : {})
  }
}

function normalizeToolOutput(
  value: unknown
): string | Array<{ type: 'text'; text: string } | ImageBlockWire> {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const blocks = value
      .map((item) => {
        const block = rec(item)
        if (block.type === 'text' && typeof block.text === 'string') {
          return { type: 'text' as const, text: block.text }
        }
        if (block.type === 'image') {
          const source = rec(block.source)
          if (source.type === 'base64' || source.type === 'url') {
            return {
              type: 'image' as const,
              source: {
                type: source.type as 'base64' | 'url',
                ...(typeof source.mediaType === 'string' ? { mediaType: source.mediaType } : {}),
                ...(typeof source.data === 'string' ? { data: source.data } : {}),
                ...(typeof source.url === 'string' ? { url: source.url } : {}),
                ...(typeof source.filePath === 'string' ? { filePath: source.filePath } : {})
              }
            }
          }
        }
        return null
      })
      .filter((b): b is Exclude<typeof b, null> => b !== null)
    if (blocks.length === value.length && blocks.length > 0) return blocks
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  if (value !== null && value !== undefined) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return ''
}

function mapImageBlock(raw: unknown): ImageBlockWire | null {
  const block = rec(raw)
  const source = rec(block.source)
  const sourceType = source.type === 'base64' ? 'base64' : source.type === 'url' ? 'url' : null
  if (!sourceType) return null
  return {
    type: 'image',
    source: {
      type: sourceType,
      ...(typeof source.mediaType === 'string' ? { mediaType: source.mediaType } : {}),
      ...(typeof source.data === 'string' ? { data: source.data } : {}),
      ...(typeof source.url === 'string' ? { url: source.url } : {}),
      ...(typeof source.filePath === 'string' ? { filePath: source.filePath } : {})
    }
  }
}

function mapContentBlock(raw: unknown): ContentBlockWire | null {
  const block = rec(raw)
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { type: 'text', text: block.text } : null
    case 'image':
      return mapImageBlock(raw)
    case 'image_error':
      return { type: 'image_error', code: str(block.code, 'unknown'), message: str(block.message) }
    case 'agent_error': {
      const code =
        block.code === 'runtime_error' || block.code === 'tool_error' ? block.code : 'unknown'
      return {
        type: 'agent_error',
        code,
        message: str(block.message),
        ...(typeof block.errorType === 'string' ? { errorType: block.errorType } : {}),
        ...(typeof block.details === 'string' ? { details: block.details } : {}),
        ...(typeof block.stackTrace === 'string' ? { stackTrace: block.stackTrace } : {})
      }
    }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: str(block.id),
        name: str(block.name),
        input: rec(block.input),
        ...(block.extraContent
          ? { extraContent: block.extraContent as ToolCallExtraContentWire }
          : {})
      }
    case 'tool_result': {
      const content = normalizeToolOutput(block.content)
      return {
        type: 'tool_result',
        toolUseId: str(block.toolUseId),
        content,
        ...(typeof block.isError === 'boolean' ? { isError: block.isError } : {})
      }
    }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: str(block.thinking),
        ...(typeof block.encryptedContent === 'string'
          ? { encryptedContent: block.encryptedContent }
          : {}),
        ...(block.encryptedContentProvider === 'anthropic' ||
        block.encryptedContentProvider === 'openai-responses' ||
        block.encryptedContentProvider === 'google'
          ? { encryptedContentProvider: block.encryptedContentProvider }
          : {})
      }
    default:
      return null
  }
}

function mapMessage(raw: unknown): MessageWire | null {
  const msg = rec(raw)
  const id = str(msg.id)
  const role = msg.role
  if (!id || (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool')) {
    return null
  }

  let content: string | ContentBlockWire[]
  if (typeof msg.content === 'string') {
    content = msg.content
  } else if (Array.isArray(msg.content)) {
    content = msg.content
      .map((b) => mapContentBlock(b))
      .filter((b): b is ContentBlockWire => b !== null)
  } else {
    content = ''
  }

  return {
    id,
    role,
    content,
    createdAt: num(msg.createdAt, Date.now()),
    ...(msg.usage ? { usage: msg.usage as TokenUsageWire } : {}),
    ...(typeof msg.providerResponseId === 'string'
      ? { providerResponseId: msg.providerResponseId }
      : {}),
    ...(msg.source === 'team' || msg.source === 'queued' ? { source: msg.source } : {}),
    ...(msg.meta && typeof msg.meta === 'object'
      ? { meta: msg.meta as Record<string, unknown> }
      : {})
  }
}

function mapToolResults(raw: unknown): ToolResultWire[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const results = raw
    .map((item) => {
      const r = rec(item)
      const toolUseId = str(r.toolUseId)
      if (!toolUseId) return null
      return {
        toolUseId,
        content: normalizeToolOutput(r.content),
        ...(typeof r.isError === 'boolean' ? { isError: r.isError } : {})
      }
    })
    .filter((r): r is ToolResultWire => r !== null)
  return results.length > 0 ? results : undefined
}

function mapToStreamEvent(raw: Record<string, unknown>): AgentStreamEvent | null {
  const type = str(raw.type)
  if (!type) return null

  switch (type) {
    // Lifecycle
    case 'loop_start':
      return { type: 'loop_start' }
    case 'iteration_start':
      return { type: 'iteration_start', iteration: num(raw.iteration) }
    case 'iteration_end':
      return {
        type: 'iteration_end',
        stopReason: str(raw.stopReason, 'tool_use'),
        ...(Array.isArray(raw.toolResults) ? { toolResults: mapToolResults(raw.toolResults) } : {})
      }
    case 'loop_end': {
      const reason = raw.reason
      const messages = Array.isArray(raw.messages)
        ? raw.messages.map((m) => mapMessage(m)).filter((m): m is MessageWire => m !== null)
        : undefined
      return {
        type: 'loop_end',
        reason:
          reason === 'completed' ||
          reason === 'max_iterations' ||
          reason === 'aborted' ||
          reason === 'error'
            ? reason
            : 'error',
        ...(messages && messages.length > 0 ? { messages } : {})
      }
    }

    // Streaming deltas
    case 'text_delta':
      return { type: 'text_delta', text: str(raw.text) }
    case 'thinking_delta':
      return { type: 'thinking_delta', thinking: str(raw.thinking) }
    case 'thinking_encrypted': {
      const provider = raw.thinkingEncryptedProvider
      if (provider !== 'anthropic' && provider !== 'openai-responses' && provider !== 'google')
        return null
      return {
        type: 'thinking_encrypted',
        content: str(raw.thinkingEncryptedContent),
        provider
      }
    }

    // Image generation
    case 'image_generation_started':
      return { type: 'image_generation_started' }
    case 'image_generation_partial': {
      const imageBlock = mapImageBlock(raw.imageBlock)
      if (!imageBlock) return null
      return {
        type: 'image_generation_partial',
        imageBlock,
        ...(typeof raw.partialImageIndex === 'number'
          ? { partialImageIndex: raw.partialImageIndex }
          : {})
      }
    }
    case 'image_generated': {
      const imageBlock = mapImageBlock(raw.imageBlock)
      if (!imageBlock) return null
      return { type: 'image_generated', imageBlock }
    }
    case 'image_error': {
      const ie = rec(raw.imageError)
      return {
        type: 'image_error',
        imageError: {
          code: str(ie.code, 'unknown') as ImageErrorWire['code'],
          message: str(ie.message)
        }
      }
    }

    // Message completion
    case 'message_end':
      return {
        type: 'message_end',
        ...(raw.usage ? { usage: raw.usage as TokenUsageWire } : {}),
        ...(raw.timing ? { timing: raw.timing as RequestTimingWire } : {}),
        ...(typeof raw.providerResponseId === 'string'
          ? { providerResponseId: raw.providerResponseId }
          : {}),
        ...(typeof raw.stopReason === 'string' ? { stopReason: raw.stopReason } : {})
      }

    // Tool streaming
    case 'tool_use_streaming_start':
      return {
        type: 'tool_use_streaming_start',
        toolCallId: str(raw.toolCallId),
        toolName: str(raw.toolName),
        ...(raw.toolCallExtraContent
          ? { extraContent: raw.toolCallExtraContent as ToolCallExtraContentWire }
          : {})
      }
    case 'tool_use_args_delta':
      return {
        type: 'tool_use_args_delta',
        toolCallId: str(raw.toolCallId),
        partialInput: rec(raw.partialInput)
      }
    case 'tool_use_generated': {
      const tub = rec(raw.toolUseBlock)
      return {
        type: 'tool_use_generated',
        toolUseBlock: {
          id: str(tub.id),
          name: str(tub.name),
          input: rec(tub.input),
          ...(tub.extraContent
            ? { extraContent: tub.extraContent as ToolCallExtraContentWire }
            : {})
        }
      }
    }

    // Tool execution
    case 'tool_call_start': {
      const tc = mapToolCallState(raw.toolCall)
      if (!tc) return null
      return { type: 'tool_call_start', toolCall: tc }
    }
    case 'tool_call_approval_needed': {
      const tc = mapToolCallState(raw.toolCall)
      if (!tc) return null
      return { type: 'tool_call_approval_needed', toolCall: tc }
    }
    case 'tool_call_result': {
      const tc = mapToolCallState(raw.toolCall)
      if (!tc) return null
      return { type: 'tool_call_result', toolCall: tc }
    }

    // Retry / error
    case 'request_retry':
      return {
        type: 'request_retry',
        attempt: Math.max(1, num(raw.attempt, 1)),
        maxAttempts: Math.max(1, num(raw.maxAttempts, 1)),
        delayMs: Math.max(0, num(raw.delayMs)),
        ...(typeof raw.statusCode === 'number' ? { statusCode: raw.statusCode } : {}),
        reason: str(raw.reason)
      }
    case 'error': {
      const nested = rec(raw.error)
      return {
        type: 'error',
        message: str(nested.message) || str(raw.message) || str(raw.details) || 'Unknown error',
        ...(typeof (nested.type ?? raw.errorType) === 'string'
          ? { errorType: str(nested.type ?? raw.errorType) }
          : {}),
        ...(typeof (nested.details ?? raw.details) === 'string'
          ? { details: str(nested.details ?? raw.details) }
          : {}),
        ...(typeof (nested.stackTrace ?? raw.stackTrace) === 'string'
          ? { stackTrace: str(nested.stackTrace ?? raw.stackTrace) }
          : {})
      }
    }

    // Debug / compression
    case 'request_debug':
      return {
        type: 'request_debug',
        debugInfo: rec(raw.debugInfo) as unknown as RequestDebugInfoWire
      }
    case 'context_compression_start':
      return { type: 'context_compression_start' }
    case 'context_compressed': {
      const messages = Array.isArray(raw.messages)
        ? raw.messages.map((m) => mapMessage(m)).filter((m): m is MessageWire => m !== null)
        : undefined
      return {
        type: 'context_compressed',
        originalCount: num(raw.originalCount),
        newCount: num(raw.newCount ?? raw.compressedCount),
        ...(messages && messages.length > 0 ? { messages } : {})
      }
    }

    // Sub-agent events
    case 'sub_agent_start': {
      const promptMessage = mapMessage(raw.promptMessage)
      if (!promptMessage) return null
      return {
        type: 'sub_agent_start',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        input: rec(raw.input),
        promptMessage
      }
    }
    case 'sub_agent_iteration': {
      const assistantMessage = mapMessage(raw.assistantMessage)
      if (!assistantMessage) return null
      return {
        type: 'sub_agent_iteration',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        iteration: num(raw.iteration),
        assistantMessage
      }
    }
    case 'sub_agent_text_delta':
      return {
        type: 'sub_agent_text_delta',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        text: str(raw.text)
      }
    case 'sub_agent_thinking_delta':
      return {
        type: 'sub_agent_thinking_delta',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        thinking: str(raw.thinking)
      }
    case 'sub_agent_thinking_encrypted': {
      const provider = raw.thinkingEncryptedProvider
      if (provider !== 'anthropic' && provider !== 'openai-responses' && provider !== 'google')
        return null
      return {
        type: 'sub_agent_thinking_encrypted',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        thinkingEncryptedContent: str(raw.thinkingEncryptedContent),
        thinkingEncryptedProvider: provider
      }
    }
    case 'sub_agent_tool_use_streaming_start':
      return {
        type: 'sub_agent_tool_use_streaming_start',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        toolCallId: str(raw.toolCallId),
        toolName: str(raw.toolName),
        ...(raw.toolCallExtraContent
          ? { toolCallExtraContent: raw.toolCallExtraContent as ToolCallExtraContentWire }
          : {})
      }
    case 'sub_agent_tool_use_args_delta':
      return {
        type: 'sub_agent_tool_use_args_delta',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        toolCallId: str(raw.toolCallId),
        partialInput: rec(raw.partialInput)
      }
    case 'sub_agent_tool_use_generated': {
      const tub = rec(raw.toolUseBlock)
      return {
        type: 'sub_agent_tool_use_generated',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        toolUseBlock: {
          type: 'tool_use',
          id: str(tub.id),
          name: str(tub.name),
          input: rec(tub.input),
          ...(tub.extraContent
            ? { extraContent: tub.extraContent as ToolCallExtraContentWire }
            : {})
        }
      }
    }
    case 'sub_agent_image_generated': {
      const imageBlock = mapImageBlock(raw.imageBlock)
      if (!imageBlock) return null
      return {
        type: 'sub_agent_image_generated',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        imageBlock
      }
    }
    case 'sub_agent_image_error': {
      const ie = rec(raw.imageError)
      return {
        type: 'sub_agent_image_error',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        imageError: {
          code: str(ie.code, 'unknown') as ImageErrorWire['code'],
          message: str(ie.message)
        }
      }
    }
    case 'sub_agent_message_end':
      return {
        type: 'sub_agent_message_end',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        ...(raw.usage ? { usage: raw.usage as TokenUsageWire } : {}),
        ...(typeof raw.providerResponseId === 'string'
          ? { providerResponseId: raw.providerResponseId }
          : {})
      }
    case 'sub_agent_tool_result_message': {
      const message = mapMessage(raw.message)
      if (!message) return null
      return {
        type: 'sub_agent_tool_result_message',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        message
      }
    }
    case 'sub_agent_user_message': {
      const message = mapMessage(raw.message)
      if (!message) return null
      return {
        type: 'sub_agent_user_message',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        message
      }
    }
    case 'sub_agent_report_update': {
      const status = raw.status
      return {
        type: 'sub_agent_report_update',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        report: str(raw.report),
        status:
          status === 'submitted' ||
          status === 'retrying' ||
          status === 'fallback' ||
          status === 'missing'
            ? status
            : 'pending'
      }
    }
    case 'sub_agent_tool_call': {
      const tc = mapToolCallState(raw.toolCall)
      if (!tc) return null
      return {
        type: 'sub_agent_tool_call',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        toolCall: tc
      }
    }
    case 'sub_agent_end': {
      const result = rec(raw.result)
      return {
        type: 'sub_agent_end',
        subAgentName: str(raw.subAgentName),
        toolUseId: str(raw.toolUseId),
        result: {
          success: bool(result.success),
          output: str(result.output),
          ...(typeof result.reportSubmitted === 'boolean'
            ? { reportSubmitted: result.reportSubmitted }
            : {}),
          toolCallCount: num(result.toolCallCount),
          iterations: num(result.iterations),
          usage: (result.usage as TokenUsageWire) ?? { inputTokens: 0, outputTokens: 0 },
          ...(typeof result.error === 'string' ? { error: result.error } : {})
        }
      }
    }

    default:
      return null
  }
}
