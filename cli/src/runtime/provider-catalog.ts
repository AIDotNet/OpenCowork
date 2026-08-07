import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AgentOption,
  ModelCatalog,
  ModelGroup,
  ModelOption,
  ModelSelection
} from '../types.js'

export type JsonRecord = Record<string, unknown>

export interface ProviderStoreState extends JsonRecord {
  providers?: unknown
  activeProviderId?: unknown
  activeModelId?: unknown
}

export interface OpenCoworkConfiguration {
  dataDirectory: string
  providerStore: ProviderStoreState
  settings: JsonRecord
}

export interface ProviderModelResolution {
  model: JsonRecord
  provider: JsonRecord
  selection: ModelSelection
}

const PROVIDER_DIRECTORY_NAME = 'ai-provider'
const PROVIDER_INDEX_FILE_NAME = 'index.json'
const PROVIDER_FILE_PREFIX = 'provider-'
const PROVIDER_FILE_SUFFIX = '.json'
const PROVIDER_STORE_FORMAT_VERSION = 1

interface RequestedSelection {
  modelId?: string
  providerId?: string
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readJson(path: string): unknown {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null
  } catch {
    return null
  }
}

function writeJsonAtomically(path: string, value: unknown): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${randomUUID()}.tmp`

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(temporaryPath, path)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function decodePersistedState(value: unknown): JsonRecord {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return {}
    }
  }
  if (!isRecord(parsed)) return {}
  return isRecord(parsed.state) ? parsed.state : parsed
}

function readSettings(dataDirectory: string): JsonRecord {
  const root = readJson(join(dataDirectory, 'settings.json'))
  if (!isRecord(root)) return {}
  return decodePersistedState(root['opencowork-settings'])
}

function readProviderStore(dataDirectory: string): ProviderStoreState {
  const providerDirectory = join(dataDirectory, 'ai-provider')
  const index = readJson(join(providerDirectory, 'index.json'))
  if (isRecord(index)) {
    const state = isRecord(index.state) ? { ...index.state } : {}
    const ids = Array.isArray(index.providerIds)
      ? index.providerIds.filter((item): item is string => typeof item === 'string')
      : []
    const providers = ids
      .map((id) => readJson(join(providerDirectory, `provider-${encodeURIComponent(id)}.json`)))
      .filter(isRecord)
    return { ...state, providers }
  }

  if (existsSync(providerDirectory)) {
    const providers = readdirSync(providerDirectory)
      .filter((name) => name.startsWith('provider-') && name.endsWith('.json'))
      .map((name) => readJson(join(providerDirectory, name)))
      .filter(isRecord)
    if (providers.length > 0) return { providers }
  }

  for (const legacyName of ['config.json', 'settings.json']) {
    const root = readJson(join(dataDirectory, legacyName))
    if (!isRecord(root)) continue
    const legacy = decodePersistedState(root['opencowork-providers'])
    if (Array.isArray(legacy.providers)) return legacy
  }
  return { providers: [] }
}

export function loadOpenCoworkConfiguration(): OpenCoworkConfiguration {
  const dataDirectory = process.env.OPEN_COWORK_DATA_DIR?.trim() || join(homedir(), '.open-cowork')
  return {
    dataDirectory,
    providerStore: readProviderStore(dataDirectory),
    settings: readSettings(dataDirectory)
  }
}

function frontmatterValue(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'mu'))
  const value = match?.[1]?.trim() ?? ''
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1).trim()
  }
  return value
}

export function loadAgentCatalog(): AgentOption[] {
  const { dataDirectory } = loadOpenCoworkConfiguration()
  const agents: AgentOption[] = [
    {
      description: 'General-purpose Native Worker sub-agent with the parent tools except Task.',
      name: 'custom',
      source: 'native'
    }
  ]
  const directory = join(dataDirectory, 'agents')
  if (!existsSync(directory)) return agents

  for (const filename of readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .sort()) {
    try {
      const content = readFileSync(join(directory, filename), 'utf8')
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)
      if (!match) continue
      const name = frontmatterValue(match[1], 'name')
      const description = frontmatterValue(match[1], 'description')
      if (!name || !description) continue
      const maxTurnsValue = Number(
        frontmatterValue(match[1], 'maxTurns') || frontmatterValue(match[1], 'maxIterations')
      )
      const model = frontmatterValue(match[1], 'model')
      agents.push({
        description,
        name,
        source: 'user',
        ...(Number.isFinite(maxTurnsValue) && maxTurnsValue > 0 ? { maxTurns: maxTurnsValue } : {}),
        ...(model ? { model } : {})
      })
    } catch {
      // The Native Worker independently validates agent files. A malformed optional file should
      // not stop the terminal from opening the remaining catalog.
    }
  }
  return agents
}

function normalizeAuthMode(provider: JsonRecord): ModelOption['authMode'] {
  return provider.authMode === 'oauth' || provider.authMode === 'channel'
    ? provider.authMode
    : 'apiKey'
}

export function resolveProviderOAuth(provider: JsonRecord): JsonRecord {
  if (isRecord(provider.oauth)) return provider.oauth
  const accounts = Array.isArray(provider.oauthAccounts)
    ? provider.oauthAccounts.filter(isRecord)
    : []
  const activeAccountId = stringValue(provider.activeAccountId)
  const account =
    accounts.find((candidate) => stringValue(candidate.id) === activeAccountId) ?? accounts[0]
  return account && isRecord(account.oauth) ? account.oauth : {}
}

function providerAuthReady(provider: JsonRecord): boolean {
  const mode = normalizeAuthMode(provider)
  if (mode === 'oauth') return Boolean(stringValue(resolveProviderOAuth(provider).accessToken))
  if (mode === 'channel') {
    return isRecord(provider.channel) && Boolean(stringValue(provider.channel.accessToken))
  }
  return provider.requiresApiKey === false || Boolean(stringValue(provider.apiKey))
}

function availableProviders(providerStore: ProviderStoreState): JsonRecord[] {
  return (
    Array.isArray(providerStore.providers) ? providerStore.providers.filter(isRecord) : []
  ).filter((provider) => provider.enabled === true && providerAuthReady(provider))
}

function availableModels(provider: JsonRecord): JsonRecord[] {
  return (Array.isArray(provider.models) ? provider.models.filter(isRecord) : []).filter(
    (model) => model.enabled === true && (stringValue(model.category) || 'chat') === 'chat'
  )
}

function formatContextLength(value: unknown): string | null {
  const length = Number(value)
  if (!Number.isFinite(length) || length <= 0) return null
  if (length >= 1_000_000) return `${Number((length / 1_000_000).toFixed(1))}M context`
  if (length >= 1_000) return `${Math.round(length / 1_000)}K context`
  return `${Math.round(length)} context`
}

function describeModel(model: JsonRecord): string {
  const capabilities = [
    formatContextLength(model.contextLength),
    model.supportsThinking === true || isRecord(model.thinkingConfig) ? 'reasoning' : null,
    model.supportsVision === true ? 'vision' : null,
    model.supportsFunctionCall === true ? 'tools' : null
  ].filter((item): item is string => Boolean(item))
  return capabilities.length > 0 ? capabilities.join(' · ') : stringValue(model.id)
}

function toModelGroup(provider: JsonRecord): ModelGroup | null {
  const providerId = stringValue(provider.id)
  if (!providerId) return null
  const providerName = stringValue(provider.name) || providerId
  const providerType = stringValue(provider.type) || 'unknown'
  const providerBuiltinId = stringValue(provider.builtinId) || undefined
  const authMode = normalizeAuthMode(provider)
  const models = availableModels(provider).map<ModelOption>((model) => {
    const modelId = stringValue(model.id)
    return {
      providerId,
      providerName,
      providerType,
      ...(providerBuiltinId ? { providerBuiltinId } : {}),
      authMode,
      modelId,
      modelName: stringValue(model.name) || modelId,
      description: describeModel(model)
    }
  })
  if (models.length === 0) return null
  return {
    providerId,
    providerName,
    providerType,
    ...(providerBuiltinId ? { providerBuiltinId } : {}),
    authMode,
    models
  }
}

function selectOption(
  groups: ModelGroup[],
  providerStore: ProviderStoreState,
  requested: RequestedSelection
): ModelOption | null {
  const requestedProviderId = requested.providerId?.trim()
  const requestedModelId = requested.modelId?.trim()
  const activeProviderId = stringValue(providerStore.activeProviderId)
  const activeModelId = stringValue(providerStore.activeModelId)

  let group = requestedProviderId
    ? groups.find((candidate) => candidate.providerId === requestedProviderId)
    : undefined

  if (!group && requestedModelId) {
    const activeGroup = groups.find((candidate) => candidate.providerId === activeProviderId)
    group = activeGroup?.models.some((model) => model.modelId === requestedModelId)
      ? activeGroup
      : groups.find((candidate) =>
          candidate.models.some((model) => model.modelId === requestedModelId)
        )
  }

  group ??= groups.find((candidate) => candidate.providerId === activeProviderId) ?? groups[0]
  if (!group) return null

  const requestedOption = requestedModelId
    ? group.models.find((model) => model.modelId === requestedModelId)
    : undefined
  const activeOption =
    group.providerId === activeProviderId
      ? group.models.find((model) => model.modelId === activeModelId)
      : undefined
  const rawProvider = availableProviders(providerStore).find(
    (provider) => stringValue(provider.id) === group?.providerId
  )
  const defaultModelId = rawProvider ? stringValue(rawProvider.defaultModel) : ''
  return (
    requestedOption ??
    activeOption ??
    group.models.find((model) => model.modelId === defaultModelId) ??
    group.models[0] ??
    null
  )
}

function toSelection(option: ModelOption): ModelSelection {
  return {
    providerId: option.providerId,
    providerName: option.providerName,
    modelId: option.modelId,
    modelName: option.modelName
  }
}

export function loadModelCatalog(requested: RequestedSelection = {}): ModelCatalog {
  const configuration = loadOpenCoworkConfiguration()
  const groups = availableProviders(configuration.providerStore)
    .map(toModelGroup)
    .filter((group): group is ModelGroup => Boolean(group))
  const option = selectOption(groups, configuration.providerStore, requested)
  return {
    groups,
    active: option ? toSelection(option) : null,
    totalModels: groups.reduce((total, group) => total + group.models.length, 0)
  }
}

/**
 * Persist the active chat provider/model selected by the CLI.
 *
 * The desktop app stores provider metadata in the split provider store. Updating only the
 * in-memory CLI runtime makes `/model` appear to work until the process exits, so this writes the
 * shared index atomically while leaving provider credentials and model definitions untouched.
 */
export function persistModelSelection(selection: {
  providerId: string
  modelId: string
}): ModelSelection {
  const configuration = loadOpenCoworkConfiguration()
  const resolved = resolveProviderModel(configuration, selection)
  if (!resolved) {
    throw new Error('The selected provider/model is no longer available.')
  }

  const providerDirectory = join(configuration.dataDirectory, PROVIDER_DIRECTORY_NAME)
  const indexPath = join(providerDirectory, PROVIDER_INDEX_FILE_NAME)
  const rawIndex = readJson(indexPath)
  const persistedIndex = isRecord(rawIndex) ? rawIndex : null
  const rawIndexState = persistedIndex?.state
  const indexState = isRecord(rawIndexState) ? rawIndexState : null
  const { providers: configuredProviders, ...configuredMetadata } = configuration.providerStore
  const providers = Array.isArray(configuredProviders) ? configuredProviders.filter(isRecord) : []
  const metadata = { ...(indexState ?? configuredMetadata) }

  const providerIds = Array.isArray(persistedIndex?.providerIds)
    ? persistedIndex.providerIds.filter(
        (providerId): providerId is string =>
          typeof providerId === 'string' && providerId.trim() !== ''
      )
    : providers
        .map((provider) => stringValue(provider.id).trim())
        .filter((providerId): providerId is string => providerId.length > 0)

  // A legacy config.json or provider-directory-without-index store can still be read by the
  // catalog. Materialize its provider files before publishing the new index so the desktop app
  // never sees an index that points at missing provider definitions.
  if (!persistedIndex) {
    for (const provider of providers) {
      const providerId = stringValue(provider.id).trim()
      if (!providerId) continue
      writeJsonAtomically(
        join(
          providerDirectory,
          `${PROVIDER_FILE_PREFIX}${encodeURIComponent(providerId)}${PROVIDER_FILE_SUFFIX}`
        ),
        provider
      )
    }
  }

  writeJsonAtomically(indexPath, {
    formatVersion:
      typeof persistedIndex?.formatVersion === 'number'
        ? persistedIndex.formatVersion
        : PROVIDER_STORE_FORMAT_VERSION,
    providerIds: Array.from(new Set(providerIds)),
    state: {
      ...metadata,
      activeProviderId: resolved.selection.providerId,
      activeModelId: resolved.selection.modelId
    },
    version: typeof persistedIndex?.version === 'number' ? persistedIndex.version : 0
  })

  return resolved.selection
}

export function resolveProviderModel(
  configuration: OpenCoworkConfiguration,
  requested: RequestedSelection
): ProviderModelResolution | null {
  const providers = availableProviders(configuration.providerStore)
  const groups = providers.map(toModelGroup).filter((group): group is ModelGroup => Boolean(group))
  const requestedProviderId = requested.providerId?.trim()
  const requestedModelId = requested.modelId?.trim()

  if (requestedProviderId && !groups.some((group) => group.providerId === requestedProviderId)) {
    throw new Error(
      `The selected OpenCowork provider “${requestedProviderId}” is disabled, unauthenticated, or missing.`
    )
  }

  const option = selectOption(groups, configuration.providerStore, requested)
  if (!option) return null
  if (requestedModelId && option.modelId !== requestedModelId) {
    throw new Error(
      `The selected model “${requestedModelId}” is not enabled for provider “${option.providerName}”.`
    )
  }

  const provider = providers.find((candidate) => stringValue(candidate.id) === option.providerId)
  const model = provider
    ? availableModels(provider).find((candidate) => stringValue(candidate.id) === option.modelId)
    : undefined
  if (!provider || !model) return null
  return { provider, model, selection: toSelection(option) }
}
