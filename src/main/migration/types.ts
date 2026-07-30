export type ProviderType = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini-interactions'

export interface RequestOverrides {
  headers?: Record<string, string>
  body?: Record<string, unknown>
  omitBodyKeys?: string[]
}

export interface AIModelConfig {
  id: string
  name: string
  enabled: boolean
  type?: ProviderType
  category?: 'chat' | 'speech' | 'embedding' | 'image'
  icon?: string
  contextLength?: number
  maxOutputTokens?: number
  inputPrice?: number
  outputPrice?: number
  cacheCreationPrice?: number
  cacheHitPrice?: number
  supportsVision?: boolean
  supportsFunctionCall?: boolean
  supportsThinking?: boolean
  websocketUrl?: string
  websocketMode?: 'auto' | 'disabled'
}

export interface AIProvider {
  id: string
  name: string
  type: ProviderType
  apiKey: string
  baseUrl: string
  enabled: boolean
  models: AIModelConfig[]
  builtinId?: string
  createdAt: number
  requiresApiKey?: boolean
  useSystemProxy?: boolean
  userAgent?: string
  defaultModel?: string
  authMode?: 'apiKey' | 'oauth' | 'channel'
  oauth?: Record<string, unknown>
  oauthConfig?: Record<string, unknown>
  channel?: Record<string, unknown>
  channelConfig?: Record<string, unknown>
  requestOverrides?: RequestOverrides
  instructionsPrompt?: string
  ui?: Record<string, unknown>
  websocketUrl?: string
  websocketMode?: 'auto' | 'disabled'
}

export type McpTransportType = 'stdio' | 'sse' | 'streamable-http'

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  projectId?: string | null
  transport: McpTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  autoFallback?: boolean
  createdAt: number
  description?: string
}

export interface OpenCodeSourceModel {
  id: string
  name?: string
  family?: string
  releaseDate?: string
  reasoning?: boolean
  toolCall?: boolean
  temperature?: boolean
  attachment?: boolean
  modalities?: {
    input?: string[]
    output?: string[]
  }
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
  limit?: {
    context?: number
    input?: number
    output?: number
  }
  raw: Record<string, unknown>
}

export interface OpenCodeSourceProvider {
  key: string
  name: string
  npm?: string
  api?: string
  id?: string
  env?: string[]
  options: Record<string, unknown>
  models: OpenCodeSourceModel[]
  raw: Record<string, unknown>
}

export interface OpenCodeSourceCommand {
  key: string
  description?: string
  template: string
  model?: string
  agent?: string
  subtask?: boolean
  raw: Record<string, unknown>
}

export interface OpenCodeSourceAgent {
  key: string
  description?: string
  prompt: string
  steps?: number
  tools?: string[]
  permission?: Record<string, unknown> | string
  model?: string
  temperature?: number
  mode?: string
  variant?: string
  unsupportedFields: string[]
  raw: Record<string, unknown>
}

export interface OpenCodeSourceMcp {
  key: string
  type?: 'local' | 'remote'
  enabled?: boolean
  command?: string[]
  environment?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  timeout?: number
  oauth?: Record<string, unknown> | false
  raw: Record<string, unknown>
}

export interface OpenCodeInstructionsSource {
  entries: string[]
  resolvedFiles: Array<{ source: string; path: string; content: string }>
  unresolved: Array<{ source: string; reason: string }>
  managedContent: string
}

export interface ParsedOpenCodeConfig {
  sourcePath: string
  sourceDir: string
  exists: boolean
  warnings: string[]
  providers: OpenCodeSourceProvider[]
  commands: OpenCodeSourceCommand[]
  agents: OpenCodeSourceAgent[]
  mcpServers: OpenCodeSourceMcp[]
  instructions: OpenCodeInstructionsSource
  model?: string
  smallModel?: string
}

export type MigrationProviderStrategy = 'builtin' | 'custom'

export interface OpenCoworkProviderDraft {
  provider: AIProvider
  strategy: MigrationProviderStrategy
  matchedBuiltinId?: string
}

export interface ProviderPreviewPayload {
  sourceProviderKey: string
  draft: OpenCoworkProviderDraft
  conflictProviderId?: string
  conflictProviderName?: string
}

export interface ModelSelectionPreviewPayload {
  route: 'main' | 'fast'
  sourceModelRef: string
  sourceProviderKey: string
  sourceModelId: string
}

export interface CommandPreviewPayload {
  sourceCommandKey: string
  targetName: string
  content: string
  existingPath?: string
}

export interface AgentPreviewPayload {
  sourceAgentKey: string
  targetFileName: string
  targetAgentName: string
  content: string
  existingPath?: string
  existingName?: string
}

export interface McpPreviewPayload {
  sourceServerKey: string
  draft: Omit<McpServerConfig, 'id' | 'createdAt'>
  existingId?: string
  existingName?: string
}

export interface InstructionsPreviewPayload {
  files: Array<{ source: string; path: string }>
  managedContent: string
}
