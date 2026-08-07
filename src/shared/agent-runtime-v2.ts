export const AGENT_RUNTIME_PROTOCOL_VERSION = 2 as const
export const TOOL_MANIFEST_SCHEMA_VERSION = 2 as const

export type RuntimeRolloutMode = 'legacy' | 'shadow' | 'v2'

export type ToolSourceKind =
  | 'core'
  | 'skill'
  | 'subagent'
  | 'team'
  | 'mcp'
  | 'extension'
  | 'plugin'
  | 'browser'
  | 'desktop'
  | 'codegraph'
  | 'web'

export type ToolApprovalMode = 'never' | 'policy' | 'always'
export type ToolSideEffectClass =
  | 'none'
  | 'localMutation'
  | 'externalMutation'
  | 'uiControl'
  | 'arbitraryCode'
export type ToolParallelClass =
  | 'readParallel'
  | 'resourceSerial'
  | 'globalSerial'
  | 'interactive'
export type ToolRecoveryMode = 'replaySafe' | 'idempotencyKey' | 'reconcile' | 'manual'
export type CapabilityCallerType = 'root' | 'subagent' | 'team' | 'cron' | 'plugin' | 'system'

export interface ToolManifestV2 {
  schemaVersion: typeof TOOL_MANIFEST_SCHEMA_VERSION
  toolId: string
  wireName: string
  source: ToolSourceKind
  sourceInstanceId: string
  description: string
  inputSchema: Record<string, unknown>
  definitionHash: string
  executorRoute: string
  allowedModes: string[]
  allowedCallers: CapabilityCallerType[]
  parentOnly: boolean
  requiresRenderer: boolean
  approvalMode: ToolApprovalMode
  sideEffectClass: ToolSideEffectClass
  parallelClass: ToolParallelClass
  resourceKeyStrategy: string
  recoveryMode: ToolRecoveryMode
  resultPolicy: string
  alwaysVisible?: boolean
  sensitiveInputPaths?: string[]
  sensitiveResultPaths?: string[]
}

export interface CapabilitySourceBindingV2 {
  source: ToolSourceKind
  sourceInstanceId: string
  version: string
  connectionHash: string
}

export interface CapabilitySnapshotV2 {
  schemaVersion: 2
  snapshotId: string
  snapshotHash: string
  sessionId: string
  projectId: string | null
  mode: string
  callerType: CapabilityCallerType
  createdAt: number
  settingsRevision: string
  permissionPolicyHash: string
  agentCatalogHash: string
  manifestSchemaVersion: typeof TOOL_MANIFEST_SCHEMA_VERSION
  authorizedTools: ToolManifestV2[]
  providerVisibleTools: string[]
  sources: CapabilitySourceBindingV2[]
  parentSnapshotHash?: string
  resolutionReason?: string
}

export interface RuntimeInitializeResultV2 {
  ok: boolean
  runtime: string
  version: string
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION
  supportedManifestSchemaVersions: number[]
  coreManifestHash: string
  workerInstanceId: string
  features: {
    capabilitySnapshot: boolean
    strictToolValidation: boolean
    durableEvents: boolean
    durableInbox: boolean
    checkpointRecovery: boolean
    toolReconciliation: boolean
    laneScheduler: boolean
  }
  compatibility: {
    acceptsV1RunRequest: boolean
    canRecoverV2Run: boolean
    minimumRendererVersion: string
    minimumMainVersion: string
  }
}

export interface RuntimeToolDefinitionLike {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface CreateCapabilitySnapshotInputV2 {
  sessionId: string
  projectId?: string | null
  mode: string
  callerType?: CapabilityCallerType
  tools: readonly RuntimeToolDefinitionLike[]
  createdAt?: number
  settingsRevision?: string
  permissionPolicy?: unknown
  agentCatalog?: unknown
  parentSnapshotHash?: string
  resolutionReason?: string
}

const PARENT_ONLY_TOOLS = new Set([
  'AskUserQuestion',
  'CronAdd',
  'CronCreate',
  'CronDelete',
  'CronList',
  'CronRemove',
  'CronUpdate',
  'EnterPlanMode',
  'ExitPlanMode',
  'PluginReplyMessage',
  'PluginSendMessage',
  'SendMessage',
  'Task',
  'TeamCreate',
  'TeamDelete',
  'TeamStatus'
])

const REPLAY_SAFE_TOOLS = new Set([
  'Glob',
  'Grep',
  'LS',
  'MemoryList',
  'MemoryRead',
  'MemorySearch',
  'Read',
  'TaskGet',
  'TaskList',
  'TeamStatus',
  'WebFetch',
  'WebSearch',
  'codegraph_explore',
  'get_goal'
])

const LOCAL_MUTATION_TOOLS = new Set([
  'Edit',
  'NotebookEdit',
  'Write',
  'TaskCreate',
  'TaskUpdate',
  'create_goal',
  'update_goal'
])

const ARBITRARY_CODE_TOOLS = new Set(['Bash', 'PowerShell', 'Shell'])

function assertJsonValue(value: unknown, path: string): void {
  if (value === null) return
  if (typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) throw new TypeError(`Undefined JSON value at ${path}.${key}`)
      assertJsonValue(item, `${path}.${key}`)
    }
    return
  }
  throw new TypeError(`Unsupported JSON value at ${path}`)
}

