import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type {
  MigrationAction,
  MigrationPreviewItem,
  MigrationPreviewResult
} from '../../shared/migration-types'
import { parseOpenCodeConfig } from './opencode-parser'
import type {
  AIModelConfig,
  AIProvider,
  AgentPreviewPayload,
  CommandPreviewPayload,
  InstructionsPreviewPayload,
  McpPreviewPayload,
  McpServerConfig,
  ModelSelectionPreviewPayload,
  OpenCodeSourceAgent,
  OpenCodeSourceCommand,
  OpenCodeSourceMcp,
  OpenCodeSourceProvider,
  OpenCoworkProviderDraft,
  ParsedOpenCodeConfig,
  ProviderPreviewPayload,
  ProviderType
} from './types'

const DATA_DIR = path.join(os.homedir(), '.open-cowork')
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
const COMMANDS_DIR = path.join(DATA_DIR, 'commands')
const AGENTS_DIR = path.join(DATA_DIR, 'agents')
const MCP_PATH = path.join(DATA_DIR, 'mcp-servers.json')
const MEMORY_PATH = path.join(DATA_DIR, 'MEMORY.md')

interface ProviderPersistState {
  providers: AIProvider[]
  activeProviderId: string | null
  activeModelId: string
  activeFastProviderId: string | null
  activeFastModelId: string
}

