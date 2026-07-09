import { shell } from 'electron'
import { readPersistedSettingsState } from '../ipc/settings-handlers'
import type {
  HookListView,
  HookRunRequest,
  HookRunResult,
  HookRunSummary,
  HooksListArgs,
  HooksOpenSourceArgs,
  HooksRunHistoryArgs,
  HooksSetDisabledArgs,
  HooksSetTrustArgs
} from '../../shared/hooks/types'
import { HOOK_TRUST_STATUS } from '../../shared/hooks/types'
import * as projectsDao from '../db/projects-dao'
import * as sessionsDao from '../db/sessions-dao'
import { cleanupHookRuns, listHookRuns, upsertHookTrust } from './hooks-db'
import {
  ensureUserHooksConfig,
  findHookById,
  loadHookListView,
  loadHooks,
  toTrustRow,
  type HookLoadContext
} from './hooks-loader'
import { cancelHookRunsByKey, runMatchingHooks } from './hooks-runner'

let hookRuntimeEnabled = false

export function initializeHookRuntimeSettings(): void {
  const settings = readPersistedSettingsState()
  hookRuntimeEnabled = settings.hooksEnabled === true
  console.log(`[Hooks] runtime ${hookRuntimeEnabled ? 'enabled' : 'disabled'}`)
}

export function isHookRuntimeEnabled(): boolean {
  return hookRuntimeEnabled
}

export async function listHooks(args: HooksListArgs = {}): Promise<HookListView> {
  return await loadHookListView(await resolveHookContext(args), { enabled: hookRuntimeEnabled })
}

export async function reloadHooks(args: HooksListArgs = {}): Promise<HookListView> {
  return await listHooks(args)
}

export async function setHookTrust(args: HooksSetTrustArgs): Promise<HookListView> {
  const context = await resolveHookContext(args)
  const hook = await findHookById(args.hookId, context)
  if (!hook) throw new Error('Hook no longer exists')
  assertExpectedHook(hook, args)
  if (hook.trustStatus === 'invalid') throw new Error('Invalid hook cannot be trusted')
  if (hook.configDisabled) throw new Error('Disabled hook cannot be trusted')
  await upsertHookTrust(toTrustRow(hook, args.decision, false, Date.now()))
  return await listHooks(context)
}

export async function setHookDisabled(args: HooksSetDisabledArgs): Promise<HookListView> {
  const context = await resolveHookContext(args)
  const hook = await findHookById(args.hookId, context)
  if (!hook) throw new Error('Hook no longer exists')
  if (hook.trustKey !== args.expectedTrustKey) {
    throw new Error('Hook changed. Refresh before changing disabled state.')
  }
  const status = hook.storedTrustStatus ?? HOOK_TRUST_STATUS.pending
  await upsertHookTrust(toTrustRow(hook, status, args.disabled, undefined))
  return await listHooks(context)
}

export async function openHookSource(args: HooksOpenSourceArgs): Promise<{ success: boolean }> {
  const context = await resolveHookContext(args)
  const hook = await findHookById(args.hookId, context)
  if (!hook) throw new Error('Hook no longer exists')
  if (hook.trustKey !== args.expectedTrustKey) {
    throw new Error('Hook changed. Refresh before opening source.')
  }
  const targetPath =
    args.target === 'config'
      ? hook.sourceRealPath || hook.sourcePath
      : hook.artifactHashes.find((artifact) => artifact.status !== 'untracked')?.path
  if (!targetPath) throw new Error('No tracked artifact path is available')
  const error = await shell.openPath(targetPath)
  if (error) throw new Error(error)
  return { success: true }
}

export async function openUserHooksConfig(): Promise<{ success: boolean; path: string }> {
  const configPath = await ensureUserHooksConfig()
  const error = await shell.openPath(configPath)
  if (error) throw new Error(error)
  return { success: true, path: configPath }
}

