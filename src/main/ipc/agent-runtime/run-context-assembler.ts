import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  createCapabilitySnapshotV2,
  type CapabilityCallerType
} from '../../../shared/agent-runtime-v2'
import { MULTI_AGENT_MODE_PROMPT } from '../../../shared/agent-system-prompt'
import type { CompactRequestMeta } from '../../../shared/compact-request-view'
import {
  applyCompactWatermark,
  compactWatermarkFence,
  type CompactWatermark
} from '../../../shared/compact-watermark'
import {
  buildLoopCompressionConfig,
  type CompressionModelProfile
} from '../../../shared/context-compression-config'
import type { SessionRunSettings } from './session-run-settings'
import type { SessionToolDefinition } from './session-tool-catalog'
import { splitToolsForSubAgentCatalog } from '../../../shared/session-mode-tools'
import { CODEGRAPH_SYSTEM_GUIDANCE } from './session-tool-families'

export type AssembleSessionIntent = {
  sessionId: string
  triggerMessageId: string
  mode: string
  providerId: string
  modelId: string
  attachmentIds: string[]
  commandMetadata: Record<string, unknown> | null
  callerType?: CapabilityCallerType
  requestContextTexts?: string[]
  extraTemplate?: Record<string, unknown>
}

export type AssembledWireMessage = {
  id: string
  role: string
  content: unknown
  createdAt: number
  /** Mirrored from SQLite so the compaction cut can be applied by position. */
  sortOrder?: number
  meta?: CompactRequestMeta
  usage?: Record<string, unknown>
}

export type AssembledSessionContext = {
  openTemplate: Record<string, unknown>
  historyMessages: AssembledWireMessage[]
  turnMessages: AssembledWireMessage[]
  prefixIdentity: string
}

export function hostedSessionPrefixIdentity(args: {
  sessionId: string
  mode: string
  providerId: string
  modelId: string
  /** Request protocol. Changing chat ↔ responses must reopen; the Worker pins provider on open. */
  providerType?: string | null
  workingFolder: string | null
  sshConnectionId: string | null
  /** Recorded compaction cut; changes after compression force a reopen. */
  compactFence?: string | null
  /** Compression window/threshold/provider; changes force a reopen so the Worker picks them up. */
  compressionFence?: string | null
}): string {
  return [
    args.sessionId,
    args.mode,
    args.providerId,
    args.modelId,
    args.providerType ?? '',
    args.workingFolder ?? '',
    args.sshConnectionId ?? '',
    args.compressionFence ?? '',
    args.compactFence ?? ''
  ].join('\0')
}

export type SessionRecord = {
  id: string
  mode: string
  workingFolder: string | null
  sshConnectionId: string | null
  projectId: string | null
  providerId: string | null
  modelId: string | null
}

export type TranscriptMessage = {
  id: string
  role: string
  content: unknown
  createdAt: number
  sortOrder?: number
  meta?: CompactRequestMeta
  usage?: Record<string, unknown>
}

export type RunContextAssemblerDeps = {
  getSession: (sessionId: string) => Promise<SessionRecord | null>
  getMessages: (sessionId: string) => Promise<TranscriptMessage[]>
  /**
   * Recorded compaction cut for the session. Returning `null` means "not
   * compacted", which sends the full transcript — correct but expensive, so a
   * lookup failure must never be reported as a cut.
   */
  getCompaction: (
    sessionId: string,
    transcript: readonly TranscriptMessage[]
  ) => Promise<CompactWatermark | null>
  resolveProvider: (providerId: string, modelId: string) => Record<string, unknown> | null
  readPermissionPolicy: () => unknown | null
  listTools: (args: {
    sessionId: string
    mode: string
    projectId: string | null
  }) => Promise<SessionToolDefinition[]> | SessionToolDefinition[]
  readRunSettings: () => SessionRunSettings
  resolveSystemPrompt: (args: {
    sessionId: string
    mode: string
    workingFolder: string | null
    sshConnectionId: string | null
    toolNames: string[]
    projectId: string | null
  }) => Promise<string | null> | string | null
  resolveSubAgentProvider?: () => Record<string, unknown> | null
  resolveCompressionModel?: (providerId: string, modelId: string) => CompressionModelProfile | null
  resolveCompressionProvider?: () => Record<string, unknown> | null
  /**
   * Credentials for the session's SSH host. The Worker routes file/shell tools over
   * SSH only when the run request carries this payload, so an SSH session assembled
   * without it would execute against the wrong (local) filesystem.
   */
  resolveSshConnection?: (connectionId: string) => Record<string, unknown> | null
}