interface ExistingAgentEntry {
  path: string
  fileName: string
  name: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function readProviderPersistState(): ProviderPersistState {
  const config = readJsonFile<Record<string, unknown>>(CONFIG_PATH, {})
  const bucket = isPlainObject(config['opencowork-providers'])
    ? (config['opencowork-providers'] as Record<string, unknown>)
    : {}
  const state = isPlainObject(bucket.state) ? (bucket.state as Record<string, unknown>) : {}

  return {
    providers: Array.isArray(state.providers) ? (state.providers as AIProvider[]) : [],
    activeProviderId: typeof state.activeProviderId === 'string' ? state.activeProviderId : null,
    activeModelId: typeof state.activeModelId === 'string' ? state.activeModelId : '',
    activeFastProviderId:
      typeof state.activeFastProviderId === 'string' ? state.activeFastProviderId : null,
    activeFastModelId: typeof state.activeFastModelId === 'string' ? state.activeFastModelId : ''
  }
}

function readExistingMcpServers(): McpServerConfig[] {
  return readJsonFile<McpServerConfig[]>(MCP_PATH, [])
}

function readExistingCommandNames(): Map<string, string> {
  const result = new Map<string, string>()
  if (!fs.existsSync(COMMANDS_DIR)) return result

  for (const entry of fs.readdirSync(COMMANDS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    const name = entry.name.replace(/\.md$/i, '')
    result.set(name.toLowerCase(), path.join(COMMANDS_DIR, entry.name))
  }

  return result
}

function readExistingAgents(): ExistingAgentEntry[] {
  if (!fs.existsSync(AGENTS_DIR)) return []

  const result: ExistingAgentEntry[] = []
  for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    const filePath = path.join(AGENTS_DIR, entry.name)
    const content = fs.readFileSync(filePath, 'utf-8')
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
    const frontmatter = match?.[1] ?? ''
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
    const name = (nameMatch?.[1] ?? entry.name.replace(/\.md$/i, ''))
      .trim()
      .replace(/^['"]|['"]$/g, '')
    result.push({
      path: filePath,
      fileName: entry.name,
      name
    })
  }

  return result
}

function toKebabCase(input: string, fallback: string): string {
  const normalized = input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()

  return normalized || fallback
}

function escapeFrontmatterString(value: string): string {
  return JSON.stringify(value)
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '')
}

function inferBuiltinId(source: OpenCodeSourceProvider): string | undefined {
  const name = source.name.toLowerCase()
  const npm = (source.npm ?? '').toLowerCase()
  const api = (source.api ?? '').toLowerCase()
  const baseUrl = normalizeBaseUrl(
    typeof source.options.baseURL === 'string'
      ? source.options.baseURL
      : typeof source.options.baseUrl === 'string'
        ? source.options.baseUrl
        : undefined
  ).toLowerCase()

  if (baseUrl.includes('routin.ai')) return 'routin-ai'
  if (baseUrl.includes('api.openai.com')) return 'openai'
  if (baseUrl.includes('openrouter.ai')) return 'openrouter'
  if (baseUrl.includes('api.anthropic.com')) return 'anthropic'
  if (baseUrl.includes('generativelanguage.googleapis.com') || baseUrl.includes('googleapis.com')) {
    return 'google'
  }
  if (baseUrl.includes('api.deepseek.com')) return 'deepseek'
  if (baseUrl.includes('api.moonshot.cn')) return 'moonshot'
  if (baseUrl.includes('dashscope.aliyuncs.com')) return 'qwen'
  if (baseUrl.includes('api.minimax.chat')) return 'minimax'
  if (baseUrl.includes('qianfan.baidubce.com')) return 'baidu'
  if (baseUrl.includes('api.siliconflow.cn')) return 'siliconflow'
  if (baseUrl.includes('open.bigmodel.cn')) return 'bigmodel'
  if (baseUrl.includes('openai.azure.com')) return 'azure-openai'
  if (baseUrl.includes('127.0.0.1:11434') || baseUrl.includes('localhost:11434')) return 'ollama'

  if (npm.includes('anthropic') || api.includes('anthropic') || name.includes('anthropic')) {
    return 'anthropic'
  }
  if (npm.includes('google') || api.includes('google') || name.includes('gemini')) {
    return 'google'
  }
  if (name.includes('openrouter')) return 'openrouter'
  if (name.includes('openai')) return 'openai'
  if (name.includes('deepseek')) return 'deepseek'
  if (name.includes('moonshot') || name.includes('kimi')) return 'moonshot'
  if (name.includes('qwen')) return 'qwen'
  if (name.includes('minimax')) return 'minimax'
  if (name.includes('baidu')) return 'baidu'
  if (name.includes('bigmodel') || name.includes('智谱')) return 'bigmodel'
  if (name.includes('ollama')) return 'ollama'

  return undefined
}

function inferProviderType(source: OpenCodeSourceProvider, builtinId?: string): ProviderType {
  if (builtinId === 'anthropic') return 'anthropic'
  if (builtinId === 'google') return 'gemini'
  if (builtinId === 'ollama') return 'openai-chat'
  if (builtinId === 'openai') return 'openai-chat'
  if (builtinId === 'openrouter') return 'openai-chat'
  if (builtinId === 'azure-openai') return 'openai-chat'

  const npm = (source.npm ?? '').toLowerCase()
  const api = (source.api ?? '').toLowerCase()
  if (npm.includes('anthropic') || api.includes('anthropic')) return 'anthropic'
  if (npm.includes('google') || api.includes('google')) return 'gemini'
  return 'openai-chat'
}

function inferProviderRequiresApiKey(builtinId?: string): boolean {
  return builtinId !== 'ollama'
}

function inferModelIcon(modelId: string): string | undefined {
  const normalized = modelId.toLowerCase()
  if (normalized.startsWith('gpt') || /^o[134]/.test(normalized)) return 'openai'
  if (normalized.startsWith('claude')) return 'claude'
  if (normalized.startsWith('gemini')) return 'gemini'
  if (normalized.startsWith('deepseek')) return 'deepseek'
  if (normalized.startsWith('qwen')) return 'qwen'
  if (normalized.startsWith('glm')) return 'chatglm'
  if (normalized.startsWith('kimi') || normalized.startsWith('moonshot')) return 'kimi'
  if (normalized.startsWith('doubao')) return 'doubao'
  if (normalized.startsWith('minimax')) return 'minimax'
  if (normalized.startsWith('mimo')) return 'mimo'
  if (normalized.startsWith('grok')) return 'grok'
  if (normalized.startsWith('llama')) return 'llama'
  if (normalized.startsWith('mistral')) return 'mistral'
  if (normalized.startsWith('hunyuan')) return 'hunyuan'
  return undefined
}

function inferModelType(modelId: string, providerType: ProviderType): ProviderType | undefined {
  const normalized = modelId.toLowerCase()
  if (providerType === 'anthropic' || providerType === 'gemini') return providerType
  if (normalized.startsWith('gpt-5') || /^o[134]/.test(normalized)) return 'openai-responses'
  return undefined
}

function toOpenCoworkModel(
  source: OpenCodeSourceProvider,
  model: OpenCodeSourceProvider['models'][number]
): AIModelConfig {
  const builtinId = inferBuiltinId(source)
  const providerType = inferProviderType(source, builtinId)
  const inputModalities = new Set((model.modalities?.input ?? []).map((item) => item.toLowerCase()))

  return {
    id: model.id,
    name: model.name?.trim() || model.id,
    enabled: true,
    icon: inferModelIcon(model.id),
    ...(model.limit?.context ? { contextLength: model.limit.context } : {}),
    ...(model.limit?.output ? { maxOutputTokens: model.limit.output } : {}),
    ...(model.cost?.input !== undefined ? { inputPrice: model.cost.input } : {}),
    ...(model.cost?.output !== undefined ? { outputPrice: model.cost.output } : {}),
    ...(model.cost?.cacheWrite !== undefined ? { cacheCreationPrice: model.cost.cacheWrite } : {}),
    ...(model.cost?.cacheRead !== undefined ? { cacheHitPrice: model.cost.cacheRead } : {}),
    ...(model.reasoning !== undefined ? { supportsThinking: model.reasoning } : {}),
    ...(model.toolCall !== undefined ? { supportsFunctionCall: model.toolCall } : {}),
    ...(inputModalities.has('image') || inputModalities.has('image/*') || model.attachment
      ? { supportsVision: true }
      : {}),
    ...(inferModelType(model.id, providerType)
      ? { type: inferModelType(model.id, providerType) }
      : {})
  }
}

function createProviderDraft(source: OpenCodeSourceProvider): OpenCoworkProviderDraft {
  const builtinId = inferBuiltinId(source)
  const type = inferProviderType(source, builtinId)
  const baseUrl = normalizeBaseUrl(
    typeof source.options.baseURL === 'string'
      ? source.options.baseURL
      : typeof source.options.baseUrl === 'string'
        ? source.options.baseUrl
        : undefined
  )
  const apiKey = typeof source.options.apiKey === 'string' ? source.options.apiKey.trim() : ''
  const models = source.models.map((model) => toOpenCoworkModel(source, model))
  const defaultModel = source.models[0]?.id

  return {
    strategy: builtinId ? 'builtin' : 'custom',
    matchedBuiltinId: builtinId,
    provider: {
      id: `opencode-preview-${source.key}`,
      name: source.name,
      type,
      apiKey,
      baseUrl,
      enabled: true,
      models,
      createdAt: Date.now(),
      ...(builtinId ? { builtinId } : {}),
      ...(defaultModel ? { defaultModel } : {}),
      requiresApiKey: inferProviderRequiresApiKey(builtinId)
    }
  }
}

function findConflictingProvider(
  draft: OpenCoworkProviderDraft,
  providers: AIProvider[]
): AIProvider | undefined {
  const normalizedName = draft.provider.name.trim().toLowerCase()
  const normalizedBaseUrl = normalizeBaseUrl(draft.provider.baseUrl).toLowerCase()

  if (draft.provider.builtinId) {
    const byBuiltin = providers.find((provider) => provider.builtinId === draft.provider.builtinId)
    if (byBuiltin) return byBuiltin
  }

  return providers.find((provider) => {
    const sameBaseUrl =
      normalizedBaseUrl && normalizeBaseUrl(provider.baseUrl).toLowerCase() === normalizedBaseUrl
    const sameName = provider.name.trim().toLowerCase() === normalizedName
    return sameBaseUrl || sameName
  })
}

function summarizeSelectionLabel(
  providerId: string | null,
  modelId: string,
  providers: AIProvider[]
): string {
  if (!providerId || !modelId) return 'Not configured'
  const provider = providers.find((item) => item.id === providerId)
  if (!provider) return 'Not configured'
  const model = provider.models.find((item) => item.id === modelId)
  return `${provider.name} / ${model?.name ?? modelId}`
}

function buildUnsupportedFieldList(command: OpenCodeSourceCommand): string[] {
  const unsupported: string[] = []
  if (command.description) unsupported.push('description')
  if (command.model) unsupported.push('model')
  if (command.agent) unsupported.push('agent')
  if (command.subtask !== undefined) unsupported.push('subtask')
  return unsupported
}

function buildAllowedActions(conflict: boolean): MigrationAction[] {
  return conflict ? ['replace', 'skip', 'duplicate'] : ['create', 'skip']
}

function buildAgentMarkdown(agent: OpenCodeSourceAgent, targetAgentName: string): string {
  const frontmatterLines = [
    '---',
    `name: ${targetAgentName}`,
    `description: ${escapeFrontmatterString(agent.description?.trim() || `${agent.key} migrated from OpenCode`)}`
  ]

  if (agent.tools && agent.tools.length > 0) {
    frontmatterLines.push(`allowedTools: ${agent.tools.join(', ')}`)
  }
  if (agent.steps && agent.steps > 0) {
    frontmatterLines.push(`maxIterations: ${Math.round(agent.steps)}`)
  }
  if (agent.temperature !== undefined) {
    frontmatterLines.push(`temperature: ${agent.temperature}`)
  }
  if (agent.model) {
    frontmatterLines.push(`model: ${escapeFrontmatterString(agent.model)}`)
  }

  frontmatterLines.push('---', '', agent.prompt.trim())
  return frontmatterLines.join('\n')
}

function findExistingAgent(
  targetFileName: string,
  targetAgentName: string,
  existingAgents: ExistingAgentEntry[]
): ExistingAgentEntry | undefined {
  const normalizedFile = targetFileName.toLowerCase()
  const normalizedName = targetAgentName.trim().toLowerCase()
  return existingAgents.find(
    (entry) =>
      entry.fileName.toLowerCase() === normalizedFile ||
      entry.name.trim().toLowerCase() === normalizedName
  )
}

function toMcpDraft(source: OpenCodeSourceMcp): Omit<McpServerConfig, 'id' | 'createdAt'> | null {
  const type =
    source.type ??
    (source.command && source.command.length > 0 ? 'local' : source.url ? 'remote' : undefined)
  if (type === 'local') {
    if (!source.command || source.command.length === 0) return null
    return {
      name: source.key,
      enabled: source.enabled ?? true,
      transport: 'stdio',
      command: source.command[0],
      args: source.command.slice(1),
      env: source.environment
    }
  }

  if (type === 'remote') {
    if (!source.url) return null
    return {
      name: source.key,
      enabled: source.enabled ?? true,
      transport: source.url.includes('/sse') ? 'sse' : 'streamable-http',
      url: source.url,
      headers: source.headers,
      autoFallback: source.url.includes('/sse') ? undefined : true
    }
  }

  return null
}

function buildInstructionsPreviewItem(parsed: ParsedOpenCodeConfig): MigrationPreviewItem | null {
  const hasEntries = parsed.instructions.entries.length > 0
  const hasResolved = parsed.instructions.resolvedFiles.length > 0
  const hasUnresolved = parsed.instructions.unresolved.length > 0
  if (!hasEntries && !hasResolved && !hasUnresolved) return null

  const warnings = parsed.instructions.unresolved.map((item) => `${item.source}：${item.reason}`)

  const payload: InstructionsPreviewPayload = {
    files: parsed.instructions.resolvedFiles.map((file) => ({
      source: file.source,
      path: file.path
    })),
    managedContent: parsed.instructions.managedContent
  }

  return {
    id: 'instructions:managed-memory',
    kind: 'instructions',
    title: 'OpenCode instructions -> MEMORY.md',
    sourceLabel: `${parsed.instructions.entries.length} instructions`,
    targetLabel: 'Global MEMORY.md managed section',
    targetPath: MEMORY_PATH,
    conflict: fs.existsSync(MEMORY_PATH),
    defaultAction: hasResolved ? 'replace' : 'skip',
    allowedActions: ['replace', 'skip'],
    warnings,
    unsupportedFields: [],
    details: [
      { label: 'Readable files', value: String(parsed.instructions.resolvedFiles.length) },
      { label: 'Unresolved items', value: String(parsed.instructions.unresolved.length) }
    ],
    payload: payload as unknown as Record<string, unknown>
  }
}

function buildProviderPreviewItems(
  parsed: ParsedOpenCodeConfig,
  currentState: ProviderPersistState
): MigrationPreviewItem[] {
  return parsed.providers.map((source) => {
    const draft = createProviderDraft(source)
    const conflict = findConflictingProvider(draft, currentState.providers)
    const warnings: string[] = []
    if (draft.provider.requiresApiKey !== false && !draft.provider.apiKey.trim()) {
      warnings.push(
        'API Key is empty, manual completion or env var verification needed after migration'
      )
    }
    if (draft.provider.models.length === 0) {
      warnings.push('This Provider has no migratable model definitions')
    }

    const payload: ProviderPreviewPayload = {
      sourceProviderKey: source.key,
      draft,
      ...(conflict ? { conflictProviderId: conflict.id, conflictProviderName: conflict.name } : {})
    }

    return {
      id: `provider:${source.key}`,
      kind: 'provider',
      title: source.name,
      sourceLabel: source.key,
      targetLabel: conflict ? conflict.name : draft.provider.name,
      conflict: Boolean(conflict),
      defaultAction: conflict ? 'replace' : 'create',
      allowedActions: buildAllowedActions(Boolean(conflict)),
      warnings,
      unsupportedFields: [],
      details: [
        { label: 'Source npm', value: source.npm ?? '-' },
        { label: 'Base URL', value: draft.provider.baseUrl || '-' },
        {
          label: 'Target type',
          value:
            draft.strategy === 'builtin'
              ? `Built-in preset ${draft.matchedBuiltinId}`
              : 'Custom Provider'
        },
        { label: 'Models', value: String(draft.provider.models.length) }
      ],
      payload: payload as unknown as Record<string, unknown>
    }
  })
}

function buildModelSelectionItem(
  id: string,
  kind: 'mainModelSelection' | 'fastModelSelection',
  title: string,
  sourceRef: string | undefined,
  currentLabel: string,
  parsed: ParsedOpenCodeConfig
): MigrationPreviewItem | null {
  if (!sourceRef) return null
  const separatorIndex = sourceRef.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex === sourceRef.length - 1) {
    return {
      id,
      kind,
      title,
      sourceLabel: sourceRef,
      targetLabel: currentLabel,
      conflict: true,
      defaultAction: 'skip',
      allowedActions: ['replace', 'skip'],
      warnings: ['Invalid model reference format, expected provider/model'],
      unsupportedFields: [],
      details: [],
      payload: {
        route: kind === 'mainModelSelection' ? 'main' : 'fast',
        sourceModelRef: sourceRef,
        sourceProviderKey: '',
        sourceModelId: ''
      } as unknown as Record<string, unknown>
    }
  }

  const sourceProviderKey = sourceRef.slice(0, separatorIndex)
  const sourceModelId = sourceRef.slice(separatorIndex + 1)
  const sourceProvider = parsed.providers.find((provider) => provider.key === sourceProviderKey)
  const sourceModel = sourceProvider?.models.find((model) => model.id === sourceModelId)

  const warnings: string[] = []
  if (!sourceProvider) {
    warnings.push(`Source Provider not found: ${sourceProviderKey}`)
  }
  if (sourceProvider && !sourceModel) {
    warnings.push(`Model not found in source Provider: ${sourceModelId}`)
  }

  const payload: ModelSelectionPreviewPayload = {
    route: kind === 'mainModelSelection' ? 'main' : 'fast',
    sourceModelRef: sourceRef,
    sourceProviderKey,
    sourceModelId
  }

  return {
    id,
    kind,
    title,
    sourceLabel: sourceRef,
    targetLabel: sourceProvider
      ? `${sourceProvider.name} / ${sourceModel?.name ?? sourceModelId}`
      : currentLabel,
    conflict: true,
    defaultAction: warnings.length > 0 ? 'skip' : 'replace',
    allowedActions: ['replace', 'skip'],
    warnings,
    unsupportedFields: [],
    details: [{ label: 'Current selection', value: currentLabel }],
    payload: payload as unknown as Record<string, unknown>
  }
}

function buildCommandPreviewItems(
  parsed: ParsedOpenCodeConfig,
  existingCommandNames: Map<string, string>
): MigrationPreviewItem[] {
  return parsed.commands.map((command) => {
    const targetName = toKebabCase(command.key, 'command')
    const existingPath = existingCommandNames.get(targetName.toLowerCase())
    const warnings =
      command.key !== targetName ? [`Command name will be normalized to ${targetName}`] : []
    const payload: CommandPreviewPayload = {
      sourceCommandKey: command.key,
      targetName,
      content: command.template.trim(),
      ...(existingPath ? { existingPath } : {})
    }

    return {
      id: `command:${command.key}`,
      kind: 'command',
      title: command.key,
      sourceLabel: command.key,
      targetLabel: `/${targetName}`,
      targetPath: path.join(COMMANDS_DIR, `${targetName}.md`),
      conflict: Boolean(existingPath),
      defaultAction: existingPath ? 'replace' : 'create',
      allowedActions: buildAllowedActions(Boolean(existingPath)),
      warnings,
      unsupportedFields: buildUnsupportedFieldList(command),
      details: [
        { label: 'Target file', value: `${targetName}.md` },
        ...(command.description ? [{ label: 'description', value: command.description }] : []),
        ...(command.model ? [{ label: 'model', value: command.model }] : []),
        ...(command.agent ? [{ label: 'agent', value: command.agent }] : []),
        ...(command.subtask !== undefined
          ? [{ label: 'subtask', value: String(command.subtask) }]
          : [])
      ],
      payload: payload as unknown as Record<string, unknown>
    }
  })
}

function buildAgentPreviewItems(
  parsed: ParsedOpenCodeConfig,
  existingAgents: ExistingAgentEntry[]
): MigrationPreviewItem[] {
  return parsed.agents.map((agent) => {
    const targetFileBase = toKebabCase(agent.key, 'agent')
    const targetFileName = `${targetFileBase}.md`
    const targetAgentName = agent.key
    const existing = findExistingAgent(targetFileName, targetAgentName, existingAgents)
    const warnings: string[] = []
    if (agent.permission) {
      warnings.push('permission is preview-only and will not be written to target Agent')
    }
    if (agent.mode) {
      warnings.push('mode is preview-only and will not be written to target Agent')
    }
    if (agent.variant) {
      warnings.push('variant is preview-only and will not be written to target Agent')
    }

    const payload: AgentPreviewPayload = {
      sourceAgentKey: agent.key,
      targetFileName,
      targetAgentName,
      content: buildAgentMarkdown(agent, targetAgentName),
      ...(existing ? { existingPath: existing.path, existingName: existing.name } : {})
    }

    return {
      id: `agent:${agent.key}`,
      kind: 'agent',
      title: agent.key,
      sourceLabel: agent.key,
      targetLabel: targetAgentName,
      targetPath: path.join(AGENTS_DIR, targetFileName),
      conflict: Boolean(existing),
      defaultAction: existing ? 'replace' : 'create',
      allowedActions: buildAllowedActions(Boolean(existing)),
      warnings,
      unsupportedFields: [
        ...(agent.permission ? ['permission'] : []),
        ...(agent.mode ? ['mode'] : []),
        ...(agent.variant ? ['variant'] : []),
        ...agent.unsupportedFields
      ],
      details: [
        { label: 'Target file', value: targetFileName },
        ...(agent.description ? [{ label: 'description', value: agent.description }] : []),
        ...(agent.model ? [{ label: 'model', value: agent.model }] : []),
        ...(agent.steps ? [{ label: 'steps', value: String(agent.steps) }] : []),
        ...(agent.tools?.length ? [{ label: 'tools', value: agent.tools.join(', ') }] : [])
      ],
      payload: payload as unknown as Record<string, unknown>
    }
  })
}

function buildMcpPreviewItems(
  parsed: ParsedOpenCodeConfig,
  existingServers: McpServerConfig[]
): MigrationPreviewItem[] {
  return parsed.mcpServers.map<MigrationPreviewItem>((server) => {
    const draft = toMcpDraft(server)
    if (!draft) {
      return {
        id: `mcp:${server.key}`,
        kind: 'mcp' as const,
        title: server.key,
        sourceLabel: server.key,
        targetLabel: server.key,
        conflict: false,
        defaultAction: 'skip' as const,
        allowedActions: ['skip'] as MigrationAction[],
        warnings: ['Missing mappable command or url, skipped'],
        unsupportedFields: [],
        details: [],
        payload: {
          sourceServerKey: server.key,
          draft: null
        } as unknown as Record<string, unknown>
      }
    }

    const existing = existingServers.find(
      (item) => item.name.trim().toLowerCase() === draft.name.trim().toLowerCase()
    )
    const warnings: string[] = []
    if (server.timeout !== undefined) {
      warnings.push('timeout is preview-only and will not be written to target MCP config')
    }
    if (server.oauth !== undefined) {
      warnings.push('oauth is preview-only and will not be written to target MCP config')
    }

    const payload: McpPreviewPayload = {
      sourceServerKey: server.key,
      draft,
      ...(existing ? { existingId: existing.id, existingName: existing.name } : {})
    }

    return {
      id: `mcp:${server.key}`,
      kind: 'mcp',
      title: server.key,
      sourceLabel: server.key,
      targetLabel: draft.name,
      targetPath: MCP_PATH,
      conflict: Boolean(existing),
      defaultAction: existing ? 'replace' : 'create',
      allowedActions: buildAllowedActions(Boolean(existing)),
      warnings,
      unsupportedFields: [
        ...(server.timeout !== undefined ? ['timeout'] : []),
        ...(server.oauth !== undefined ? ['oauth'] : [])
      ],
      details: [
        { label: 'transport', value: draft.transport },
        ...(draft.command ? [{ label: 'command', value: draft.command }] : []),
        ...(draft.args?.length ? [{ label: 'args', value: draft.args.join(' ') }] : []),
        ...(draft.url ? [{ label: 'url', value: draft.url }] : [])
      ],
      payload: payload as unknown as Record<string, unknown>
    }
  })
}

function buildPreviewSummary(
  items: MigrationPreviewItem[],
  warnings: string[]
): MigrationPreviewResult['summary'] {
  const warningCount =
    warnings.length + items.reduce((count, item) => count + item.warnings.length, 0)
  return {
    total: items.length,
    conflicts: items.filter((item) => item.conflict).length,
    warnings: warningCount,
    actionable: items.filter((item) => item.allowedActions.some((action) => action !== 'skip'))
      .length
  }
}

export function buildOpenCodeMigrationPreview(): MigrationPreviewResult {
  const parsed = parseOpenCodeConfig()
  if (!parsed.exists) {
    return {
      source: 'opencode',
      sourcePath: parsed.sourcePath,
      detected: false,
      warnings: parsed.warnings,
      items: [],
      summary: buildPreviewSummary([], parsed.warnings),
      generatedAt: Date.now()
    }
  }

  const providerState = readProviderPersistState()
  const existingCommandNames = readExistingCommandNames()
  const existingAgents = readExistingAgents()
  const existingServers = readExistingMcpServers()

  const items: MigrationPreviewItem[] = [
    ...buildProviderPreviewItems(parsed, providerState),
    ...buildCommandPreviewItems(parsed, existingCommandNames),
    ...buildAgentPreviewItems(parsed, existingAgents),
    ...buildMcpPreviewItems(parsed, existingServers)
  ]

  const mainSelectionItem = buildModelSelectionItem(
    'selection:main',
    'mainModelSelection',
    'Main model selection',
    parsed.model,
    summarizeSelectionLabel(
      providerState.activeProviderId,
      providerState.activeModelId,
      providerState.providers
    ),
    parsed
  )
  if (mainSelectionItem) items.push(mainSelectionItem)

  const fastSelectionItem = buildModelSelectionItem(
    'selection:fast',
    'fastModelSelection',
    'Quick model selection',
    parsed.smallModel,
    summarizeSelectionLabel(
      providerState.activeFastProviderId,
      providerState.activeFastModelId,
      providerState.providers
    ),
    parsed
  )
  if (fastSelectionItem) items.push(fastSelectionItem)

  const instructionsItem = buildInstructionsPreviewItem(parsed)
  if (instructionsItem) items.push(instructionsItem)

  return {
    source: 'opencode',
    sourcePath: parsed.sourcePath,
    detected: true,
    warnings: parsed.warnings,
    items,
    summary: buildPreviewSummary(items, parsed.warnings),
    generatedAt: Date.now()
  }
}
