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
import { toolRegistry } from '../agent/tool-registry'
import { resolveProviderUserAgent } from '../api/api-user-agent'
import { summarizeToolInputForHistory } from '../tools/tool-input-sanitizer'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import {
  toPermissionPolicySnapshot,
  type PermissionPolicySnapshot
} from '../../../../shared/permission-policy'

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
  cacheTtl?: ProviderConfig['cacheTtl']
  requestOverrides?: ProviderConfig['requestOverrides']
  instructionsPrompt?: string
  responseSummary?: string
  responsesImageGeneration?: ProviderConfig['responsesImageGeneration']
  imageGenerationStream?: ProviderConfig['imageGenerationStream']
  computerUseEnabled?: boolean
  builtinSearchEnabled?: boolean
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

export interface SidecarWebSearchConfig {
  enabled: boolean
  provider:
    | 'tavily'
    | 'searxng'
    | 'exa'
    | 'exa-mcp'
    | 'bocha'
    | 'zhipu'
    | 'google'
    | 'bing'
    | 'baidu'
  apiKey?: string
  searchEngine?: string
  maxResults?: number
  timeout?: number
}

export interface SidecarTranslationContext {
  enabled: true
  sourceLanguage: string
  targetLanguage: string
}

export interface SidecarContextSource {
  sessionId: string
  maxMessages?: number
  compressionMode?: 'none' | 'auto' | 'force'
}

export interface SidecarPlanRevisionContext {
  title: string
  filePath?: string
  feedback?: string
}

export interface SidecarPlanExecutionContext {
  filePath?: string
  acp?: boolean
}

export interface SidecarSlashCommandContext {
  commandName: string
  rawArguments?: string
  parsedArguments?: string[]
}

export interface SidecarSystemCommandContext {
  name: string
  content: string
}

export interface SidecarPluginChannelContext {
  channelName?: string
  channelId: string
  chatId?: string
  chatType?: 'p2p' | 'group'
  senderId?: string
  senderName?: string
  availableTools?: string[]
  autoReply?: boolean
}

