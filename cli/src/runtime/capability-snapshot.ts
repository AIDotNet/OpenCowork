import { createHash } from 'node:crypto'
import type { WorkerToolDefinition } from './worker-session.js'
import type { JsonRecord } from './provider-catalog.js'

type SideEffectClass = 'none' | 'localMutation' | 'arbitraryCode'
type ParallelClass = 'readParallel' | 'resourceSerial' | 'globalSerial' | 'interactive'
type RecoveryMode = 'replaySafe' | 'reconcile' | 'manual'

const REPLAY_SAFE_TOOLS = new Set(['Read', 'LS', 'Glob', 'Grep', 'TaskGet', 'TaskList'])
const LOCAL_MUTATION_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'TaskCreate', 'TaskUpdate'])
const ARBITRARY_CODE_TOOLS = new Set(['Bash', 'Shell'])

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as JsonRecord)) {
      if (item === undefined) throw new TypeError(`Undefined JSON value at ${path}.${key}`)
      assertJsonValue(item, `${path}.${key}`)
    }
    return
  }
  throw new TypeError(`Unsupported JSON value at ${path}`)
}

function canonicalizeJson(value: unknown): string {
  assertJsonValue(value, '$')
  const serialize = (item: unknown): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item)
    if (Array.isArray(item)) return `[${item.map(serialize).join(',')}]`
    const record = item as JsonRecord
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`)
      .join(',')}}`
  }
  return serialize(value)
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value)).digest('hex')
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema)
  if (!value || typeof value !== 'object') return value
  const source = value as JsonRecord
  const normalized = Object.fromEntries(
    Object.entries(source).map(([key, item]) => [key, normalizeSchema(item)])
  )
  const objectSchema = source.type === 'object' || Boolean(source.properties)
  const delegatesShape = Boolean(source.oneOf || source.anyOf || source.allOf)
  if (objectSchema && !delegatesShape && !('additionalProperties' in source)) {
    normalized.additionalProperties = false
  }
  return normalized
}

function createManifest(tool: WorkerToolDefinition): JsonRecord {
  const subAgent = tool.name === 'Task'
  const codeGraph = tool.name.startsWith('codegraph_')
  const interactive = tool.name === 'AskUserQuestion'
  const planTool = tool.name === 'EnterPlanMode' || tool.name === 'ExitPlanMode'
  const source = subAgent ? 'subagent' : codeGraph ? 'codegraph' : 'core'
  const sourceInstanceId = subAgent ? 'agent-catalog' : 'native'
  const replaySafe = REPLAY_SAFE_TOOLS.has(tool.name) || codeGraph
  const localMutation = LOCAL_MUTATION_TOOLS.has(tool.name)
  const arbitraryCode = ARBITRARY_CODE_TOOLS.has(tool.name)
  const sideEffectClass: SideEffectClass = arbitraryCode
    ? 'arbitraryCode'
    : localMutation
      ? 'localMutation'
      : 'none'
  const parallelClass: ParallelClass = interactive
    ? 'interactive'
    : arbitraryCode
      ? 'globalSerial'
      : replaySafe
        ? 'readParallel'
        : 'resourceSerial'
  const recoveryMode: RecoveryMode = replaySafe
    ? 'replaySafe'
    : localMutation
      ? 'reconcile'
      : 'manual'
  const draft: JsonRecord = {
    schemaVersion: 2,
    toolId: `${source}:${sourceInstanceId}:${tool.name}`,
    wireName: tool.name,
    source,
    sourceInstanceId,
    description: tool.description,
    inputSchema: normalizeSchema(tool.inputSchema),
    executorRoute: codeGraph
      ? `codegraph/${tool.name.slice('codegraph_'.length)}`
      : `native/${tool.name}`,
    allowedModes: ['chat', 'cowork', 'code', 'clarify', 'acp', 'agent'],
    allowedCallers:
      subAgent || interactive || planTool
        ? ['root', 'cron', 'plugin', 'system']
        : ['root', 'subagent', 'team', 'cron', 'plugin', 'system'],
    parentOnly: subAgent || interactive || planTool,
    requiresRenderer: false,
    approvalMode: arbitraryCode ? 'always' : 'policy',
    sideEffectClass,
    parallelClass,
    resourceKeyStrategy: replaySafe ? 'input-paths' : 'tool-default',
    recoveryMode,
    resultPolicy: 'bounded-preview-64k',
    alwaysVisible: !subAgent
  }
  return { ...draft, definitionHash: hash(draft) }
}

export function createCliCapabilitySnapshot(args: {
  permissionPolicy?: unknown
  sessionId: string
  tools: WorkerToolDefinition[]
}): JsonRecord {
  const authorizedTools = args.tools
    .map(createManifest)
    .sort((left, right) => String(left.wireName).localeCompare(String(right.wireName)))
  const providerVisibleTools = authorizedTools.map((tool) => tool.toolId)
  const sources = Array.from(
    new Map(
      authorizedTools.map((manifest) => {
        const source = String(manifest.source)
        const sourceInstanceId = String(manifest.sourceInstanceId)
        return [
          `${source}:${sourceInstanceId}`,
          {
            source,
            sourceInstanceId,
            version: String(manifest.definitionHash),
            connectionHash: hash({ source, sourceInstanceId })
          }
        ] as const
      })
    ).values()
  ).sort((left, right) =>
    `${left.source}:${left.sourceInstanceId}`.localeCompare(
      `${right.source}:${right.sourceInstanceId}`
    )
  )
  const payload: JsonRecord = {
    schemaVersion: 2,
    sessionId: args.sessionId,
    projectId: null,
    mode: 'code',
    callerType: 'root',
    createdAt: Date.now(),
    settingsRevision: 'cli-shared-provider-store',
    permissionPolicyHash: hash(args.permissionPolicy ?? null),
    agentCatalogHash: hash(null),
    manifestSchemaVersion: 2,
    authorizedTools,
    providerVisibleTools,
    sources,
    resolutionReason: 'OpenCowork CLI Native Worker session'
  }
  const snapshotHash = hash(payload)
  return {
    ...payload,
    snapshotId: `cap_${snapshotHash.slice(0, 24)}`,
    snapshotHash
  }
}
