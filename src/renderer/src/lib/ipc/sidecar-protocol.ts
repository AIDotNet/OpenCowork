import type {
  ContentBlock,
  MessageMeta,
  ProviderConfig,
  TokenUsage,
  ToolDefinition,
  ToolResultContent,
  UnifiedMessage
} from '../api/types'
import type { ToolCallState } from '../agent/types'
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
  meta?: MessageMeta
}

export interface SidecarProviderConfig {
  type: string
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
  responsesSessionScope?: string
  serviceTier?: string
  enablePromptCache?: boolean
  enableSystemPromptCache?: boolean
  promptCacheKey?: string
  requestOverrides?: ProviderConfig['requestOverrides']
  instructionsPrompt?: string
  responseSummary?: string
  responsesImageGeneration?: ProviderConfig['responsesImageGeneration']
  computerUseEnabled?: boolean
  organization?: string
  project?: string
  accountId?: string
  websocketUrl?: string
  websocketMode?: 'auto' | 'disabled'
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
  maxParallelTools?: number
  compression?: CompressionConfig
  sessionMode?: 'agent' | 'chat'
  planMode?: boolean
  planModeAllowedTools?: string[]
  pluginId?: string
  pluginChatId?: string
  pluginChatType?: 'p2p' | 'group'
  pluginSenderId?: string
  pluginSenderName?: string
  sshConnectionId?: string
  captureFinalMessages?: boolean
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

function normalizeMaxParallelTools(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.min(16, Math.max(1, Math.floor(value)))
}

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
      ...(message.source ? { source: message.source } : {}),
      ...(message.meta ? { meta: message.meta } : {})
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
    ...(message.source ? { source: message.source } : {}),
    ...(message.meta ? { meta: message.meta } : {})
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
    ...(provider.responsesSessionScope
      ? { responsesSessionScope: provider.responsesSessionScope }
      : {}),
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
    ...(provider.responsesImageGeneration
      ? { responsesImageGeneration: provider.responsesImageGeneration }
      : {}),
    ...(provider.computerUseEnabled !== undefined
      ? { computerUseEnabled: provider.computerUseEnabled }
      : {}),
    ...(provider.organization ? { organization: provider.organization } : {}),
    ...(provider.project ? { project: provider.project } : {}),
    ...(provider.accountId ? { accountId: provider.accountId } : {}),
    ...(provider.websocketUrl ? { websocketUrl: provider.websocketUrl } : {}),
    ...(provider.websocketMode ? { websocketMode: provider.websocketMode } : {})
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
  maxParallelTools?: number
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
  captureFinalMessages?: boolean
}): SidecarAgentRunRequest | null {
  const provider = mapSidecarProvider(args.provider)

  const messages: SidecarUnifiedMessage[] = []
  for (const message of args.messages) {
    const mapped = mapSidecarMessage(message)
    if (!mapped) return null
    messages.push(mapped)
  }

  const maxParallelTools = normalizeMaxParallelTools(args.maxParallelTools)

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
    ...(maxParallelTools !== undefined ? { maxParallelTools } : {}),
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
    ...(args.sshConnectionId ? { sshConnectionId: args.sshConnectionId } : {}),
    ...(args.captureFinalMessages ? { captureFinalMessages: true } : {})
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