export async function getHookRunHistory(args: HooksRunHistoryArgs): Promise<HookRunSummary[]> {
  const context = await resolveHookContext(args)
  const hook = await findHookById(args.hookId, context)
  if (!hook) throw new Error('Hook no longer exists')
  if (hook.trustKey !== args.expectedTrustKey) {
    throw new Error('Hook changed. Refresh before reading run history.')
  }
  const rows = await listHookRuns(hook.trustKey, args.limit ?? 50)
  return rows.map((row) => ({
    id: row.id,
    trustKey: row.trustKey,
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    eventName: row.eventName,
    startedAt: row.startedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.durationMs ? { durationMs: row.durationMs } : {}),
    status: row.status,
    ...(row.exitCode !== undefined && row.exitCode !== null ? { exitCode: row.exitCode } : {}),
    ...(row.skippedReason ? { skippedReason: row.skippedReason } : {}),
    ...(row.stdoutPreview ? { stdoutPreview: row.stdoutPreview } : {}),
    ...(row.stderrPreview ? { stderrPreview: row.stderrPreview } : {}),
    ...(row.decisionJson ? { decision: safeJsonParse(row.decisionJson) } : {}),
    ...(row.error ? { error: row.error } : {})
  }))
}

export async function runHooks(request: HookRunRequest): Promise<HookRunResult> {
  if (!hookRuntimeEnabled) {
    return {
      ok: true,
      systemMessages: [],
      additionalContext: []
    }
  }

  const context = await resolveHookContext({
    sessionId: request.sessionId,
    projectId: request.projectId,
    projectRoot: request.projectRoot,
    sshConnectionId: request.sshConnectionId
  })
  const loaded = await loadHooks(context, { includeLastRuns: false })
  return await runMatchingHooks({
    request: {
      ...request,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.projectId ? { projectId: context.projectId } : {}),
      ...(context.projectRoot ? { projectRoot: context.projectRoot } : {}),
      ...(context.sshConnectionId ? { sshConnectionId: context.sshConnectionId } : {})
    },
    hooks: loaded.hooks
  })
}

export function cancelHookRuns(cancellationKey: string): void {
  cancelHookRunsByKey(cancellationKey)
}

export function startHookMaintenance(): void {
  void cleanupHookRuns().catch((error) => {
    console.warn('[Hooks] cleanup failed:', error instanceof Error ? error.message : String(error))
  })
  setInterval(
    () => {
      void cleanupHookRuns().catch((error) => {
        console.warn(
          '[Hooks] cleanup failed:',
          error instanceof Error ? error.message : String(error)
        )
      })
    },
    24 * 60 * 60 * 1000
  ).unref()
}

async function resolveHookContext(args: HooksListArgs): Promise<HookLoadContext> {
  const context: HookLoadContext = {
    projectId: args.projectId ?? undefined,
    sessionId: args.sessionId ?? undefined,
    projectRoot: args.projectRoot ?? undefined,
    sshConnectionId: args.sshConnectionId ?? undefined
  }
  if (context.sessionId) {
    const session = await sessionsDao.getSession(context.sessionId).catch(() => undefined)
    if (session) {
      context.projectId = context.projectId ?? session.project_id ?? undefined
      context.projectRoot = context.projectRoot ?? session.working_folder ?? undefined
      context.sshConnectionId = context.sshConnectionId ?? session.ssh_connection_id ?? undefined
    }
  }
  if (context.projectId && (!context.projectRoot || context.sshConnectionId === undefined)) {
    const project = await projectsDao.getProject(context.projectId).catch(() => undefined)
    if (project) {
      context.projectRoot = context.projectRoot ?? project.working_folder ?? undefined
      context.sshConnectionId = context.sshConnectionId ?? project.ssh_connection_id ?? undefined
    }
  }
  return context
}

function assertExpectedHook(
  hook: { trustKey: string; definitionHash: string; sourceConfigHash: string },
  args: HooksSetTrustArgs
): void {
  if (
    hook.trustKey !== args.expectedTrustKey ||
    hook.definitionHash !== args.expectedDefinitionHash ||
    hook.sourceConfigHash !== args.expectedSourceConfigHash
  ) {
    throw new Error('Hook changed. Refresh and review the current definition before trusting it.')
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