/** RFC 8785/JCS canonical JSON for the JSON-compatible runtime contracts. */
export function canonicalizeJson(value: unknown): string {
  assertJsonValue(value, '$')

  const serialize = (item: unknown): string => {
    if (item === null) return 'null'
    if (typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number') {
      return JSON.stringify(item)
    }
    if (Array.isArray(item)) return `[${item.map(serialize).join(',')}]`

    const record = item as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`)
      .join(',')}}`
  }

  return serialize(value)
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count))
}

/** Synchronous SHA-256 so the shared snapshot builder works in Renderer and Main. */
export function sha256Hex(value: string): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19
  ]
  const bytes = new TextEncoder().encode(value)
  const bitLength = bytes.length * 8
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  const high = Math.floor(bitLength / 0x1_0000_0000)
  const low = bitLength >>> 0
  view.setUint32(paddedLength - 8, high)
  view.setUint32(paddedLength - 4, low)

  const words = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4)
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotateRight(words[index - 15], 7) ^
        rotateRight(words[index - 15], 18) ^
        (words[index - 15] >>> 3)
      const s1 =
        rotateRight(words[index - 2], 17) ^
        rotateRight(words[index - 2], 19) ^
        (words[index - 2] >>> 10)
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choose + constants[index] + words[index]) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    hash[0] = (hash[0] + a) >>> 0
    hash[1] = (hash[1] + b) >>> 0
    hash[2] = (hash[2] + c) >>> 0
    hash[3] = (hash[3] + d) >>> 0
    hash[4] = (hash[4] + e) >>> 0
    hash[5] = (hash[5] + f) >>> 0
    hash[6] = (hash[6] + g) >>> 0
    hash[7] = (hash[7] + h) >>> 0
  }

  return hash.map((item) => item.toString(16).padStart(8, '0')).join('')
}

export function hashCanonicalJson(value: unknown): string {
  return sha256Hex(canonicalizeJson(value))
}

function parseDynamicIdentity(wireName: string): {
  source: ToolSourceKind
  sourceInstanceId: string
} {
  if (wireName.startsWith('mcp__')) {
    return { source: 'mcp', sourceInstanceId: wireName.slice(5).split('__')[0] || 'unknown' }
  }
  if (wireName.startsWith('extension__')) {
    return {
      source: 'extension',
      sourceInstanceId: wireName.slice(11).split('__')[0] || 'unknown'
    }
  }
  if (wireName.startsWith('Browser')) return { source: 'browser', sourceInstanceId: 'default' }
  if (wireName.startsWith('Desktop')) return { source: 'desktop', sourceInstanceId: 'default' }
  if (wireName === 'codegraph_explore') {
    return { source: 'codegraph', sourceInstanceId: 'native' }
  }
  if (wireName === 'WebSearch' || wireName === 'WebFetch') {
    return { source: 'web', sourceInstanceId: 'configured' }
  }
  if (wireName === 'Task') return { source: 'subagent', sourceInstanceId: 'agent-catalog' }
  if (wireName.startsWith('Team') || wireName === 'SendMessage') {
    return { source: 'team', sourceInstanceId: 'team-runtime' }
  }
  if (wireName.startsWith('Plugin')) return { source: 'plugin', sourceInstanceId: 'channel' }
  if (wireName === 'Skill') return { source: 'skill', sourceInstanceId: 'skill-catalog' }
  return { source: 'core', sourceInstanceId: 'native' }
}

function normalizeToolSchemaV2(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeToolSchemaV2)
  if (!value || typeof value !== 'object') return value

  const source = value as Record<string, unknown>
  const normalized = Object.fromEntries(
    Object.entries(source).map(([key, item]) => [key, normalizeToolSchemaV2(item)])
  )
  const isObjectSchema = source.type === 'object' || !!source.properties
  const delegatesObjectShape = !!source.oneOf || !!source.anyOf || !!source.allOf
  if (
    isObjectSchema &&
    !delegatesObjectShape &&
    !Object.prototype.hasOwnProperty.call(source, 'additionalProperties')
  ) {
    normalized.additionalProperties = false
  }
  return normalized
}