function toWireMessage(message: TranscriptMessage): AssembledWireMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(typeof message.sortOrder === 'number' ? { sortOrder: message.sortOrder } : {}),
    ...(message.meta ? { meta: message.meta } : {}),
    ...(message.usage ? { usage: message.usage } : {})
  }
}

function findPersistedContextLength(messages: readonly AssembledWireMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = messages[index]?.usage
    const contextLength = usage ? Number(usage.contextLength) : 0
    if (Number.isFinite(contextLength) && contextLength > 0) {
      return Math.floor(contextLength)
    }
  }
  return 0
}

function compressionFenceForTemplate(args: {
  compression: ReturnType<typeof buildLoopCompressionConfig>
  compressionProvider: Record<string, unknown> | null
}): string {
  if (!args.compression) return 'off'
  const provider = args.compressionProvider
  const providerKey = [
    typeof provider?.providerId === 'string' ? provider.providerId : '',
    typeof provider?.model === 'string' ? provider.model : ''
  ].join(':')
  return [
    'on',
    args.compression.contextLength,
    args.compression.threshold,
    args.compression.reservedOutputBudget ?? '',
    providerKey
  ].join(':')
}

function asProviderRecord(provider: Record<string, unknown>): Record<string, unknown> {
  return { ...provider }
}

function readCommandObject(
  value: unknown,
  requiredKeys: readonly string[]
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const key of requiredKeys) {
    const field = record[key]
    if (typeof field !== 'string' || field.trim().length === 0) return null
  }
  return record
}