export interface SidecarAgentRunRequest {
  messages: SidecarUnifiedMessage[]
  contextSource?: SidecarContextSource
  liveOverlayMessages?: SidecarUnifiedMessage[]
  provider: SidecarProviderConfig
  tools: SidecarToolDefinition[]
  subAgentToolCatalog?: SidecarToolDefinition[]
  webSearch?: SidecarWebSearchConfig
  imagePluginProvider?: SidecarProviderConfig
  /**
   * Provider config sub-agents (Task tool) run on. Sourced from the configured fast model
   * so delegated work uses the cheaper/faster model; the native worker prefers it over the
   * parent provider unless a per-call or agent-frontmatter model override is present. Falls
   * back to the main model when no distinct fast model is configured.
   */
  subAgentProvider?: SidecarProviderConfig
  runId?: string
  sessionId?: string
  workingFolder?: string
  maxIterations: number
  forceApproval: boolean
  maxParallelTools?: number
  compression?: CompressionConfig
  sessionMode?: 'agent' | 'chat'
  planMode?: boolean
  planModeAllowedTools?: string[]
  permissionPolicy?: PermissionPolicySnapshot
  planRevision?: SidecarPlanRevisionContext
  planExecution?: SidecarPlanExecutionContext
  slashCommand?: SidecarSlashCommandContext
  systemCommand?: SidecarSystemCommandContext
  pluginChannelContext?: SidecarPluginChannelContext
  requestContextTexts?: string[]
  teamToolsActive?: boolean
  activeTeamName?: string
  goalRunSource?: 'user_turn' | 'continue'
  pluginId?: string
  pluginChatId?: string
  pluginChatType?: 'p2p' | 'group'
  pluginSenderId?: string
  pluginSenderName?: string
  callerAgent?: string
  sshConnectionId?: string
  captureFinalMessages?: boolean
  providerTurnOnly?: boolean
  includeFullDebugBody?: boolean
  translation?: SidecarTranslationContext
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

function normalizePlanRevision(
  value: SidecarPlanRevisionContext | null | undefined
): SidecarPlanRevisionContext | undefined {
  if (!value) return undefined
  const title = value.title.trim()
  if (!title) return undefined
  const filePath = value.filePath?.trim()
  const feedback = value.feedback?.trim()
  return {
    title,
    ...(filePath ? { filePath } : {}),
    ...(feedback ? { feedback } : {})
  }
}

function normalizePlanExecution(
  value: SidecarPlanExecutionContext | null | undefined
): SidecarPlanExecutionContext | undefined {
  if (!value) return undefined
  const filePath = value.filePath?.trim()
  return {
    ...(filePath ? { filePath } : {}),
    ...(value.acp ? { acp: true } : {})
  }
}

function normalizeSlashCommand(
  value: SidecarSlashCommandContext | null | undefined
): SidecarSlashCommandContext | undefined {
  if (!value) return undefined
  const commandName = value.commandName.trim().toLowerCase()
  if (!commandName) return undefined
  const rawArguments = value.rawArguments?.trim()
  const parsedArguments = (value.parsedArguments ?? []).map((item) => item.trim())
  if (!rawArguments && parsedArguments.length === 0) return undefined
  return {
    commandName,
    ...(rawArguments ? { rawArguments } : {}),
    parsedArguments
  }
}

function normalizeSystemCommand(
  value: SidecarSystemCommandContext | null | undefined
): SidecarSystemCommandContext | undefined {
  if (!value) return undefined
  const name = value.name.trim()
  const content = value.content.trim()
  if (!name || !content) return undefined
  return { name, content }
}

function normalizePluginChannelContext(
  value: SidecarPluginChannelContext | null | undefined
): SidecarPluginChannelContext | undefined {
  if (!value) return undefined
  const channelId = value.channelId.trim()
  if (!channelId) return undefined

  const channelName = value.channelName?.trim()
  const chatId = value.chatId?.trim()
  const senderId = value.senderId?.trim()
  const senderName = value.senderName?.trim()
  const availableTools = Array.from(
    new Set((value.availableTools ?? []).map((item) => item.trim()).filter(Boolean))
  )
  return {
    ...(channelName ? { channelName } : {}),
    channelId,
    ...(chatId ? { chatId } : {}),
    ...(value.chatType ? { chatType: value.chatType } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(availableTools.length > 0 ? { availableTools } : {}),
    ...(value.autoReply ? { autoReply: true } : {})
  }
}

function normalizeRequestContextTexts(value: readonly string[] | null | undefined): string[] {
  if (!value) return []
  return value.map((item) => item.trim()).filter(Boolean)
}

export function isNativeSidecarProviderConfig(provider: ProviderConfig): boolean {
  if (
    provider.type !== 'openai-chat' &&
    provider.type !== 'openai-responses' &&
    provider.type !== 'anthropic' &&
    provider.type !== 'gemini' &&
    provider.type !== 'vertex-ai'
  ) {
    return false
  }
  if (provider.category && provider.category !== 'chat') return false
  return true
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

export function sanitizeSidecarMessageMeta(meta: MessageMeta | undefined): MessageMeta | undefined {
  if (!meta) return undefined
  if (!meta.compactSummary?.displayAnchor) return meta

  const { displayAnchor: _displayAnchor, ...compactSummary } = meta.compactSummary
  return {
    ...meta,
    compactSummary
  }
}

function mapSidecarMessage(message: UnifiedMessage): SidecarUnifiedMessage | null {
  const meta = sanitizeSidecarMessageMeta(message.meta)

  if (typeof message.content === 'string') {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      ...(message.usage ? { usage: message.usage } : {}),
      ...(message.providerResponseId ? { providerResponseId: message.providerResponseId } : {}),
      ...(message.source ? { source: message.source } : {}),
      ...(meta ? { meta } : {})
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
    ...(meta ? { meta } : {})
  }
}

function mapSidecarProvider(provider: ProviderConfig): SidecarProviderConfig {
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
    userAgent: resolveProviderUserAgent(provider.userAgent),
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
    ...(provider.promptCacheKey ? { promptCacheKey: provider.promptCacheKey } : {}),
    ...(provider.cacheTtl ? { cacheTtl: provider.cacheTtl } : {}),
    ...(provider.requestOverrides ? { requestOverrides: provider.requestOverrides } : {}),
    ...(provider.instructionsPrompt ? { instructionsPrompt: provider.instructionsPrompt } : {}),
    ...(provider.responseSummary ? { responseSummary: provider.responseSummary } : {}),
    ...(provider.responsesImageGeneration
      ? { responsesImageGeneration: provider.responsesImageGeneration }
      : {}),
    ...(provider.imageGenerationStream
      ? { imageGenerationStream: provider.imageGenerationStream }
      : {}),
    ...(provider.computerUseEnabled !== undefined
      ? { computerUseEnabled: provider.computerUseEnabled }
      : {}),
    ...(provider.builtinSearchEnabled !== undefined
      ? { builtinSearchEnabled: provider.builtinSearchEnabled }
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

function mapSidecarWebSearchConfig(tools: ToolDefinition[]): SidecarWebSearchConfig | undefined {
  if (!tools.some((tool) => tool.name === 'WebSearch' || tool.name === 'WebFetch')) {
    return undefined
  }

  const settings = useSettingsStore.getState()
  if (!settings.webSearchEnabled) return undefined
  return {
    enabled: true,
    provider: settings.webSearchProvider,
    ...(settings.webSearchApiKey ? { apiKey: settings.webSearchApiKey } : {}),
    ...(settings.webSearchEngine ? { searchEngine: settings.webSearchEngine } : {}),
    maxResults: settings.webSearchMaxResults,
    timeout: settings.webSearchTimeout
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
  imagePluginProvider?: ProviderConfig | null
  sessionMode?: 'agent' | 'chat'
  planMode?: boolean
  planModeAllowedTools?: readonly string[]
  planRevision?: SidecarPlanRevisionContext | null
  planExecution?: SidecarPlanExecutionContext | null
  slashCommand?: SidecarSlashCommandContext | null
  systemCommand?: SidecarSystemCommandContext | null
  pluginChannelContext?: SidecarPluginChannelContext | null
  requestContextTexts?: readonly string[] | null
  teamToolsActive?: boolean
  activeTeamName?: string
  goalRunSource?: 'user_turn' | 'continue'
  pluginId?: string
  pluginChatId?: string
  pluginChatType?: 'p2p' | 'group'
  pluginSenderId?: string
  pluginSenderName?: string
  callerAgent?: string
  sshConnectionId?: string
  captureFinalMessages?: boolean
  providerTurnOnly?: boolean
  includeFullDebugBody?: boolean
  translation?: SidecarTranslationContext
  contextSource?: SidecarContextSource
  liveOverlayMessages?: UnifiedMessage[]
}): SidecarAgentRunRequest | null {
  const provider = mapSidecarProvider(args.provider)

  const messages: SidecarUnifiedMessage[] = []
  for (const message of args.messages) {
    const mapped = mapSidecarMessage(message)
    if (!mapped) return null
    messages.push(mapped)
  }

  const maxParallelTools = normalizeMaxParallelTools(args.maxParallelTools)
  const webSearch = mapSidecarWebSearchConfig(args.tools)
  const parentToolNames = new Set(args.tools.map((tool) => tool.name))
  const subAgentToolCatalog = toolRegistry
    .getStableDefinitions()
    .filter((tool) => !parentToolNames.has(tool.name))
    .map(mapSidecarTool)
  // Global settings snapshot, applied to every run this module builds (incl. sub-agents,
  // which inherit the parent's parameters in the native worker).
  const permissionPolicy = toPermissionPolicySnapshot(useSettingsStore.getState().permissionPolicy)
  const imagePluginProvider = args.imagePluginProvider
    ? mapSidecarProvider(args.imagePluginProvider)
    : null
  // Route sub-agents (Task tool) to the configured fast model. getFastProviderConfig()
  // resolves the explicit fast selection, else a sensible default, else the main model —
  // so this degrades to today's parent-inherit behavior when no distinct fast model is set.
  const fastProviderConfig = useProviderStore.getState().getFastProviderConfig()
  const subAgentProvider = fastProviderConfig ? mapSidecarProvider(fastProviderConfig) : null
  const planRevision = normalizePlanRevision(args.planRevision)
  const planExecution = normalizePlanExecution(args.planExecution)
  const slashCommand = normalizeSlashCommand(args.slashCommand)
  const systemCommand = normalizeSystemCommand(args.systemCommand)
  const pluginChannelContext = normalizePluginChannelContext(args.pluginChannelContext)
  const requestContextTexts = normalizeRequestContextTexts(args.requestContextTexts)
  const liveOverlayMessages: SidecarUnifiedMessage[] = []
  for (const message of args.liveOverlayMessages ?? []) {
    const mapped = mapSidecarMessage(message)
    if (!mapped) return null
    liveOverlayMessages.push(mapped)
  }

  return {
    messages,
    ...(args.contextSource ? { contextSource: args.contextSource } : {}),
    ...(liveOverlayMessages.length > 0 ? { liveOverlayMessages } : {}),
    provider,
    tools: args.tools.map(mapSidecarTool),
    ...(subAgentToolCatalog.length > 0 ? { subAgentToolCatalog } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(imagePluginProvider ? { imagePluginProvider } : {}),
    ...(subAgentProvider ? { subAgentProvider } : {}),
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
    ...(permissionPolicy ? { permissionPolicy } : {}),
    ...(planRevision ? { planRevision } : {}),
    ...(planExecution ? { planExecution } : {}),
    ...(slashCommand ? { slashCommand } : {}),
    ...(systemCommand ? { systemCommand } : {}),
    ...(pluginChannelContext ? { pluginChannelContext } : {}),
    ...(requestContextTexts.length > 0 ? { requestContextTexts } : {}),
    ...(args.teamToolsActive ? { teamToolsActive: true } : {}),
    ...(args.activeTeamName ? { activeTeamName: args.activeTeamName } : {}),
    ...(args.goalRunSource ? { goalRunSource: args.goalRunSource } : {}),
    ...(args.pluginId ? { pluginId: args.pluginId } : {}),
    ...(args.pluginChatId ? { pluginChatId: args.pluginChatId } : {}),
    ...(args.pluginChatType ? { pluginChatType: args.pluginChatType } : {}),
    ...(args.pluginSenderId ? { pluginSenderId: args.pluginSenderId } : {}),
    ...(args.pluginSenderName ? { pluginSenderName: args.pluginSenderName } : {}),
    ...(args.callerAgent ? { callerAgent: args.callerAgent } : {}),
    ...(args.sshConnectionId ? { sshConnectionId: args.sshConnectionId } : {}),
    ...(args.captureFinalMessages ? { captureFinalMessages: true } : {}),
    ...(args.providerTurnOnly ? { providerTurnOnly: true } : {}),
    ...(args.includeFullDebugBody ? { includeFullDebugBody: true } : {}),
    ...(args.translation ? { translation: args.translation } : {})
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
