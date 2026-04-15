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
import type { SubAgentEvent } from '../agent/sub-agents/types'
import type { CompressionConfig } from '../agent/context-compression'
import { isMoonshotProviderConfig } from '../auth/oauth'
import { summarizeToolInputForHistory } from '../tools/tool-input-sanitizer'

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

export interface SidecarAgentErrorBlock {
  type: 'agent_error'
  code: 'runtime_error' | 'tool_error' | 'unknown'
  message: string
  errorType?: string
  details?: string
  stackTrace?: string
}

export type SidecarContentBlock =
  | SidecarTextBlock
  | SidecarImageBlock
  | SidecarToolUseBlock
  | SidecarToolResultBlock
  | SidecarThinkingBlock
  | SidecarAgentErrorBlock

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
  type: string
  /**
   * When set to "bridged", the sidecar delegates provider streaming back to
   * the renderer via the provider bridge instead of using a native provider.
   * Omitted (or "native") uses the sidecar's built-in provider implementation.
   */
  mode?: 'native' | 'bridged'
  apiKey: string
  baseUrl?: string
  model: string
  category?: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  useSystemProxy?: boolean
  allowInsecureTls?: boolean
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
  /**
   * Session mode: "agent" (default) runs the full tool loop, "chat" collapses
   * to a single assistant turn with tool execution disabled inside the sidecar.
   */
  sessionMode?: 'agent' | 'chat'
  /**
   * When true the sidecar enforces plan mode by blocking any tool call whose
   * name is not in planModeAllowedTools with a synthesized error tool_result.
   */
  planMode?: boolean
  planModeAllowedTools?: string[]
  /**
   * Plugin/SSH session context — propagated through the renderer tool bridge
   * so that plugin & ssh tool handlers can resolve their target channels.
   */
  pluginId?: string
  pluginChatId?: string
  pluginChatType?: 'p2p' | 'group'
  pluginSenderId?: string
  pluginSenderName?: string
  sshConnectionId?: string
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

