import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type {
  MigrationAction,
  MigrationApplyDecision,
  MigrationApplyResult,
  MigrationApplyResultItem,
  MigrationPreviewItem
} from '../../shared/migration-types'
import { createMigrationBackup } from './migration-backup'
import { buildOpenCodeMigrationPreview } from './opencode-preview'
import type {
  AIModelConfig,
  AIProvider,
  AgentPreviewPayload,
  CommandPreviewPayload,
  InstructionsPreviewPayload,
  McpPreviewPayload,
  McpServerConfig,
  ModelSelectionPreviewPayload,
  ProviderPreviewPayload
} from './types'

const DATA_DIR = path.join(os.homedir(), '.open-cowork')
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
const COMMANDS_DIR = path.join(DATA_DIR, 'commands')
const AGENTS_DIR = path.join(DATA_DIR, 'agents')
const MCP_PATH = path.join(DATA_DIR, 'mcp-servers.json')
const MEMORY_PATH = path.join(DATA_DIR, 'MEMORY.md')
const MEMORY_SECTION_START = '<!-- opencode-migration:start -->'
const MEMORY_SECTION_END = '<!-- opencode-migration:end -->'

interface ProviderPersistBucket {
  state: Record<string, unknown>
  version: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function ensureDirForFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  ensureDirForFile(filePath)
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

function readConfigRoot(): Record<string, unknown> {
  return readJsonFile<Record<string, unknown>>(CONFIG_PATH, {})
}

function readProviderBucket(configRoot: Record<string, unknown>): ProviderPersistBucket {
  const rawBucket = isPlainObject(configRoot['opencowork-providers'])
    ? (configRoot['opencowork-providers'] as Record<string, unknown>)
    : {}
  return {
    state: isPlainObject(rawBucket.state)
      ? { ...(rawBucket.state as Record<string, unknown>) }
      : {},
    version: typeof rawBucket.version === 'number' ? rawBucket.version : 0
  }
}

function readExistingMcpServers(): McpServerConfig[] {
  return readJsonFile<McpServerConfig[]>(MCP_PATH, [])
}

function getPreviewPayload<T>(item: MigrationPreviewItem): T | null {
  if (!isPlainObject(item.payload)) return null
  return item.payload as unknown as T
}

function resolveDecision(
  item: MigrationPreviewItem,
  decisionMap: Map<string, MigrationAction>
): MigrationAction {
  const requested = decisionMap.get(item.id)
  if (requested && item.allowedActions.includes(requested)) return requested
  return item.defaultAction
}

function createDecisionMap(decisions: MigrationApplyDecision[]): Map<string, MigrationAction> {
  return new Map(decisions.map((decision) => [decision.id, decision.action]))
}

function uniqueDisplayName(baseName: string, existingNames: Iterable<string>): string {
  const existing = new Set(Array.from(existingNames, (item) => item.trim().toLowerCase()))
  const base = baseName.trim() || 'Imported'
  if (!existing.has(base.toLowerCase())) return base

  let counter = 1
  while (true) {
    const candidate = counter === 1 ? `${base} Copy` : `${base} Copy ${counter}`
    if (!existing.has(candidate.toLowerCase())) return candidate
    counter += 1
  }
}

function uniqueKebabName(baseName: string, existingNames: Iterable<string>): string {
  const existing = new Set(Array.from(existingNames, (item) => item.trim().toLowerCase()))
  const base = baseName.trim().toLowerCase() || 'imported'
  if (!existing.has(base)) return base

  let counter = 1
  while (true) {
    const candidate = counter === 1 ? `${base}-copy` : `${base}-copy-${counter}`
    if (!existing.has(candidate.toLowerCase())) return candidate
    counter += 1
  }
}

function setAgentNameInMarkdown(content: string, nextName: string): string {
  return content.replace(/^name:\s*.+$/m, `name: ${nextName}`)
}

function mergeProviderModels(
  existingModels: AIModelConfig[],
  importedModels: AIModelConfig[]
): AIModelConfig[] {
  const result = existingModels.map((model) => cloneValue(model))
  const indexById = new Map(
    result.map((model, index) => [model.id.trim().toLowerCase(), index] as const)
  )

  for (const importedModel of importedModels) {
    const key = importedModel.id.trim().toLowerCase()
    const existingIndex = indexById.get(key)
    if (existingIndex === undefined) {
      indexById.set(key, result.length)
      result.push(cloneValue(importedModel))
      continue
    }

    result[existingIndex] = {
      ...result[existingIndex],
      ...cloneValue(importedModel),
      enabled: importedModel.enabled ?? result[existingIndex].enabled
    }
  }

  return result
}

function mergeProviderForReplace(existing: AIProvider, imported: AIProvider): AIProvider {
  const next: AIProvider = {
    ...cloneValue(existing),
    ...cloneValue(imported),
    id: existing.id,
    createdAt: existing.createdAt,
    apiKey: imported.apiKey.trim() ? imported.apiKey : existing.apiKey,
    baseUrl: imported.baseUrl.trim() ? imported.baseUrl : existing.baseUrl,
    models: mergeProviderModels(existing.models, imported.models),
    builtinId: existing.builtinId ?? imported.builtinId,
    oauth: existing.oauth,
    channel: existing.channel,
    ...(imported.oauthConfig ? { oauthConfig: imported.oauthConfig } : {}),
    ...(imported.channelConfig ? { channelConfig: imported.channelConfig } : {}),
    ...(imported.requestOverrides ? { requestOverrides: imported.requestOverrides } : {}),
    ...(imported.instructionsPrompt ? { instructionsPrompt: imported.instructionsPrompt } : {}),
    ...(imported.ui ? { ui: imported.ui } : {})
  }
  if (!next.defaultModel && next.models.length > 0) {
    next.defaultModel = next.models[0].id
  }
  return next
}

function mergeMcpForReplace(
  existing: McpServerConfig,
  imported: Omit<McpServerConfig, 'id' | 'createdAt'>
): McpServerConfig {
  return {
    ...cloneValue(existing),
    ...cloneValue(imported),
    id: existing.id,
    createdAt: existing.createdAt,
    projectId: existing.projectId
  }
}

function buildManagedMemorySection(content: string): string {
  const body = content.trim() || 'No importable OpenCode instructions content found.'
  return [
    MEMORY_SECTION_START,
    '## Imported from OpenCode instructions',
    '',
    'The following content is automatically maintained by the OpenCode Migration Center and will be overwritten on re-migration.',
    '',
    body,
    MEMORY_SECTION_END
  ].join('\n')
}

function upsertManagedMemorySection(existingContent: string, managedContent: string): string {
  const block = buildManagedMemorySection(managedContent)
  const startIndex = existingContent.indexOf(MEMORY_SECTION_START)
  const endIndex = existingContent.indexOf(MEMORY_SECTION_END)

  if (startIndex >= 0 && endIndex > startIndex) {
    const before = existingContent.slice(0, startIndex).replace(/\s*$/, '')
    const after = existingContent.slice(endIndex + MEMORY_SECTION_END.length).replace(/^\s*/, '')
    return [before, block, after].filter(Boolean).join('\n\n').trimEnd() + '\n'
  }

  const trimmed = existingContent.trimEnd()
  if (!trimmed) return `${block}\n`
  return `${trimmed}\n\n${block}\n`
}

function buildBackupFileList(
  items: MigrationPreviewItem[],
  decisionMap: Map<string, MigrationAction>
): string[] {
  const filePaths = new Set<string>()

  for (const item of items) {
    const action = resolveDecision(item, decisionMap)
    if (action === 'skip') continue

    if (
      item.kind === 'provider' ||
      item.kind === 'mainModelSelection' ||
      item.kind === 'fastModelSelection'
    ) {
      filePaths.add(CONFIG_PATH)
    }

    if (item.kind === 'mcp') {
      filePaths.add(MCP_PATH)
    }

    if (item.kind === 'instructions') {
      filePaths.add(MEMORY_PATH)
    }

    if (item.kind === 'command' && action === 'replace') {
      const payload = getPreviewPayload<CommandPreviewPayload>(item)
      if (payload?.existingPath) filePaths.add(payload.existingPath)
    }

    if (item.kind === 'agent' && action === 'replace') {
      const payload = getPreviewPayload<AgentPreviewPayload>(item)
      if (payload?.existingPath) filePaths.add(payload.existingPath)
    }
  }

  return Array.from(filePaths)
}

function createSkippedResult(
  item: MigrationPreviewItem,
  action: MigrationAction
): MigrationApplyResultItem {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    action,
    status: 'skipped',
    targetPath: item.targetPath,
    warnings: item.warnings,
    message: 'Skipped'
  }
}

