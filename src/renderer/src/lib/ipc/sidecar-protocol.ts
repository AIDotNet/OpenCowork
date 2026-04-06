import { Allow, parse as parsePartialJSON } from 'partial-json'
import type {
  ContentBlock,
  ProviderConfig,
  RequestDebugInfo,
  RequestTiming,
  TokenUsage,
  ToolDefinition,
  ToolResultContent,
  UnifiedMessage
} from '../api/types'
import type { AgentEvent, ToolCallState } from '../agent/types'
import type { CompressionConfig } from '../agent/context-compression'

export interface SidecarTextBlock {
  type: 'text'
  text: string
}

export interface SidecarImageBlock {
  type: 'image'
  source: {
    type: 'base64' | 'url'
    mediaType?: string
    data?: string
    url?: string
    filePath?: string
  }
}

export interface SidecarToolCallExtraContent {
  google?: {
    thought_signature?: string
  }
  openaiResponses?: {
    computerUse?: {
      kind: 'computer_use'
      computerCallId: string
      computerActionType: string
      computerActionIndex: number
      autoAddedScreenshot?: boolean
    }
  }
}

export interface SidecarToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  extraContent?: SidecarToolCallExtraContent
}

export interface SidecarToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  content: ToolResultContent
  isError?: boolean
}

export interface SidecarThinkingBlock {
  type: 'thinking'
  thinking: string
  encryptedContent?: string
  encryptedContentProvider?: 'anthropic' | 'openai-responses' | 'google'
}

export type SidecarContentBlock =
  | SidecarTextBlock
  | SidecarImageBlock
  | SidecarToolUseBlock
  | SidecarToolResultBlock
  | SidecarThinkingBlock

export interface SidecarUnifiedMessage {
  id: string
  role: UnifiedMessage['role']
  content: string | SidecarContentBlock[]
  createdAt: number
  usage?: TokenUsage
  providerResponseId?: string
  source?: UnifiedMessage['source']
}

export interface SidecarProviderConfig {
  type: 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini'
  apiKey: string
  baseUrl?: string
  model: string
  category?: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  useSystemProxy?: boolean
  thinkingEnabled?: boolean
  thinkingConfig?: ProviderConfig['thinkingConfig']
  reasoningEffort?: string
  providerId?: string
  providerBuiltinId?: string
  userAgent?: string
  sessionId?: string
  serviceTier?: string
  enablePromptCache?: boolean
  enableSystemPromptCache?: boolean
  promptCacheKey?: string
  requestOverrides?: ProviderConfig['requestOverrides']
  instructionsPrompt?: string
  responseSummary?: string
  computerUseEnabled?: boolean
  organization?: string
  project?: string
  accountId?: string
}

export interface SidecarToolDefinition {
  name: string
  description: string
  inputSchema: ToolDefinition['inputSchema']
}

export interface SidecarAgentRunRequest {
  messages: SidecarUnifiedMessage[]
  provider: SidecarProviderConfig
  tools: SidecarToolDefinition[]
  sessionId?: string
  workingFolder?: string
  maxIterations: number
  forceApproval: boolean
  compression?: CompressionConfig
}

export interface SidecarApprovalRequest {
  runId?: string
  sessionId?: string
  toolCall: ToolCallState
}

