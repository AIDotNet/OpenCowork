import { access, mkdir, readFile, realpath, stat, writeFile } from 'fs/promises'
import { constants } from 'fs'
import { homedir } from 'os'
import path from 'path'
import type {
  HookArtifactHashView,
  HookCommandHandlerConfig,
  HookDefinitionView,
  HookEventName,
  HookListView,
  HookSourceKind,
  HookSourceView,
  HooksConfigFile,
  HooksListArgs,
  HookTrustStatus
} from '../../shared/hooks/types'
import { HOOK_EVENT_NAMES, HOOK_TRUST_STATUS } from '../../shared/hooks/types'
import { getDataDir } from '../db/database'
import { listHookRuns, listHookTrusts, type HookTrustRow } from './hooks-db'
import {
  expandHome,
  hashStable,
  isPathInside,
  normalizeError,
  sha256,
  stableJson
} from './hooks-utils'

const DEFAULT_TIMEOUT_SECONDS = 600
const MAX_TIMEOUT_SECONDS = 3600
const MAX_MATCHER_LENGTH = 512
const MAX_COMMAND_LENGTH = 8192
const MAX_ENV_KEYS = 64
const MAX_CONFIG_BYTES = 512 * 1024
const MAX_GROUPS_PER_EVENT = 100

const EVENT_SET = new Set<HookEventName>(HOOK_EVENT_NAMES)
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const PLATFORM_SET = new Set(['darwin', 'win32', 'linux'])
const INTERPRETERS = new Set(['python', 'python3', 'node', 'bash', 'sh'])

export interface HookLoadContext {
  projectId?: string | null
  sessionId?: string | null
  projectRoot?: string | null
  sshConnectionId?: string | null
}

export interface ResolvedHookDefinition extends HookDefinitionView {
  source: ResolvedHookSource
  matcherRegex?: RegExp
  rawHandler: HookCommandHandlerConfig
  env: Record<string, string>
  storedTrustStatus?: Extract<HookTrustStatus, 'trusted' | 'denied' | 'pending'>
}

export interface ResolvedHookSource extends HookSourceView {
  defaultCwd: string
  realDefaultCwd: string
  projectRoot?: string
  projectRootRealPath?: string
  configText?: string
}

export interface LoadedHooks {
  sources: ResolvedHookSource[]
  hooks: ResolvedHookDefinition[]
}

export interface LoadHooksOptions {
  includeLastRuns?: boolean
}

export async function ensureUserHooksConfig(): Promise<string> {
  const configPath = getUserHooksPath()
  await mkdir(path.dirname(configPath), { recursive: true })
  try {
    await access(configPath, constants.F_OK)
  } catch {
    await writeFile(configPath, '{\n  "hooks": {}\n}\n', 'utf8')
  }
  return configPath
}

export function getUserHooksPath(): string {
  return path.join(getDataDir(), 'hooks.json')
}

export async function loadHooks(
  context: HookLoadContext = {},
  options: LoadHooksOptions = {}
): Promise<LoadedHooks> {
  const trusts = await listHookTrusts().catch((error) => {
    console.warn('[Hooks] failed to load trust store:', normalizeError(error))
    return [] as HookTrustRow[]
  })
  const latestTrustByIdentity = buildLatestTrustMap(trusts)
  const sources = await resolveSources(context)
  const hooks: ResolvedHookDefinition[] = []

  for (const source of sources) {
    hooks.push(...(await loadSourceHooks(source, context, latestTrustByIdentity)))
  }

  if (options.includeLastRuns !== false) {
    await attachLastRuns(hooks)
  }
  return { sources, hooks }
}

export async function loadHookListView(
  context: HooksListArgs = {},
  runtime: HookListView['runtime'] = { enabled: false }
): Promise<HookListView> {
  const loaded = await loadHooks(context)
  const hooks = loaded.hooks.map(
    ({
      source: _source,
      matcherRegex: _matcherRegex,
      rawHandler: _rawHandler,
      env: _env,
      storedTrustStatus: _storedTrustStatus,
      ...view
    }) => {
      return view
    }
  )
  return {
    runtime,
    sources: loaded.sources.map(
      ({
        defaultCwd: _defaultCwd,
        realDefaultCwd: _realDefaultCwd,
        configText: _configText,
        ...view
      }) => {
        return view
      }
    ),
    hooks,
    summary: {
      total: hooks.length,
      pending: hooks.filter((hook) => hook.trustStatus === HOOK_TRUST_STATUS.pending).length,
      trusted: hooks.filter((hook) => hook.trustStatus === HOOK_TRUST_STATUS.trusted).length,
      denied: hooks.filter((hook) => hook.trustStatus === HOOK_TRUST_STATUS.denied).length,
      disabled: hooks.filter((hook) => hook.trustStatus === HOOK_TRUST_STATUS.disabled).length,
      invalid: hooks.filter((hook) => hook.trustStatus === HOOK_TRUST_STATUS.invalid).length,
      changed: hooks.filter((hook) => hook.trustStatus === HOOK_TRUST_STATUS.changed).length
    }
  }
}

