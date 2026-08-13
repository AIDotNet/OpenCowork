import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  createCapabilitySnapshotV2,
  type CapabilityCallerType
} from '../../../shared/agent-runtime-v2'
import { MULTI_AGENT_MODE_PROMPT } from '../../../shared/agent-system-prompt'
import type { SessionRunSettings } from './session-run-settings'
import type { SessionToolDefinition } from './session-tool-catalog'
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
  content: string
  createdAt: number
}

export type AssembledSessionContext = {
  openTemplate: Record<string, unknown>
  historyMessages: AssembledWireMessage[]
  turnMessages: AssembledWireMessage[]
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
  content: string
  createdAt: number
}

export type RunContextAssemblerDeps = {
  getSession: (sessionId: string) => Promise<SessionRecord | null>
  getMessages: (sessionId: string) => Promise<TranscriptMessage[]>
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
}

function toWireMessage(message: TranscriptMessage): AssembledWireMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt
  }
}

function asProviderRecord(provider: Record<string, unknown>): Record<string, unknown> {
  return { ...provider }
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
  const mapped = (await deps.getMessages(intent.sessionId)).map(toWireMessage)
  const triggerIndex = mapped.findIndex((message) => message.id === intent.triggerMessageId)
  const historyMessages = triggerIndex >= 0 ? mapped.slice(0, triggerIndex) : mapped
  const turnMessages = triggerIndex >= 0 ? mapped.slice(triggerIndex, triggerIndex + 1) : []

  const permissionPolicy = deps.readPermissionPolicy()
  const runSettings = deps.readRunSettings()
  const tools = await deps.listTools({
    sessionId: intent.sessionId,
    mode,
    projectId: session.projectId
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
  if (systemPrompt && provider.thinkingEnabled === true && provider.reasoningEffort === 'ultra') {
    systemPrompt = `${systemPrompt}\n\n${MULTI_AGENT_MODE_PROMPT}`
  }
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
    capabilitySnapshot,
    maxIterations: runSettings.maxIterations,
    forceApproval: false,
    permissionMode,
    maxParallelTools: runSettings.maxParallelTools,
    maxConcurrentSubAgents: runSettings.maxConcurrentSubAgents
  }
  if (session.sshConnectionId) {
    openTemplate.sshConnectionId = session.sshConnectionId
  }
  if (session.projectId) {
    openTemplate.projectId = session.projectId
  }
  if (permissionPolicy) {
    openTemplate.permissionPolicy = permissionPolicy
  }
  const hasWebTools = tools.some((tool) => tool.name === 'WebSearch' || tool.name === 'WebFetch')
  if (runSettings.webSearch && hasWebTools) {
    openTemplate.webSearch = runSettings.webSearch
  }
  if (intent.commandMetadata) {
    openTemplate.commandMetadata = intent.commandMetadata
  }
  if (intent.attachmentIds.length > 0) {
    openTemplate.attachmentIds = intent.attachmentIds
  }
  const requestContextTexts = [...(intent.requestContextTexts ?? [])]
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

  return { openTemplate, historyMessages, turnMessages }
}