export interface SidecarApprovalResponse {
  approved: boolean
  reason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeSidecarRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function readSidecarString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function createSidecarError(rawEvent: unknown): Error {
  const event = normalizeSidecarRecord(rawEvent)
  const nestedError = normalizeSidecarRecord(event.error)
  const message =
    readSidecarString(nestedError.message) ??
    readSidecarString(event.message) ??
    'Unknown sidecar error'
  const name =
    readSidecarString(nestedError.type) ?? readSidecarString(event.errorType) ?? 'SidecarError'
  const details = readSidecarString(nestedError.details) ?? readSidecarString(event.details)
  const stackTrace =
    readSidecarString(nestedError.stackTrace) ?? readSidecarString(event.stackTrace)

  const error = new Error(message)
  error.name = name

  const stackLines = [details, stackTrace].filter((value): value is string => Boolean(value))
  if (stackLines.length > 0) {
    error.stack = `${name}: ${message}\n${stackLines.join('\n')}`
  }

  return error
}

function hasUnsupportedProviderFeatures(provider: ProviderConfig): boolean {
  if (
    provider.type !== 'anthropic' &&
    provider.type !== 'openai-chat' &&
    provider.type !== 'openai-responses' &&
    provider.type !== 'gemini'
  ) {
    return true
  }

  if (provider.type === 'gemini') {
    if (provider.category === 'image') return true
    if (/image/i.test(provider.model)) return true
  }

  return false
}

function mapSidecarContentBlock(block: ContentBlock): SidecarContentBlock | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image':
      if (block.source.type !== 'base64' && block.source.type !== 'url') {
        return {
          type: 'text',
          text: block.source.filePath
            ? `[image] ${block.source.filePath}`
            : block.source.url
              ? `[image] ${block.source.url}`
              : '[image omitted: unsupported source]'
        }
      }
      return {
        type: 'image',
        source: {
          type: block.source.type,
          ...(block.source.mediaType ? { mediaType: block.source.mediaType } : {}),
          ...(block.source.data ? { data: block.source.data } : {}),
          ...(block.source.url ? { url: block.source.url } : {}),
          ...(block.source.filePath ? { filePath: block.source.filePath } : {})
        }
      }
    case 'image_error':
      return {
        type: 'text',
        text: `[image_error:${block.code}] ${block.message}`
      }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
        ...(block.extraContent ? { extraContent: block.extraContent } : {})
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: block.toolUseId,
        content: block.content,
        ...(block.isError ? { isError: true } : {})
      }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        ...(block.encryptedContent ? { encryptedContent: block.encryptedContent } : {}),
        ...(block.encryptedContentProvider
          ? { encryptedContentProvider: block.encryptedContentProvider }
          : {})
      }
    default:
      return null
  }
}

function mapSidecarMessage(message: UnifiedMessage): SidecarUnifiedMessage | null {
  if (typeof message.content === 'string') {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      ...(message.usage ? { usage: message.usage } : {}),
      ...(message.providerResponseId ? { providerResponseId: message.providerResponseId } : {}),
      ...(message.source ? { source: message.source } : {})
    }
  }

  const content: SidecarContentBlock[] = []
  for (const block of message.content) {
    const mapped = mapSidecarContentBlock(block)
    if (!mapped) continue
    content.push(mapped)
  }

  return {
    id: message.id,
    role: message.role,
    content: content.length > 0 ? content : '[empty content omitted during sidecar normalization]',
    createdAt: message.createdAt,
    ...(message.usage ? { usage: message.usage } : {}),
    ...(message.providerResponseId ? { providerResponseId: message.providerResponseId } : {}),
    ...(message.source ? { source: message.source } : {})
  }
}

function mapSidecarProvider(provider: ProviderConfig): SidecarProviderConfig | null {
  if (hasUnsupportedProviderFeatures(provider)) return null
  if (
    provider.type !== 'anthropic' &&
    provider.type !== 'openai-chat' &&
    provider.type !== 'openai-responses' &&
    provider.type !== 'gemini'
  ) {
    return null
  }

  return {
    type: provider.type,
    apiKey: provider.apiKey,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    model: provider.model,
    ...(provider.category ? { category: provider.category } : {}),
    ...(provider.maxTokens !== undefined ? { maxTokens: provider.maxTokens } : {}),
    ...(provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
    ...(provider.systemPrompt ? { systemPrompt: provider.systemPrompt } : {}),
    ...(provider.useSystemProxy !== undefined ? { useSystemProxy: provider.useSystemProxy } : {}),
    ...(provider.thinkingEnabled !== undefined ? { thinkingEnabled: provider.thinkingEnabled } : {}),
    ...(provider.thinkingConfig ? { thinkingConfig: provider.thinkingConfig } : {}),
    ...(provider.reasoningEffort ? { reasoningEffort: provider.reasoningEffort } : {}),
    ...(provider.providerId ? { providerId: provider.providerId } : {}),
    ...(provider.providerBuiltinId ? { providerBuiltinId: provider.providerBuiltinId } : {}),
    ...(provider.userAgent ? { userAgent: provider.userAgent } : {}),
    ...(provider.sessionId ? { sessionId: provider.sessionId } : {}),
    ...(provider.serviceTier ? { serviceTier: provider.serviceTier } : {}),
    ...(provider.enablePromptCache !== undefined ? { enablePromptCache: provider.enablePromptCache } : {}),
    ...(provider.enableSystemPromptCache !== undefined
      ? { enableSystemPromptCache: provider.enableSystemPromptCache }
      : {}),
    ...(provider.requestOverrides ? { requestOverrides: provider.requestOverrides } : {}),
    ...(provider.instructionsPrompt ? { instructionsPrompt: provider.instructionsPrompt } : {}),
    ...(provider.responseSummary ? { responseSummary: provider.responseSummary } : {}),
    ...(provider.computerUseEnabled !== undefined
      ? { computerUseEnabled: provider.computerUseEnabled }
      : {}),
    ...(provider.organization ? { organization: provider.organization } : {}),
    ...(provider.project ? { project: provider.project } : {}),
    ...(provider.accountId ? { accountId: provider.accountId } : {})
  }
}

function mapSidecarTool(tool: ToolDefinition): SidecarToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }
}