export async function findHookById(
  hookId: string,
  context: HookLoadContext = {}
): Promise<ResolvedHookDefinition | null> {
  const loaded = await loadHooks(context)
  return loaded.hooks.find((hook) => hook.id === hookId) ?? null
}

async function resolveSources(context: HookLoadContext): Promise<ResolvedHookSource[]> {
  const dataDir = getDataDir()
  await mkdir(dataDir, { recursive: true })
  const userPath = getUserHooksPath()
  const sources: ResolvedHookSource[] = [
    await createSource({
      kind: 'user',
      label: 'User configuration',
      configPath: userPath,
      defaultCwd: dataDir
    })
  ]

  if (!context.sshConnectionId && context.projectRoot?.trim()) {
    const projectRoot = path.resolve(expandHome(context.projectRoot.trim()))
    try {
      const projectRootRealPath = await realpath(projectRoot)
      const projectConfigPath = path.join(projectRootRealPath, '.open-cowork', 'hooks.json')
      sources.push(
        await createSource({
          kind: 'project',
          label: 'Project configuration',
          configPath: projectConfigPath,
          defaultCwd: projectRootRealPath,
          projectRoot: context.projectRoot,
          projectRootRealPath
        })
      )
    } catch (error) {
      sources.push({
        id: hashStable({ kind: 'project', path: projectRoot }),
        kind: 'project',
        label: 'Project configuration',
        path: path.join(projectRoot, '.open-cowork', 'hooks.json'),
        exists: false,
        totalHooks: 0,
        pendingHooks: 0,
        invalidHooks: 0,
        lastLoadedAt: Date.now(),
        error: `Project root is unavailable: ${normalizeError(error)}`,
        defaultCwd: projectRoot,
        realDefaultCwd: projectRoot,
        projectRoot: context.projectRoot ?? undefined
      })
    }
  }

  return sources
}

async function createSource(args: {
  kind: HookSourceKind
  label: string
  configPath: string
  defaultCwd: string
  projectRoot?: string | null
  projectRootRealPath?: string
}): Promise<ResolvedHookSource> {
  const loadedAt = Date.now()
  const resolvedPath = path.resolve(expandHome(args.configPath))
  const realDefaultCwd = await realpath(args.defaultCwd).catch(() => path.resolve(args.defaultCwd))

  try {
    const fileStat = await stat(resolvedPath)
    if (!fileStat.isFile()) {
      throw new Error('hooks.json is not a file')
    }
    if (fileStat.size > MAX_CONFIG_BYTES) {
      throw new Error(`hooks.json is larger than ${MAX_CONFIG_BYTES} bytes`)
    }
    const realConfigPath = await realpath(resolvedPath)
    if (args.kind === 'project' && args.projectRootRealPath) {
      const expectedDir = path.join(args.projectRootRealPath, '.open-cowork')
      if (!isPathInside(expectedDir, realConfigPath)) {
        throw new Error('project hooks.json resolves outside the project .open-cowork directory')
      }
    }
    const configText = await readFile(realConfigPath, 'utf8')
    return {
      id: hashStable({ kind: args.kind, realConfigPath, projectRoot: args.projectRootRealPath }),
      kind: args.kind,
      label: args.label,
      path: resolvedPath,
      realPath: realConfigPath,
      exists: true,
      totalHooks: 0,
      pendingHooks: 0,
      invalidHooks: 0,
      lastLoadedAt: loadedAt,
      configHash: sha256(configText),
      defaultCwd: args.defaultCwd,
      realDefaultCwd,
      projectRoot: args.projectRoot ?? undefined,
      projectRootRealPath: args.projectRootRealPath,
      configText
    }
  } catch (error) {
    const exists = await access(resolvedPath, constants.F_OK)
      .then(() => true)
      .catch(() => false)
    return {
      id: hashStable({
        kind: args.kind,
        path: resolvedPath,
        projectRoot: args.projectRootRealPath
      }),
      kind: args.kind,
      label: args.label,
      path: resolvedPath,
      exists,
      totalHooks: 0,
      pendingHooks: 0,
      invalidHooks: 0,
      lastLoadedAt: loadedAt,
      error: exists ? normalizeError(error) : undefined,
      defaultCwd: args.defaultCwd,
      realDefaultCwd,
      projectRoot: args.projectRoot ?? undefined,
      projectRootRealPath: args.projectRootRealPath
    }
  }
}