function createSuccessResult(
  item: MigrationPreviewItem,
  action: MigrationAction,
  targetPath?: string,
  message?: string
): MigrationApplyResultItem {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    action,
    status: 'success',
    targetPath: targetPath ?? item.targetPath,
    warnings: item.warnings,
    ...(message ? { message } : {})
  }
}

function createFailedResult(
  item: MigrationPreviewItem,
  action: MigrationAction,
  error: unknown
): MigrationApplyResultItem {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    action,
    status: 'failed',
    targetPath: item.targetPath,
    warnings: item.warnings,
    message: error instanceof Error ? error.message : String(error)
  }
}

export function applyOpenCodeMigration(
  decisions: MigrationApplyDecision[] = []
): MigrationApplyResult {
  const preview = buildOpenCodeMigrationPreview()
  const decisionMap = createDecisionMap(decisions)

  if (!preview.detected) {
    return {
      source: 'opencode',
      sourcePath: preview.sourcePath,
      backupPath: undefined,
      warnings: preview.warnings,
      results: [],
      summary: {
        total: 0,
        applied: 0,
        skipped: 0,
        failed: 0
      },
      appliedAt: Date.now()
    }
  }

  const configRoot = readConfigRoot()
  const providerBucket = readProviderBucket(configRoot)
  const providerState = providerBucket.state
  const providers = Array.isArray(providerState.providers)
    ? cloneValue(providerState.providers as AIProvider[])
    : []
  const providerIdBySourceKey = new Map<string, string>()
  const providerNameSet = new Set(providers.map((provider) => provider.name))
  const existingMcpServers = cloneValue(readExistingMcpServers())
  const existingCommandNames = new Map<string, string>()
  if (fs.existsSync(COMMANDS_DIR)) {
    for (const entry of fs.readdirSync(COMMANDS_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      const name = entry.name.replace(/\.md$/i, '')
      existingCommandNames.set(name.toLowerCase(), path.join(COMMANDS_DIR, entry.name))
    }
  }
  const existingAgents: Array<{ path: string; fileName: string; name: string }> = []
  if (fs.existsSync(AGENTS_DIR)) {
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
      existingAgents.push({ path: filePath, fileName: entry.name, name })
    }
  }

  const backupPath = createMigrationBackup(
    'opencode',
    buildBackupFileList(preview.items, decisionMap)
  )
  const results: MigrationApplyResultItem[] = []
  const warnings = [...preview.warnings]
  let configChanged = false
  let mcpChanged = false

  const providerItems = preview.items.filter((item) => item.kind === 'provider')
  const commandItems = preview.items.filter((item) => item.kind === 'command')
  const agentItems = preview.items.filter((item) => item.kind === 'agent')
  const mcpItems = preview.items.filter((item) => item.kind === 'mcp')
  const selectionItems = preview.items.filter(
    (item) => item.kind === 'mainModelSelection' || item.kind === 'fastModelSelection'
  )
  const instructionItems = preview.items.filter((item) => item.kind === 'instructions')

  for (const item of providerItems) {
    const action = resolveDecision(item, decisionMap)
    const payload = getPreviewPayload<ProviderPreviewPayload>(item)
    if (!payload) {
      results.push(createFailedResult(item, action, 'Provider payload missing'))
      continue
    }

    if (action === 'skip') {
      if (payload.conflictProviderId) {
        providerIdBySourceKey.set(payload.sourceProviderKey, payload.conflictProviderId)
      }
      results.push(createSkippedResult(item, action))
      continue
    }

    try {
      if (action === 'replace') {
        const targetId = payload.conflictProviderId
        const index = targetId ? providers.findIndex((provider) => provider.id === targetId) : -1
        if (index < 0) {
          throw new Error('Target Provider to replace not found')
        }
        providers[index] = mergeProviderForReplace(providers[index], payload.draft.provider)
        providerIdBySourceKey.set(payload.sourceProviderKey, providers[index].id)
        providerNameSet.add(providers[index].name)
        configChanged = true
        results.push(createSuccessResult(item, action, undefined, 'Overwrote existing Provider'))
        continue
      }

      const nextProvider = cloneValue(payload.draft.provider)
      nextProvider.id = randomUUID()
      nextProvider.createdAt = Date.now()
      const desiredName =
        action === 'duplicate'
          ? uniqueDisplayName(nextProvider.name, providerNameSet)
          : uniqueDisplayName(nextProvider.name, providerNameSet)
      nextProvider.name = desiredName
      providerNameSet.add(nextProvider.name)
      providers.push(nextProvider)
      providerIdBySourceKey.set(payload.sourceProviderKey, nextProvider.id)
      configChanged = true
      results.push(
        createSuccessResult(
          item,
          action,
          undefined,
          desiredName === payload.draft.provider.name
            ? 'Created Provider'
            : `Created Provider: ${desiredName}`
        )
      )
    } catch (error) {
      results.push(createFailedResult(item, action, error))
    }
  }

  for (const item of commandItems) {
    const action = resolveDecision(item, decisionMap)
    const payload = getPreviewPayload<CommandPreviewPayload>(item)
    if (!payload) {
      results.push(createFailedResult(item, action, 'Command payload missing'))
      continue
    }
    if (action === 'skip') {
      results.push(createSkippedResult(item, action))
      continue
    }

    try {
      fs.mkdirSync(COMMANDS_DIR, { recursive: true })
      let finalName = payload.targetName
      if (action === 'duplicate') {
        finalName = uniqueKebabName(payload.targetName, existingCommandNames.keys())
      } else if (existingCommandNames.has(finalName.toLowerCase()) && !payload.existingPath) {
        finalName = uniqueKebabName(payload.targetName, existingCommandNames.keys())
      }

      const targetPath =
        action === 'replace' && payload.existingPath
          ? payload.existingPath
          : path.join(COMMANDS_DIR, `${finalName}.md`)
      ensureDirForFile(targetPath)
      fs.writeFileSync(targetPath, payload.content.trim(), 'utf-8')
      existingCommandNames.set(finalName.toLowerCase(), targetPath)
      results.push(
        createSuccessResult(
          item,
          action,
          targetPath,
          finalName === payload.targetName ? 'Command written' : `Command written: /${finalName}`
        )
      )
    } catch (error) {
      results.push(createFailedResult(item, action, error))
    }
  }

  for (const item of agentItems) {
    const action = resolveDecision(item, decisionMap)
    const payload = getPreviewPayload<AgentPreviewPayload>(item)
    if (!payload) {
      results.push(createFailedResult(item, action, 'Agent payload missing'))
      continue
    }
    if (action === 'skip') {
      results.push(createSkippedResult(item, action))
      continue
    }

    try {
      fs.mkdirSync(AGENTS_DIR, { recursive: true })
      let finalAgentName = payload.targetAgentName
      let finalFileName = payload.targetFileName
      if (action === 'duplicate') {
        finalAgentName = uniqueDisplayName(
          payload.targetAgentName,
          existingAgents.map((entry) => entry.name)
        )
        finalFileName = `${uniqueKebabName(
          finalAgentName.toLowerCase().replace(/\s+/g, '-'),
          existingAgents.map((entry) => entry.fileName.replace(/\.md$/i, ''))
        )}.md`
      } else if (
        !payload.existingPath &&
        existingAgents.some(
          (entry) =>
            entry.fileName.toLowerCase() === finalFileName.toLowerCase() ||
            entry.name.trim().toLowerCase() === finalAgentName.trim().toLowerCase()
        )
      ) {
        finalAgentName = uniqueDisplayName(
          payload.targetAgentName,
          existingAgents.map((entry) => entry.name)
        )
        finalFileName = `${uniqueKebabName(
          finalAgentName.toLowerCase().replace(/\s+/g, '-'),
          existingAgents.map((entry) => entry.fileName.replace(/\.md$/i, ''))
        )}.md`
      }

      const targetPath =
        action === 'replace' && payload.existingPath
          ? payload.existingPath
          : path.join(AGENTS_DIR, finalFileName)
      const content = setAgentNameInMarkdown(payload.content, finalAgentName)
      ensureDirForFile(targetPath)
      fs.writeFileSync(targetPath, content, 'utf-8')

      const existingIndex = existingAgents.findIndex((entry) => entry.path === targetPath)
      const agentEntry = {
        path: targetPath,
        fileName: path.basename(targetPath),
        name: finalAgentName
      }
      if (existingIndex >= 0) existingAgents[existingIndex] = agentEntry
      else existingAgents.push(agentEntry)

      results.push(
        createSuccessResult(
          item,
          action,
          targetPath,
          finalAgentName === payload.targetAgentName
            ? 'Agent written'
            : `Agent written: ${finalAgentName}`
        )
      )
    } catch (error) {
      results.push(createFailedResult(item, action, error))
    }
  }

  for (const item of mcpItems) {
    const action = resolveDecision(item, decisionMap)
    const payload = getPreviewPayload<McpPreviewPayload>(item)
    if (!payload || !payload.draft) {
      results.push(createSkippedResult(item, 'skip'))
      continue
    }
    if (action === 'skip') {
      results.push(createSkippedResult(item, action))
      continue
    }

    try {
      if (action === 'replace') {
        const targetId = payload.existingId
        const index = targetId
          ? existingMcpServers.findIndex((server) => server.id === targetId)
          : -1
        if (index < 0) {
          throw new Error('MCP server to replace not found')
        }
        existingMcpServers[index] = mergeMcpForReplace(existingMcpServers[index], payload.draft)
        mcpChanged = true
        results.push(createSuccessResult(item, action, MCP_PATH, 'Overwrote existing MCP server'))
        continue
      }

      const desiredName = uniqueDisplayName(
        payload.draft.name,
        existingMcpServers.map((server) => server.name)
      )
      existingMcpServers.push({
        ...cloneValue(payload.draft),
        name: desiredName,
        id: randomUUID(),
        createdAt: Date.now()
      })
      mcpChanged = true
      results.push(
        createSuccessResult(
          item,
          action,
          MCP_PATH,
          desiredName === payload.draft.name
            ? 'Created MCP server'
            : `Created MCP server: ${desiredName}`
        )
      )
    } catch (error) {
      results.push(createFailedResult(item, action, error))
    }
  }

  for (const item of selectionItems) {
    const action = resolveDecision(item, decisionMap)
    const payload = getPreviewPayload<ModelSelectionPreviewPayload>(item)
    if (!payload) {
      results.push(createFailedResult(item, action, 'Model selection payload missing'))
      continue
    }
    if (action === 'skip') {
      results.push(createSkippedResult(item, action))
      continue
    }

    try {
      const providerId = providerIdBySourceKey.get(payload.sourceProviderKey)
      if (!providerId) {
        throw new Error(`Migrated Provider not found: ${payload.sourceProviderKey}`)
      }
      const provider = providers.find((entry) => entry.id === providerId)
      if (!provider) {
        throw new Error(`Provider does not exist: ${providerId}`)
      }
      const model = provider.models.find(
        (entry) => entry.id.trim().toLowerCase() === payload.sourceModelId.trim().toLowerCase()
      )
      if (!model) {
        throw new Error(`Model not found in Provider: ${payload.sourceModelId}`)
      }

      if (payload.route === 'main') {
        providerState.activeProviderId = provider.id
        providerState.activeModelId = model.id
      } else {
        providerState.activeFastProviderId = provider.id
        providerState.activeFastModelId = model.id
      }
      configChanged = true
      results.push(
        createSuccessResult(
          item,
          action,
          CONFIG_PATH,
          `${provider.name} / ${model.name} set as ${payload.route === 'main' ? 'main model' : 'quick model'}`
        )
      )
    } catch (error) {
      results.push(createFailedResult(item, action, error))
    }
  }

  for (const item of instructionItems) {
    const action = resolveDecision(item, decisionMap)
    const payload = getPreviewPayload<InstructionsPreviewPayload>(item)
    if (!payload) {
      results.push(createFailedResult(item, action, 'instructions payload missing'))
      continue
    }
    if (action === 'skip') {
      results.push(createSkippedResult(item, action))
      continue
    }

    try {
      const existingContent = fs.existsSync(MEMORY_PATH)
        ? fs.readFileSync(MEMORY_PATH, 'utf-8')
        : ''
      const nextContent = upsertManagedMemorySection(existingContent, payload.managedContent)
      ensureDirForFile(MEMORY_PATH)
      fs.writeFileSync(MEMORY_PATH, nextContent, 'utf-8')
      results.push(
        createSuccessResult(item, action, MEMORY_PATH, 'Updated MEMORY.md managed section')
      )
    } catch (error) {
      results.push(createFailedResult(item, action, error))
    }
  }

  if (configChanged) {
    providerState.providers = providers
    configRoot['opencowork-providers'] = {
      state: providerState,
      version: providerBucket.version
    }
    writeJsonFile(CONFIG_PATH, configRoot)
  }

  if (mcpChanged) {
    writeJsonFile(MCP_PATH, existingMcpServers)
  }

  const summary = {
    total: results.length,
    applied: results.filter((item) => item.status === 'success').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length
  }

  return {
    source: 'opencode',
    sourcePath: preview.sourcePath,
    backupPath,
    warnings,
    results,
    summary,
    appliedAt: Date.now()
  }
}