export function buildSidecarAgentRunRequest(args: {
  messages: UnifiedMessage[]
  provider: ProviderConfig
  tools: ToolDefinition[]
  sessionId?: string
  workingFolder?: string
  maxIterations: number
  forceApproval: boolean
  compression?: CompressionConfig | null
}): SidecarAgentRunRequest | null {
  const provider = mapSidecarProvider(args.provider)
  if (!provider) return null

  const messages: SidecarUnifiedMessage[] = []
  for (const message of args.messages) {
    const mapped = mapSidecarMessage(message)
    if (!mapped) return null
    messages.push(mapped)
  }

  return {
    messages,
    provider,
    tools: args.tools.map(mapSidecarTool),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.workingFolder ? { workingFolder: args.workingFolder } : {}),
    ...(args.compression ? { compression: args.compression } : {}),
    maxIterations: args.maxIterations,
    forceApproval: args.forceApproval
  }
}

function normalizeToolResultOutput(value: unknown): ToolResultContent | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const blocks = value
      .map(
        (
          item
        ):
          | { type: 'text'; text: string }
          | {
              type: 'image'
              source: {
                type: 'base64' | 'url'
                mediaType?: string
                data?: string
                url?: string
                filePath?: string
              }
            }
          | null => {
          const block = normalizeSidecarRecord(item)
          if (block.type === 'text' && typeof block.text === 'string') {
            return { type: 'text', text: block.text }
          }
          if (block.type === 'image') {
            const source = normalizeSidecarRecord(block.source)
            if (source.type === 'base64' || source.type === 'url') {
              return {
                type: 'image',
                source: {
                  type: source.type,
                  ...(typeof source.mediaType === 'string' ? { mediaType: source.mediaType } : {}),
                  ...(typeof source.data === 'string' ? { data: source.data } : {}),
                  ...(typeof source.url === 'string' ? { url: source.url } : {}),
                  ...(typeof source.filePath === 'string' ? { filePath: source.filePath } : {})
                }
              }
            }
          }
          return null
        }
      )
      .filter((block): block is Exclude<typeof block, null> => block !== null)
    return blocks.length > 0 ? blocks : undefined
  }
  if (value !== null && value !== undefined) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return undefined
}