async function loadSourceHooks(
  source: ResolvedHookSource,
  context: HookLoadContext,
  latestTrustByIdentity: Map<string, HookTrustRow>
): Promise<ResolvedHookDefinition[]> {
  if (!source.exists || !source.configText) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(source.configText)
  } catch (error) {
    source.error = `Invalid JSON: ${normalizeError(error)}`
    return []
  }

  if (!isRecord(parsed)) {
    source.error = 'hooks.json root must be an object'
    return []
  }
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) {
    source.error = 'Unsupported hooks schemaVersion'
    return []
  }
  if (!isRecord(parsed.hooks)) {
    source.error = 'hooks.json must contain a hooks object'
    return []
  }

  const config = parsed as unknown as HooksConfigFile
  const hooks: ResolvedHookDefinition[] = []
  for (const [eventName, groups] of Object.entries(config.hooks)) {
    if (!EVENT_SET.has(eventName as HookEventName)) continue
    if (!Array.isArray(groups)) {
      source.error = `hooks.${eventName} must be an array`
      continue
    }
    for (const [groupIndex, group] of groups.slice(0, MAX_GROUPS_PER_EVENT).entries()) {
      hooks.push(
        ...(await resolveGroupHooks({
          source,
          context,
          latestTrustByIdentity,
          eventName: eventName as HookEventName,
          group,
          groupIndex
        }))
      )
    }
  }

  source.totalHooks = hooks.length
  source.pendingHooks = hooks.filter(
    (hook) =>
      hook.trustStatus === HOOK_TRUST_STATUS.pending ||
      hook.trustStatus === HOOK_TRUST_STATUS.changed
  ).length
  source.invalidHooks = hooks.filter(
    (hook) => hook.trustStatus === HOOK_TRUST_STATUS.invalid
  ).length
  return hooks
}

async function resolveGroupHooks(args: {
  source: ResolvedHookSource
  context: HookLoadContext
  latestTrustByIdentity: Map<string, HookTrustRow>
  eventName: HookEventName
  group: unknown
  groupIndex: number
}): Promise<ResolvedHookDefinition[]> {
  const { source, context, latestTrustByIdentity, eventName, group, groupIndex } = args
  if (!isRecord(group)) return []
  const rawMatcher = typeof group.matcher === 'string' ? group.matcher : '*'
  const normalizedMatcher = normalizeMatcher(rawMatcher)
  const validationErrors: string[] = []
  let matcherRegex: RegExp | undefined
  if (normalizedMatcher !== '*') {
    if (normalizedMatcher.length > MAX_MATCHER_LENGTH) {
      validationErrors.push(`matcher must be at most ${MAX_MATCHER_LENGTH} characters`)
    } else {
      try {
        matcherRegex = new RegExp(normalizedMatcher)
      } catch (error) {
        validationErrors.push(`invalid matcher RegExp: ${normalizeError(error)}`)
      }
    }
  }
  if (!Array.isArray(group.hooks)) return []

  const hooks: ResolvedHookDefinition[] = []
  for (const [hookIndex, handler] of group.hooks.entries()) {
    hooks.push(
      await resolveHandler({
        source,
        context,
        latestTrustByIdentity,
        eventName,
        matcher: normalizedMatcher,
        matcherRegex,
        groupIndex,
        hookIndex,
        handler,
        inheritedErrors: validationErrors
      })
    )
  }
  return hooks
}