function createManifestDraft(definition: RuntimeToolDefinitionLike): Omit<ToolManifestV2, 'definitionHash'> {
  const { source, sourceInstanceId } = parseDynamicIdentity(definition.name)
  const dynamic = source === 'mcp' || source === 'extension' || source === 'plugin'
  const browserOrDesktop = source === 'browser' || source === 'desktop'
  const replaySafe = REPLAY_SAFE_TOOLS.has(definition.name)
  const localMutation = LOCAL_MUTATION_TOOLS.has(definition.name)
  const arbitraryCode = ARBITRARY_CODE_TOOLS.has(definition.name)
  const parentOnly = dynamic || PARENT_ONLY_TOOLS.has(definition.name)

  let sideEffectClass: ToolSideEffectClass = 'none'
  if (dynamic) sideEffectClass = 'externalMutation'
  if (localMutation) sideEffectClass = 'localMutation'
  if (browserOrDesktop) sideEffectClass = 'uiControl'
  if (arbitraryCode) sideEffectClass = 'arbitraryCode'

  let parallelClass: ToolParallelClass = replaySafe ? 'readParallel' : 'resourceSerial'
  if (dynamic || browserOrDesktop || arbitraryCode) parallelClass = 'globalSerial'
  if (definition.name === 'AskUserQuestion') parallelClass = 'interactive'

  let recoveryMode: ToolRecoveryMode = replaySafe ? 'replaySafe' : 'manual'
  if (localMutation) recoveryMode = 'reconcile'

  return {
    schemaVersion: TOOL_MANIFEST_SCHEMA_VERSION,
    toolId: `${source}:${sourceInstanceId}:${definition.name}`,
    wireName: definition.name,
    source,
    sourceInstanceId,
    description: definition.description,
    inputSchema: normalizeToolSchemaV2(definition.inputSchema) as Record<string, unknown>,
    executorRoute: dynamic ? `${source}/execute` : `native/${definition.name}`,
    allowedModes: ['chat', 'cowork', 'code', 'clarify', 'acp', 'agent'],
    allowedCallers: parentOnly
      ? ['root', 'cron', 'plugin', 'system']
      : ['root', 'subagent', 'team', 'cron', 'plugin', 'system'],
    parentOnly,
    requiresRenderer: source === 'extension' || browserOrDesktop,
    approvalMode: dynamic || browserOrDesktop || arbitraryCode ? 'always' : 'policy',
    sideEffectClass,
    parallelClass,
    resourceKeyStrategy: replaySafe ? 'input-paths' : dynamic ? 'source-instance' : 'tool-default',
    recoveryMode,
    resultPolicy: 'bounded-preview-64k',
    alwaysVisible: source === 'core' && !parentOnly
  }
}

export function createToolManifestV2(definition: RuntimeToolDefinitionLike): ToolManifestV2 {
  const draft = createManifestDraft(definition)
  return { ...draft, definitionHash: hashCanonicalJson(draft) }
}

function stableManifestSort(a: ToolManifestV2, b: ToolManifestV2): number {
  return a.wireName.localeCompare(b.wireName) || a.toolId.localeCompare(b.toolId)
}

export function createCapabilitySnapshotV2(
  input: CreateCapabilitySnapshotInputV2
): CapabilitySnapshotV2 {
  const manifests = input.tools.map(createToolManifestV2).sort(stableManifestSort)
  const wireNames = new Set<string>()
  const toolIds = new Set<string>()
  for (const manifest of manifests) {
    if (wireNames.has(manifest.wireName)) {
      throw new Error(`Duplicate Tool wireName in capability snapshot: ${manifest.wireName}`)
    }
    if (toolIds.has(manifest.toolId)) {
      throw new Error(`Duplicate Tool identity in capability snapshot: ${manifest.toolId}`)
    }
    wireNames.add(manifest.wireName)
    toolIds.add(manifest.toolId)
  }

  const sources = Array.from(
    new Map(
      manifests.map((manifest) => {
        const key = `${manifest.source}:${manifest.sourceInstanceId}`
        const binding: CapabilitySourceBindingV2 = {
          source: manifest.source,
          sourceInstanceId: manifest.sourceInstanceId,
          version: manifest.definitionHash,
          connectionHash: hashCanonicalJson({
            source: manifest.source,
            sourceInstanceId: manifest.sourceInstanceId
          })
        }
        return [key, binding]
      })
    ).values()
  ).sort((a, b) =>
    `${a.source}:${a.sourceInstanceId}`.localeCompare(`${b.source}:${b.sourceInstanceId}`)
  )

  const payload = {
    schemaVersion: 2 as const,
    sessionId: input.sessionId,
    projectId: input.projectId ?? null,
    mode: input.mode,
    callerType: input.callerType ?? 'root',
    createdAt: input.createdAt ?? Date.now(),
    settingsRevision: input.settingsRevision ?? 'renderer-current',
    permissionPolicyHash: hashCanonicalJson(input.permissionPolicy ?? null),
    agentCatalogHash: hashCanonicalJson(input.agentCatalog ?? null),
    manifestSchemaVersion: TOOL_MANIFEST_SCHEMA_VERSION,
    authorizedTools: manifests,
    providerVisibleTools: manifests.map((manifest) => manifest.toolId),
    sources,
    ...(input.parentSnapshotHash ? { parentSnapshotHash: input.parentSnapshotHash } : {}),
    ...(input.resolutionReason ? { resolutionReason: input.resolutionReason } : {})
  }
  const snapshotHash = hashCanonicalJson(payload)
  return {
    ...payload,
    snapshotId: `cap_${snapshotHash.slice(0, 24)}`,
    snapshotHash
  }
}