export function normalizeSidecarAgentEvent(rawEvent: unknown): AgentEvent | null {
  const event = normalizeSidecarRecord(rawEvent)
  const type = typeof event.type === 'string' ? event.type : null
  if (!type) return null

  switch (type) {
    case 'loop_start':
      return { type: 'loop_start' }
    case 'iteration_start':
      return { type: 'iteration_start', iteration: Number(event.iteration ?? 0) }
    case 'text_delta':
      return { type: 'text_delta', text: String(event.text ?? '') }
    case 'thinking_delta':
      return { type: 'thinking_delta', thinking: String(event.thinking ?? '') }
    case 'thinking_encrypted': {
      const provider = event.thinkingEncryptedProvider
      if (
        provider === 'anthropic' ||
        provider === 'openai-responses' ||
        provider === 'google'
      ) {
        return {
          type: 'thinking_encrypted',
          thinkingEncryptedContent: String(event.thinkingEncryptedContent ?? ''),
          thinkingEncryptedProvider: provider
        }
      }
      return null
    }
    case 'message_end':
      return {
        type: 'message_end',
        usage: event.usage as TokenUsage | undefined,
        timing: event.timing as RequestTiming | undefined,
        providerResponseId:
          typeof event.providerResponseId === 'string' ? event.providerResponseId : undefined,
        stopReason: typeof event.stopReason === 'string' ? event.stopReason : undefined
      }
    case 'tool_use_streaming_start':
      return {
        type: 'tool_use_streaming_start',
        toolCallId: String(event.toolCallId ?? ''),
        toolName: String(event.toolName ?? ''),
        ...(event.toolCallExtraContent ? { toolCallExtraContent: event.toolCallExtraContent } : {})
      }
    case 'tool_use_args_delta':
      return {
        type: 'tool_use_args_delta',
        toolCallId: String(event.toolCallId ?? ''),
        partialInput: normalizeSidecarRecord(event.partialInput)
      }
    case 'tool_use_generated': {
      const toolUseBlock =
        'toolUseBlock' in event
          ? normalizeSidecarRecord(event.toolUseBlock)
          : {
              id: event.id,
              name: event.name,
              input: event.input
            }
      return {
        type: 'tool_use_generated',
        toolUseBlock: {
          id: String(toolUseBlock.id ?? ''),
          name: String(toolUseBlock.name ?? ''),
          input: normalizeSidecarRecord(toolUseBlock.input),
          ...(toolUseBlock.extraContent ? { extraContent: toolUseBlock.extraContent } : {})
        }
      }
    }
    case 'tool_call_start': {
      const toolCall = 'toolCall' in event ? normalizeSidecarRecord(event.toolCall) : null
      if (toolCall) {
        return {
          type: 'tool_call_start',
          toolCall: {
            id: String(toolCall.id ?? event.toolCallId ?? ''),
            name: String(toolCall.name ?? event.toolName ?? ''),
            input: normalizeSidecarRecord(toolCall.input),
            status: 'running',
            requiresApproval: Boolean(toolCall.requiresApproval),
            ...(toolCall.extraContent ? { extraContent: toolCall.extraContent } : {}),
            startedAt: Number(toolCall.startedAt ?? Date.now())
          }
        }
      }
      return {
        type: 'tool_use_streaming_start',
        toolCallId: String(event.toolCallId ?? ''),
        toolName: String(event.toolName ?? '')
      }
    }
    case 'tool_call_running': {
      const toolCall =
        'toolCall' in event
          ? normalizeSidecarRecord(event.toolCall)
          : {
              id: event.toolCallId,
              name: event.toolName,
              input: event.input,
              status: 'running',
              requiresApproval: false,
              startedAt: event.startedAt
            }
      return {
        type: 'tool_call_start',
        toolCall: {
          id: String(toolCall.id ?? ''),
          name: String(toolCall.name ?? ''),
          input: normalizeSidecarRecord(toolCall.input),
          status: 'running',
          requiresApproval: Boolean(toolCall.requiresApproval),
          ...(toolCall.extraContent ? { extraContent: toolCall.extraContent } : {}),
          startedAt: Number(toolCall.startedAt ?? Date.now())
        }
      }
    }
    case 'tool_call_delta': {
      const rawDelta = typeof event.argumentsDelta === 'string' ? event.argumentsDelta : ''
      let partialInput: Record<string, unknown> = {}
      try {
        const parsed = parsePartialJSON(rawDelta, Allow.ALL)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          partialInput = parsed as Record<string, unknown>
        }
      } catch {
        partialInput = {}
      }
      return {
        type: 'tool_use_args_delta',
        toolCallId: String(event.toolCallId ?? ''),
        partialInput
      }
    }
    case 'tool_call_approval_needed': {
      const toolCall = normalizeSidecarRecord(event.toolCall)
      return {
        type: 'tool_call_approval_needed',
        toolCall: {
          id: String(toolCall.id ?? ''),
          name: String(toolCall.name ?? ''),
          input: normalizeSidecarRecord(toolCall.input),
          status: 'pending_approval',
          requiresApproval: true,
          ...(toolCall.extraContent ? { extraContent: toolCall.extraContent } : {}),
          startedAt: Number(toolCall.startedAt ?? Date.now())
        }
      }
    }
    case 'tool_call_result': {
      const toolCall =
        'toolCall' in event
          ? normalizeSidecarRecord(event.toolCall)
          : {
              id: event.toolCallId,
              name: event.toolName,
              output: event.result,
              error: event.isError ? event.result : undefined,
              status: event.isError ? 'error' : 'completed',
              completedAt: event.completedAt,
              requiresApproval: false,
              input: event.input
            }

      const status = toolCall.status === 'error' ? 'error' : 'completed'
      return {
        type: 'tool_call_result',
        toolCall: {
          id: String(toolCall.id ?? ''),
          name: String(toolCall.name ?? ''),
          input: normalizeSidecarRecord(toolCall.input),
          status,
          output: status === 'error' ? undefined : normalizeToolResultOutput(toolCall.output),
          error:
            typeof toolCall.error === 'string'
              ? toolCall.error
              : typeof event.result === 'string' && event.isError
                ? event.result
                : undefined,
          requiresApproval: Boolean(toolCall.requiresApproval),
          ...(toolCall.extraContent ? { extraContent: toolCall.extraContent } : {}),
          startedAt:
            toolCall.startedAt === undefined ? undefined : Number(toolCall.startedAt ?? Date.now()),
          completedAt: Number(toolCall.completedAt ?? Date.now())
        }
      }
    }
    case 'iteration_end':
      if (Array.isArray(event.toolResults)) {
        const rawWriteResults = event.toolResults
          .map((raw) => normalizeSidecarRecord(raw))
          .filter((item) => String(item.toolName ?? item.name ?? '') === 'Write')
        if (rawWriteResults.length > 0) {
          console.log('[WriteTrace] sidecar raw iteration_end write results', rawWriteResults)
        }
      }
      return {
        type: 'iteration_end',
        stopReason: String(event.stopReason ?? 'tool_use'),
        ...(Array.isArray(event.toolResults)
          ? {
              toolResults: event.toolResults
                .map((raw) => {
                  const item = normalizeSidecarRecord(raw)
                  const toolUseId = typeof item.toolUseId === 'string' ? item.toolUseId : ''
                  const content = normalizeToolResultOutput(item.content)
                  if (!toolUseId || content === undefined) return null
                  return {
                    toolUseId,
                    content,
                    ...(typeof item.isError === 'boolean' ? { isError: item.isError } : {})
                  }
                })
                .filter((item): item is Exclude<typeof item, null> => item !== null)
            }
          : {})
      }
    case 'loop_end': {
      const reason = event.reason
      return {
        type: 'loop_end',
        reason:
          reason === 'completed' ||
          reason === 'max_iterations' ||
          reason === 'aborted' ||
          reason === 'error'
            ? reason
            : 'error'
      }
    }
    case 'context_compression_start':
      return { type: 'context_compression_start' }
    case 'context_compressed':
      return {
        type: 'context_compressed',
        originalCount: Number(event.originalCount ?? 0),
        newCount: Number(event.newCount ?? event.compressedCount ?? 0)
      }
    case 'request_debug': {
      const debugInfo = normalizeSidecarRecord(event.debugInfo)
      const headers = isRecord(debugInfo.headers)
        ? Object.fromEntries(
            Object.entries(debugInfo.headers).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : {}
      return {
        type: 'request_debug',
        debugInfo: {
          url: String(debugInfo.url ?? ''),
          method: String(debugInfo.method ?? 'POST'),
          headers,
          ...(typeof debugInfo.body === 'string' ? { body: debugInfo.body } : {}),
          timestamp: Number(debugInfo.timestamp ?? Date.now()),
          ...(typeof debugInfo.providerId === 'string' ? { providerId: debugInfo.providerId } : {}),
          ...(typeof debugInfo.providerBuiltinId === 'string'
            ? { providerBuiltinId: debugInfo.providerBuiltinId }
            : {}),
          ...(typeof debugInfo.model === 'string' ? { model: debugInfo.model } : {}),
          ...(debugInfo.executionPath === 'node' || debugInfo.executionPath === 'sidecar'
            ? { executionPath: debugInfo.executionPath }
            : { executionPath: 'sidecar' })
        } satisfies RequestDebugInfo
      }
    }
    case 'error':
      return {
        type: 'error',
        error: event.error instanceof Error ? event.error : createSidecarError(event)
      }
    default:
      return null
  }
}

export function normalizeSidecarApprovalRequest(rawValue: unknown): SidecarApprovalRequest | null {
  const value = normalizeSidecarRecord(rawValue)
  const toolCall = normalizeSidecarRecord(value.toolCall)
  const id = typeof toolCall.id === 'string' ? toolCall.id : ''
  const name = typeof toolCall.name === 'string' ? toolCall.name : ''
  if (!id || !name) return null

  return {
    runId: typeof value.runId === 'string' ? value.runId : undefined,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    toolCall: {
      id,
      name,
      input: normalizeSidecarRecord(toolCall.input),
      status: 'pending_approval',
      requiresApproval: true,
      startedAt: Number(toolCall.startedAt ?? Date.now())
    }
  }
}