async function resolveHandler(args: {
  source: ResolvedHookSource
  context: HookLoadContext
  latestTrustByIdentity: Map<string, HookTrustRow>
  eventName: HookEventName
  matcher: string
  matcherRegex?: RegExp
  groupIndex: number
  hookIndex: number
  handler: unknown
  inheritedErrors: string[]
}): Promise<ResolvedHookDefinition> {
  const {
    source,
    context,
    latestTrustByIdentity,
    eventName,
    matcher,
    matcherRegex,
    groupIndex,
    hookIndex,
    handler,
    inheritedErrors
  } = args
  const validationErrors = [...inheritedErrors]
  const rawHandler = normalizeHandler(handler, validationErrors)
  const env = rawHandler.env ?? {}
  const resolvedCommand =
    process.platform === 'win32' && rawHandler.commandWindows
      ? rawHandler.commandWindows
      : rawHandler.command
  const resolvedCwd = await resolveCwd(source, rawHandler.cwd, validationErrors)
  const timeoutSeconds = clampTimeout(rawHandler.timeout, validationErrors)
  const configDisabled =
    rawHandler.disabled === true || !isCurrentPlatformEnabled(rawHandler.platforms)
  const artifactHashes = await resolveArtifactHashes(resolvedCommand, resolvedCwd)
  const envFingerprint = hashStable(env)
  const identityKey = hashStable({
    sourceKind: source.kind,
    sourceRealPath: source.realPath ?? source.path,
    projectRootRealPath: source.projectRootRealPath ?? null,
    eventName,
    matcher,
    handlerType: 'command',
    groupIndex,
    hookIndex
  })
  const definitionHash = hashStable({
    schemaVersion: 1,
    eventName,
    matcher,
    handler: {
      type: 'command',
      command: rawHandler.command,
      commandWindows: rawHandler.commandWindows,
      timeout: timeoutSeconds,
      statusMessage: rawHandler.statusMessage,
      cwd: rawHandler.cwd,
      env,
      disabled: rawHandler.disabled === true,
      platforms: rawHandler.platforms ?? []
    }
  })
  const trustKey = hashStable({
    sourceKind: source.kind,
    sourceRealPath: source.realPath ?? source.path,
    projectRootRealPath: source.projectRootRealPath ?? null,
    identityKey,
    eventName,
    matcher,
    handlerType: 'command',
    command: resolvedCommand,
    resolvedCwd,
    envFingerprint,
    definitionHash,
    artifactHashes
  })
  const latestTrust = latestTrustByIdentity.get(identityKey)
  const localDisabled = latestTrust?.localDisabled === true
  const trustStatus = resolveTrustStatus({
    configDisabled,
    validationErrors,
    latestTrust,
    trustKey,
    localDisabled
  })
  const storedTrustStatus =
    latestTrust?.trustKey === trustKey &&
    (latestTrust.status === HOOK_TRUST_STATUS.trusted ||
      latestTrust.status === HOOK_TRUST_STATUS.denied)
      ? latestTrust.status
      : HOOK_TRUST_STATUS.pending

  return {
    id: identityKey,
    source,
    sourceId: source.id,
    sourceKind: source.kind,
    sourcePath: source.path,
    sourceRealPath: source.realPath,
    projectId: context.projectId ?? undefined,
    projectRoot: source.projectRoot,
    eventName,
    eventLabel: eventName,
    matcher,
    matcherRegex,
    handlerType: 'command',
    command: rawHandler.command,
    resolvedCommand,
    resolvedCwd,
    timeoutSeconds,
    statusMessage: rawHandler.statusMessage,
    definitionHash,
    identityKey,
    trustKey,
    sourceConfigHash: source.configHash ?? '',
    artifactHashes,
    trustStatus,
    storedTrustStatus,
    validationErrors,
    configDisabled,
    localDisabled,
    envKeys: Object.keys(env).sort(),
    groupIndex,
    hookIndex,
    rawHandler,
    env
  }
}

function normalizeHandler(handler: unknown, validationErrors: string[]): HookCommandHandlerConfig {
  if (!isRecord(handler)) {
    validationErrors.push('hook handler must be an object')
    return { type: 'command', command: '' }
  }
  if (handler.type !== 'command') validationErrors.push('hook type must be command')
  const command = typeof handler.command === 'string' ? handler.command.trim() : ''
  if (!command) validationErrors.push('command is required')
  if (command.length > MAX_COMMAND_LENGTH) {
    validationErrors.push(`command must be at most ${MAX_COMMAND_LENGTH} characters`)
  }
  const commandWindows =
    typeof handler.commandWindows === 'string' ? handler.commandWindows.trim() : undefined
  const statusMessage =
    typeof handler.statusMessage === 'string' ? handler.statusMessage : undefined
  const cwd = typeof handler.cwd === 'string' ? handler.cwd.trim() : undefined
  const env = normalizeEnv(handler.env, validationErrors)
  const platforms = normalizePlatforms(handler.platforms, validationErrors)
  return {
    type: 'command',
    command,
    ...(commandWindows ? { commandWindows } : {}),
    ...(typeof handler.timeout === 'number' ? { timeout: handler.timeout } : {}),
    ...(statusMessage ? { statusMessage } : {}),
    ...(cwd ? { cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(handler.disabled === true ? { disabled: true } : {}),
    ...(platforms.length > 0 ? { platforms } : {})
  }
}

function normalizeEnv(value: unknown, validationErrors: string[]): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    validationErrors.push('env must be an object')
    return {}
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_ENV_KEYS) {
    validationErrors.push(`env can contain at most ${MAX_ENV_KEYS} keys`)
  }
  const env: Record<string, string> = {}
  for (const [key, item] of entries.slice(0, MAX_ENV_KEYS)) {
    if (!ENV_KEY_RE.test(key)) {
      validationErrors.push(`invalid env key: ${key}`)
      continue
    }
    if (typeof item !== 'string') {
      validationErrors.push(`env.${key} must be a string`)
      continue
    }
    env[key] = item
  }
  return env
}