export async function assembleSessionContext(
  intent: AssembleSessionIntent,
  deps: RunContextAssemblerDeps
): Promise<AssembledSessionContext> {
  const session = await deps.getSession(intent.sessionId)
  if (!session) {
    throw new Error(`unknown_session: ${intent.sessionId}`)
  }

  const providerId = intent.providerId || session.providerId || ''
  const modelId = intent.modelId || session.modelId || ''
  const resolvedProvider = deps.resolveProvider(providerId, modelId)
  if (!resolvedProvider) {
    throw new Error(`unknown_provider: ${providerId}/${modelId}`)
  }

  const mode = intent.mode || session.mode
  const transcript = await deps.getMessages(intent.sessionId)
  const mapped = transcript.map(toWireMessage)
  const compaction = await deps.getCompaction(intent.sessionId, transcript)
  const requestMessages = applyCompactWatermark(mapped, compaction)
  if (requestMessages.length !== mapped.length) {
    console.log('[RunContextAssembler] Applied compaction cut', {
      sessionId: intent.sessionId,
      before: mapped.length,
      after: requestMessages.length,
      throughSortOrder: compaction?.throughSortOrder ?? null,
      generation: compaction?.generation ?? 0
    })
  }
  const triggerIndex = requestMessages.findIndex(
    (message) => message.id === intent.triggerMessageId
  )
  const historyMessages =
    triggerIndex >= 0 ? requestMessages.slice(0, triggerIndex) : requestMessages
  const turnMessages =
    triggerIndex >= 0 ? requestMessages.slice(triggerIndex, triggerIndex + 1) : []

  const permissionPolicy = deps.readPermissionPolicy()
  const runSettings = deps.readRunSettings()
  const availableTools = [
    ...(await deps.listTools({
      sessionId: intent.sessionId,
      mode,
      projectId: session.projectId
    }))
  ].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
  const { parentTools: tools, subAgentToolCatalog } = splitToolsForSubAgentCatalog({
    mode,
    availableTools
  })
  let systemPrompt = await deps.resolveSystemPrompt({
    sessionId: intent.sessionId,
    mode,
    workingFolder: session.workingFolder,
    sshConnectionId: session.sshConnectionId,
    toolNames: tools.map((tool) => tool.name),
    projectId: session.projectId
  })

  const provider = asProviderRecord(resolvedProvider)
  provider.sessionId = intent.sessionId
  if (systemPrompt) {
    provider.systemPrompt = systemPrompt
  }
  if (provider.type === 'openai-responses') {
    provider.responsesSessionScope = 'agent-main'
  }

  const callerType = intent.callerType ?? 'root'
  const capabilitySnapshot = createCapabilitySnapshotV2({
    sessionId: intent.sessionId,
    projectId: session.projectId,
    mode,
    callerType,
    tools,
    permissionPolicy,
    settingsRevision: runSettings.settingsRevision,
    resolutionReason: 'main-run-context-assembler'
  })

  const permissionMode = runSettings.autoApprove
    ? 'fullAccess'
    : permissionPolicy
      ? 'whitelist'
      : 'default'

  const openTemplate: Record<string, unknown> = {
    runtimeProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    rolloutMode: 'v2',
    sessionId: intent.sessionId,
    mode,
    sessionPromptMode: mode,
    sessionMode: 'agent',
    provider,
    workingFolder: session.workingFolder,
    messages: historyMessages,
    tools,
    ...(subAgentToolCatalog.length > 0 ? { subAgentToolCatalog } : {}),
    capabilitySnapshot,
    maxIterations: runSettings.maxIterations,
    forceApproval: false,
    permissionMode,
    maxParallelTools: runSettings.maxParallelTools,
    maxConcurrentSubAgents: runSettings.maxConcurrentSubAgents,
    includeFullDebugBody: runSettings.devMode === true
  }
  if (session.sshConnectionId) {
    openTemplate.sshConnectionId = session.sshConnectionId
    const connection = deps.resolveSshConnection?.(session.sshConnectionId) ?? null
    if (connection) {
      openTemplate.connection = connection
    } else {
      console.warn(
        `[RunContextAssembler] SSH connection ${session.sshConnectionId} could not be resolved; ` +
          `remote tools will fail until the connection is restored`
      )
    }
  }
  if (session.projectId) {
    openTemplate.projectId = session.projectId
  }
  if (permissionPolicy) {
    openTemplate.permissionPolicy = permissionPolicy
  }
  const hasWebTools = subAgentToolCatalog.some(
    (tool) => tool.name === 'WebSearch' || tool.name === 'WebFetch'
  )
  if (runSettings.webSearch && hasWebTools) {
    openTemplate.webSearch = runSettings.webSearch
  }
  if (intent.commandMetadata) {
    openTemplate.commandMetadata = intent.commandMetadata
    const systemCommand = readCommandObject(intent.commandMetadata.systemCommand, [
      'name',
      'content'
    ])
    if (systemCommand) {
      openTemplate.systemCommand = systemCommand
    }
    const slashCommand = readCommandObject(intent.commandMetadata.slashCommand, ['commandName'])
    if (slashCommand) {
      openTemplate.slashCommand = slashCommand
    }
  }
  if (intent.attachmentIds.length > 0) {
    openTemplate.attachmentIds = intent.attachmentIds
  }
  const requestContextTexts = [...(intent.requestContextTexts ?? [])]
  if (provider.thinkingEnabled === true && provider.reasoningEffort === 'ultra') {
    requestContextTexts.push(MULTI_AGENT_MODE_PROMPT)
  }
  if (tools.some((tool) => tool.name === 'codegraph_explore')) {
    requestContextTexts.push(CODEGRAPH_SYSTEM_GUIDANCE)
  }
  if (requestContextTexts.length > 0) {
    openTemplate.requestContextTexts = requestContextTexts
  }
  const subAgentProvider = deps.resolveSubAgentProvider?.()
  if (subAgentProvider) {
    openTemplate.subAgentProvider = subAgentProvider
  }
  if (intent.extraTemplate) {
    Object.assign(openTemplate, intent.extraTemplate)
  }
  const compression = buildLoopCompressionConfig({
    enabled: runSettings.contextCompressionEnabled === true,
    threshold: runSettings.contextCompressionThreshold,
    model: deps.resolveCompressionModel?.(providerId, modelId) ?? null,
    persistedContextLength: findPersistedContextLength(mapped)
  })
  const compressionProvider = compression ? (deps.resolveCompressionProvider?.() ?? null) : null
  if (compression) {
    openTemplate.compression = compression
    if (compressionProvider) {
      openTemplate.compressionProvider = compressionProvider
    }
  }

  return {
    openTemplate,
    historyMessages,
    turnMessages,
    prefixIdentity: hostedSessionPrefixIdentity({
      sessionId: intent.sessionId,
      mode,
      providerId,
      modelId,
      providerType: typeof provider.type === 'string' ? provider.type : '',
      workingFolder: session.workingFolder,
      sshConnectionId: session.sshConnectionId,
      compressionFence: compressionFenceForTemplate({ compression, compressionProvider }),
      compactFence: compactWatermarkFence(compaction)
    })
  }
}