function sanitizeSidecarToolInput(name: string, rawInput: unknown): Record<string, unknown> {
  const input = normalizeSidecarRecord(rawInput)
  return summarizeToolInputForHistory(name, input)
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

// Provider types the sidecar implements natively. Anything else (or any
// native-typed provider using a feature the sidecar doesn't support, such as
// Gemini image models) is routed through the bridged provider so the .NET
// agent loop can still drive it via the renderer's JS provider modules.
const SIDECAR_NATIVE_PROVIDER_TYPES = new Set<string>([
  'anthropic',
  'openai-chat',
  'openai-responses',
  'gemini'
])

function shouldBridgeProvider(provider: ProviderConfig): boolean {
  if (!SIDECAR_NATIVE_PROVIDER_TYPES.has(provider.type)) return true
  if (isMoonshotProviderConfig(provider)) return true
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
    case 'agent_error':
      return {
        type: 'agent_error',
        code: block.code,
        message: block.message,
        ...(block.errorType ? { errorType: block.errorType } : {}),
        ...(block.details ? { details: block.details } : {}),
        ...(block.stackTrace ? { stackTrace: block.stackTrace } : {})
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

function mapSidecarProvider(provider: ProviderConfig): SidecarProviderConfig {
  const bridged = shouldBridgeProvider(provider)
  return {
    type: provider.type,
    ...(bridged ? { mode: 'bridged' as const } : {}),
    apiKey: provider.apiKey,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    model: provider.model,
    ...(provider.category ? { category: provider.category } : {}),
    ...(provider.maxTokens !== undefined ? { maxTokens: provider.maxTokens } : {}),
    ...(provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
    ...(provider.systemPrompt ? { systemPrompt: provider.systemPrompt } : {}),
    ...(provider.useSystemProxy !== undefined ? { useSystemProxy: provider.useSystemProxy } : {}),
    ...(provider.allowInsecureTls !== undefined
      ? { allowInsecureTls: provider.allowInsecureTls }
      : {}),
    ...(provider.thinkingEnabled !== undefined
      ? { thinkingEnabled: provider.thinkingEnabled }
      : {}),
    ...(provider.thinkingConfig ? { thinkingConfig: provider.thinkingConfig } : {}),
    ...(provider.reasoningEffort ? { reasoningEffort: provider.reasoningEffort } : {}),
    ...(provider.providerId ? { providerId: provider.providerId } : {}),
    ...(provider.providerBuiltinId ? { providerBuiltinId: provider.providerBuiltinId } : {}),
    ...(provider.userAgent ? { userAgent: provider.userAgent } : {}),
    ...(provider.sessionId ? { sessionId: provider.sessionId } : {}),
    ...(provider.serviceTier ? { serviceTier: provider.serviceTier } : {}),
    ...(provider.enablePromptCache !== undefined
      ? { enablePromptCache: provider.enablePromptCache }
      : {}),
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
  runId?: string
  sessionId?: string
  workingFolder?: string
  maxIterations: number
  forceApproval: boolean
  compression?: CompressionConfig | null
  sessionMode?: 'agent' | 'chat'
  planMode?: boolean
  planModeAllowedTools?: readonly string[]
  pluginId?: string
  pluginChatId?: string
  pluginChatType?: 'p2p' | 'group'
  pluginSenderId?: string
  pluginSenderName?: string
  sshConnectionId?: string
}): SidecarAgentRunRequest | null {
  const provider = mapSidecarProvider(args.provider)

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
    ...(args.runId ? { runId: args.runId } : {}),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.workingFolder ? { workingFolder: args.workingFolder } : {}),
    ...(args.compression ? { compression: args.compression } : {}),
    maxIterations: args.maxIterations,
    forceApproval: args.forceApproval,
    ...(args.sessionMode ? { sessionMode: args.sessionMode } : {}),
    ...(args.planMode ? { planMode: true } : {}),
    ...(args.planModeAllowedTools && args.planModeAllowedTools.length > 0
      ? { planModeAllowedTools: [...args.planModeAllowedTools] }
      : {}),
    ...(args.pluginId ? { pluginId: args.pluginId } : {}),
    ...(args.pluginChatId ? { pluginChatId: args.pluginChatId } : {}),
    ...(args.pluginChatType ? { pluginChatType: args.pluginChatType } : {}),
    ...(args.pluginSenderId ? { pluginSenderId: args.pluginSenderId } : {}),
    ...(args.pluginSenderName ? { pluginSenderName: args.pluginSenderName } : {}),
    ...(args.sshConnectionId ? { sshConnectionId: args.sshConnectionId } : {})
  }
}

function normalizeSidecarContentBlock(blockValue: unknown): ContentBlock | null {
  const block = normalizeSidecarRecord(blockValue)

  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { type: 'text', text: block.text } : null
    case 'image': {
      const source = normalizeSidecarRecord(block.source)
      if (source.type !== 'base64' && source.type !== 'url') return null
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
    case 'tool_use':
      return {
        type: 'tool_use',
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        input: normalizeSidecarRecord(block.input),
        ...(block.extraContent ? { extraContent: block.extraContent } : {})
      }
    case 'tool_result': {
      const content = normalizeToolResultOutput(block.content)
      if (content === undefined) return null
      return {
        type: 'tool_result',
        toolUseId: String(block.toolUseId ?? ''),
        content,
        ...(typeof block.isError === 'boolean' ? { isError: block.isError } : {})
      }
    }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: String(block.thinking ?? ''),
        ...(typeof block.encryptedContent === 'string'
          ? { encryptedContent: block.encryptedContent }
          : {}),
        ...(block.encryptedContentProvider === 'anthropic' ||
        block.encryptedContentProvider === 'openai-responses' ||
        block.encryptedContentProvider === 'google'
          ? { encryptedContentProvider: block.encryptedContentProvider }
          : {})
      }
    case 'agent_error': {
      const code =
        block.code === 'runtime_error' || block.code === 'tool_error' || block.code === 'unknown'
          ? block.code
          : 'unknown'
      return {
        type: 'agent_error',
        code,
        message: String(block.message ?? ''),
        ...(typeof block.errorType === 'string' ? { errorType: block.errorType } : {}),
        ...(typeof block.details === 'string' ? { details: block.details } : {}),
        ...(typeof block.stackTrace === 'string' ? { stackTrace: block.stackTrace } : {})
      }
    }
    default:
      return null
  }
}

export function normalizeSidecarMessage(rawMessage: unknown): UnifiedMessage | null {
  const message = normalizeSidecarRecord(rawMessage)
  const id = typeof message.id === 'string' ? message.id : ''
  const role = message.role
  if (!id || (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool')) {
    return null
  }

  let content: string | ContentBlock[] = ''
  if (typeof message.content === 'string') {
    content = message.content
  } else if (Array.isArray(message.content)) {
    const blocks = message.content
      .map((block) => normalizeSidecarContentBlock(block))
      .filter((block): block is ContentBlock => block !== null)
    content = blocks
  }

  return {
    id,
    role,
    content,
    createdAt: Number(message.createdAt ?? Date.now()),
    ...(message.usage ? { usage: message.usage as TokenUsage } : {}),
    ...(typeof message.providerResponseId === 'string'
      ? { providerResponseId: message.providerResponseId }
      : {}),
    ...(message.source === 'team' || message.source === 'queued' ? { source: message.source } : {})
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

function normalizeToolCallStatusValue(status: unknown): ToolCallState['status'] {
  const value = String(status ?? '')
    .trim()
    .toLowerCase()
  switch (value) {
    case 'streaming':
      return 'streaming'
    case 'pendingapproval':
    case 'pending_approval':
      return 'pending_approval'
    case 'running':
      return 'running'
    case 'error':
      return 'error'
    default:
      return 'completed'
  }
}

export function normalizeSidecarSubAgentEvent(rawEvent: unknown): SubAgentEvent | null {
  const event = normalizeSidecarRecord(rawEvent)
  const type = typeof event.type === 'string' ? event.type : null
  if (!type) return null

  const subAgentName = typeof event.subAgentName === 'string' ? event.subAgentName : ''
  const toolUseId = typeof event.toolUseId === 'string' ? event.toolUseId : ''
  if (!subAgentName || !toolUseId) return null

  switch (type) {
    case 'sub_agent_start': {
      const promptMessage = normalizeSidecarMessage(event.promptMessage)
      if (!promptMessage) return null
      return {
        type: 'sub_agent_start',
        subAgentName,
        toolUseId,
        input: normalizeSidecarRecord(event.input),
        promptMessage
      }
    }
    case 'sub_agent_iteration': {
      const assistantMessage = normalizeSidecarMessage(event.assistantMessage)
      if (!assistantMessage) return null
      return {
        type: 'sub_agent_iteration',
        subAgentName,
        toolUseId,
        iteration: Number(event.iteration ?? 0),
        assistantMessage
      }
    }
    case 'sub_agent_text_delta':
      return {
        type: 'sub_agent_text_delta',
        subAgentName,
        toolUseId,
        text: String(event.text ?? '')
      }
    case 'sub_agent_thinking_delta':
      return {
        type: 'sub_agent_thinking_delta',
        subAgentName,
        toolUseId,
        thinking: String(event.thinking ?? '')
      }
    case 'sub_agent_thinking_encrypted': {
      const provider = event.thinkingEncryptedProvider
      if (provider !== 'anthropic' && provider !== 'openai-responses' && provider !== 'google') {
        return null
      }
      return {
        type: 'sub_agent_thinking_encrypted',
        subAgentName,
        toolUseId,
        thinkingEncryptedContent: String(event.thinkingEncryptedContent ?? ''),
        thinkingEncryptedProvider: provider
      }
    }
    case 'sub_agent_tool_use_streaming_start':
      return {
        type: 'sub_agent_tool_use_streaming_start',
        subAgentName,
        toolUseId,
        toolCallId: String(event.toolCallId ?? ''),
        toolName: String(event.toolName ?? ''),
        ...(event.toolCallExtraContent ? { toolCallExtraContent: event.toolCallExtraContent } : {})
      }
    case 'sub_agent_tool_use_args_delta':
      return {
        type: 'sub_agent_tool_use_args_delta',
        subAgentName,
        toolUseId,
        toolCallId: String(event.toolCallId ?? ''),
        partialInput: normalizeSidecarRecord(event.partialInput)
      }
    case 'sub_agent_tool_use_generated': {
      const toolUseBlock = normalizeSidecarRecord(event.toolUseBlock)
      return {
        type: 'sub_agent_tool_use_generated',
        subAgentName,
        toolUseId,
        toolUseBlock: {
          type: 'tool_use',
          id: String(toolUseBlock.id ?? ''),
          name: String(toolUseBlock.name ?? ''),
          input: normalizeSidecarRecord(toolUseBlock.input),
          ...(toolUseBlock.extraContent ? { extraContent: toolUseBlock.extraContent } : {})
        }
      }
    }
    case 'sub_agent_message_end':
      return {
        type: 'sub_agent_message_end',
        subAgentName,
        toolUseId,
        ...(event.usage ? { usage: event.usage as TokenUsage } : {}),
        ...(typeof event.providerResponseId === 'string'
          ? { providerResponseId: event.providerResponseId }
          : {})
      }
    case 'sub_agent_tool_result_message': {
      const message = normalizeSidecarMessage(event.message)
      if (!message) return null
      return { type: 'sub_agent_tool_result_message', subAgentName, toolUseId, message }
    }
    case 'sub_agent_report_update':
      return {
        type: 'sub_agent_report_update',
        subAgentName,
        toolUseId,
        report: String(event.report ?? ''),
        status:
          event.status === 'submitted' ||
          event.status === 'retrying' ||
          event.status === 'fallback' ||
          event.status === 'missing'
            ? event.status
            : 'pending'
      }
    case 'sub_agent_tool_call': {
      const toolCall = normalizeSidecarRecord(event.toolCall)
      return {
        type: 'sub_agent_tool_call',
        subAgentName,
        toolUseId,
        toolCall: {
          id: String(toolCall.id ?? ''),
          name: String(toolCall.name ?? ''),
          input: sanitizeSidecarToolInput(String(toolCall.name ?? ''), toolCall.input),
          status: normalizeToolCallStatusValue(toolCall.status),
          ...(toolCall.output !== undefined
            ? { output: normalizeToolResultOutput(toolCall.output) }
            : {}),
          ...(typeof toolCall.error === 'string' ? { error: toolCall.error } : {}),
          requiresApproval: Boolean(toolCall.requiresApproval),
          ...(toolCall.extraContent ? { extraContent: toolCall.extraContent } : {}),
          ...(toolCall.startedAt === undefined
            ? {}
            : { startedAt: Number(toolCall.startedAt ?? Date.now()) }),
          ...(toolCall.completedAt === undefined
            ? {}
            : { completedAt: Number(toolCall.completedAt ?? Date.now()) })
        }
      }
    }
    case 'sub_agent_end': {
      const result = normalizeSidecarRecord(event.result)
      return {
        type: 'sub_agent_end',
        subAgentName,
        toolUseId,
        result: {
          success: result.success === true,
          output: String(result.output ?? ''),
          ...(typeof result.reportSubmitted === 'boolean'
            ? { reportSubmitted: result.reportSubmitted }
            : {}),
          toolCallCount: Number(result.toolCallCount ?? 0),
          iterations: Number(result.iterations ?? 0),
          usage: (result.usage as TokenUsage | undefined) ?? { inputTokens: 0, outputTokens: 0 },
          ...(typeof result.error === 'string' ? { error: result.error } : {})
        }
      }
    }
    default:
      return null
  }
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
      if (provider === 'anthropic' || provider === 'openai-responses' || provider === 'google') {
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
            input: sanitizeSidecarToolInput(
              String(toolCall.name ?? event.toolCallId ?? ''),
              toolCall.input
            ),
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
          input: sanitizeSidecarToolInput(String(toolCall.name ?? ''), toolCall.input),
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
          input: sanitizeSidecarToolInput(String(toolCall.name ?? ''), toolCall.input),
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

      const status = normalizeToolCallStatusValue(toolCall.status)
      return {
        type: 'tool_call_result',
        toolCall: {
          id: String(toolCall.id ?? ''),
          name: String(toolCall.name ?? ''),
          input: sanitizeSidecarToolInput(String(toolCall.name ?? ''), toolCall.input),
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
    case 'error': {
      const error = event.error instanceof Error ? event.error : createSidecarError(event)
      return {
        type: 'error',
        error,
        ...(typeof event.errorType === 'string' ? { errorType: event.errorType } : {}),
        ...(typeof event.details === 'string' ? { details: event.details } : {}),
        ...(typeof event.stackTrace === 'string' ? { stackTrace: event.stackTrace } : {})
      }
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
      input: sanitizeSidecarToolInput(name, normalizeSidecarRecord(toolCall.input)),
      status: 'pending_approval',
      requiresApproval: true,
      startedAt: Number(toolCall.startedAt ?? Date.now())
    }
  }
}