function normalizePlatforms(
  value: unknown,
  validationErrors: string[]
): Array<'darwin' | 'win32' | 'linux'> {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    validationErrors.push('platforms must be an array')
    return []
  }
  const platforms: Array<'darwin' | 'win32' | 'linux'> = []
  for (const item of value) {
    if (typeof item !== 'string' || !PLATFORM_SET.has(item)) {
      validationErrors.push(`invalid platform: ${String(item)}`)
      continue
    }
    platforms.push(item as 'darwin' | 'win32' | 'linux')
  }
  return platforms
}

async function resolveCwd(
  source: ResolvedHookSource,
  configuredCwd: string | undefined,
  validationErrors: string[]
): Promise<string> {
  if (!configuredCwd) return source.realDefaultCwd
  const expanded = expandHome(configuredCwd)
  const candidate = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(source.realDefaultCwd, expanded)
  const realCwd = await realpath(candidate).catch(() => {
    validationErrors.push(`cwd does not exist: ${configuredCwd}`)
    return candidate
  })
  if (source.kind === 'user' && !path.isAbsolute(expanded) && !configuredCwd.startsWith('~')) {
    validationErrors.push('user hook cwd must be absolute or start with ~')
  }
  if (
    source.kind === 'project' &&
    source.projectRootRealPath &&
    !isPathInside(source.projectRootRealPath, realCwd)
  ) {
    validationErrors.push('project hook cwd must stay inside project root')
  }
  return realCwd
}

async function resolveArtifactHashes(
  command: string,
  cwd: string
): Promise<HookArtifactHashView[]> {
  const scriptPath = extractScriptPath(command)
  if (!scriptPath) return [{ path: 'untracked', hash: 'untracked', status: 'untracked' }]
  const resolvedPath = path.isAbsolute(expandHome(scriptPath))
    ? path.resolve(expandHome(scriptPath))
    : path.resolve(cwd, scriptPath)
  try {
    const realScriptPath = await realpath(resolvedPath)
    const content = await readFile(realScriptPath)
    return [{ path: realScriptPath, hash: sha256(content), status: 'ok' }]
  } catch {
    return [{ path: resolvedPath, hash: 'unreadable', status: 'unreadable' }]
  }
}

function extractScriptPath(command: string): string | null {
  const tokens = splitCommand(command)
  if (tokens.length < 2) return null
  const executable = path.basename(tokens[0])
  if (!INTERPRETERS.has(executable)) return null
  for (const token of tokens.slice(1)) {
    if (!token || token.startsWith('-')) continue
    return token
  }
  return null
}

function splitCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: 'single' | 'double' | null = null
  let escaped = false
  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single'
      continue
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double'
      continue
    }
    if (/\s/.test(char) && !quote) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

function normalizeMatcher(matcher: string): string {
  const trimmed = matcher.trim()
  return !trimmed || trimmed === '*' ? '*' : trimmed
}

function clampTimeout(value: unknown, validationErrors: string[]): number {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    validationErrors.push('timeout must be a positive number')
    return DEFAULT_TIMEOUT_SECONDS
  }
  if (value > MAX_TIMEOUT_SECONDS) {
    validationErrors.push(`timeout must be at most ${MAX_TIMEOUT_SECONDS} seconds`)
    return MAX_TIMEOUT_SECONDS
  }
  return Math.floor(value)
}

function isCurrentPlatformEnabled(platforms: HookCommandHandlerConfig['platforms']): boolean {
  return (
    !platforms ||
    platforms.length === 0 ||
    platforms.includes(process.platform as 'darwin' | 'win32' | 'linux')
  )
}

function resolveTrustStatus(args: {
  configDisabled: boolean
  validationErrors: string[]
  latestTrust?: HookTrustRow
  trustKey: string
  localDisabled: boolean
}): HookTrustStatus {
  if (args.validationErrors.length > 0) return HOOK_TRUST_STATUS.invalid
  if (args.configDisabled || args.localDisabled) return HOOK_TRUST_STATUS.disabled
  const latest = args.latestTrust
  if (!latest) return HOOK_TRUST_STATUS.pending
  if (latest.trustKey === args.trustKey) {
    if (latest.status === HOOK_TRUST_STATUS.trusted || latest.status === HOOK_TRUST_STATUS.denied) {
      return latest.status
    }
    return HOOK_TRUST_STATUS.pending
  }
  if (latest.status === HOOK_TRUST_STATUS.trusted || latest.status === HOOK_TRUST_STATUS.denied) {
    return HOOK_TRUST_STATUS.changed
  }
  return HOOK_TRUST_STATUS.pending
}

function buildLatestTrustMap(rows: HookTrustRow[]): Map<string, HookTrustRow> {
  const map = new Map<string, HookTrustRow>()
  for (const row of rows) {
    const existing = map.get(row.identityKey)
    if (!existing || existing.updatedAt < row.updatedAt) {
      map.set(row.identityKey, row)
    }
  }
  return map
}

async function attachLastRuns(hooks: ResolvedHookDefinition[]): Promise<void> {
  await Promise.all(
    hooks.map(async (hook) => {
      try {
        const [run] = await listHookRuns(hook.trustKey, 1)
        if (!run) return
        hook.lastRun = {
          id: run.id,
          trustKey: run.trustKey,
          ...(run.runId ? { runId: run.runId } : {}),
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          eventName: run.eventName,
          startedAt: run.startedAt,
          ...(run.completedAt ? { completedAt: run.completedAt } : {}),
          ...(run.durationMs ? { durationMs: run.durationMs } : {}),
          status: run.status,
          ...(run.exitCode !== undefined && run.exitCode !== null
            ? { exitCode: run.exitCode }
            : {}),
          ...(run.skippedReason ? { skippedReason: run.skippedReason } : {}),
          ...(run.stdoutPreview ? { stdoutPreview: run.stdoutPreview } : {}),
          ...(run.stderrPreview ? { stderrPreview: run.stderrPreview } : {}),
          ...(run.decisionJson ? { decision: safeJsonParse(run.decisionJson) } : {}),
          ...(run.error ? { error: run.error } : {})
        }
      } catch {
        // Run history is best-effort for settings UI.
      }
    })
  )
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function toTrustRow(
  hook: ResolvedHookDefinition,
  status: Extract<HookTrustStatus, 'trusted' | 'denied' | 'pending'>,
  localDisabled: boolean,
  reviewedAt?: number
): HookTrustRow {
  const now = Date.now()
  return {
    id: hook.trustKey,
    identityKey: hook.identityKey,
    trustKey: hook.trustKey,
    sourceKind: hook.sourceKind,
    sourcePath: hook.sourcePath,
    sourceRealPath: hook.sourceRealPath ?? hook.sourcePath,
    sourceConfigHash: hook.sourceConfigHash,
    projectId: hook.projectId ?? null,
    projectRoot: hook.projectRoot ?? null,
    projectRootRealPath: hook.source.projectRootRealPath ?? null,
    eventName: hook.eventName,
    matcher: hook.matcher,
    handlerType: 'command',
    command: hook.resolvedCommand,
    resolvedCwd: hook.resolvedCwd,
    envFingerprint: hashStable(hook.env),
    definitionHash: hook.definitionHash,
    artifactHashesJson: JSON.stringify(hook.artifactHashes),
    status,
    localDisabled,
    snapshotJson: stableJson({
      eventName: hook.eventName,
      matcher: hook.matcher,
      command: hook.resolvedCommand,
      resolvedCwd: hook.resolvedCwd,
      timeoutSeconds: hook.timeoutSeconds,
      envKeys: hook.envKeys,
      artifactHashes: hook.artifactHashes
    }),
    lastReviewedAt: reviewedAt ?? null,
    createdAt: now,
    updatedAt: now
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function getHomeDirectory(): string {
  return homedir()
}
