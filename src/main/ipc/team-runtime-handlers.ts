import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { nanoid } from 'nanoid'
import type {
  AppendTeamRuntimeMessageArgs,
  ConsumeTeamRuntimeMessagesArgs,
  CreateTeamRuntimeArgs,
  DeleteTeamRuntimeArgs,
  GetTeamRuntimeSnapshotArgs,
  TeamRuntimeCreateResult,
  TeamRuntimeManifest,
  TeamRuntimeMessageRecord,
  TeamRuntimeSnapshot,
  UpdateTeamRuntimeManifestArgs,
  UpdateTeamRuntimeMemberArgs
} from '../../shared/team-runtime-types'

const DATA_DIR = path.join(os.homedir(), '.open-cowork')
const TEAMS_DIR = path.join(DATA_DIR, 'teams')
const TEAM_FILE = 'team.json'
const MESSAGES_FILE = 'messages.json'
const LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400]
const MAX_RECENT_MESSAGES = 50

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function sanitizeTeamName(rawName: string): string {
  return rawName
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function getTeamRuntimePath(teamName: string): string {
  const normalized = sanitizeTeamName(teamName)
  return path.join(TEAMS_DIR, normalized)
}

function getTeamFilePath(teamName: string): string {
  return path.join(getTeamRuntimePath(teamName), TEAM_FILE)
}

function getMessagesFilePath(teamName: string): string {
  return path.join(getTeamRuntimePath(teamName), MESSAGES_FILE)
}

function getLockPath(filePath: string): string {
  return `${filePath}.lock`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireFileLock(lockPath: string): Promise<() => void> {
  ensureDir(path.dirname(lockPath))

  for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const fd = await fs.promises.open(lockPath, 'wx')
      return () => {
        try {
          fd.close().catch(() => {})
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(lockPath)
        } catch {
          // ignore
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt === LOCK_RETRY_DELAYS_MS.length) {
        throw new Error(`Timed out acquiring lock for ${path.basename(lockPath)}`)
      }
      await sleep(LOCK_RETRY_DELAYS_MS[attempt])
    }
  }

  throw new Error(`Failed to acquire lock for ${path.basename(lockPath)}`)
}

async function withJsonFileLock<T>(filePath: string, handler: () => Promise<T>): Promise<T> {
  const release = await acquireFileLock(getLockPath(filePath))
  try {
    return await handler()
  } finally {
    release()
  }
}

function readJsonFileOrDefault<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

function readManifest(teamName: string): TeamRuntimeManifest | null {
  const filePath = getTeamFilePath(teamName)
  return readJsonFileOrDefault<TeamRuntimeManifest | null>(filePath, null)
}

function readMessages(teamName: string): TeamRuntimeMessageRecord[] {
  const filePath = getMessagesFilePath(teamName)
  return readJsonFileOrDefault<TeamRuntimeMessageRecord[]>(filePath, [])
}

async function createTeamRuntime(args: CreateTeamRuntimeArgs): Promise<TeamRuntimeCreateResult> {
  const safeTeamName = sanitizeTeamName(args.teamName)
  if (!safeTeamName) {
    throw new Error('Invalid team name')
  }

  const runtimePath = getTeamRuntimePath(safeTeamName)
  const teamFilePath = getTeamFilePath(safeTeamName)
  const messagesFilePath = getMessagesFilePath(safeTeamName)

  return withJsonFileLock(teamFilePath, async () => {
    if (fs.existsSync(teamFilePath)) {
      throw new Error(`Team "${safeTeamName}" already exists`)
    }

    ensureDir(runtimePath)
    const now = Date.now()
    const leadAgentId = `team-lead@${safeTeamName}-${nanoid(6)}`
    const allowedPaths = args.workingFolder ? [args.workingFolder] : []
    const manifest: TeamRuntimeManifest = {
      version: 1,
      name: safeTeamName,
      description: args.description,
      createdAt: now,
      updatedAt: now,
      runtimePath,
      leadAgentId,
      leadSessionId: args.sessionId,
      defaultBackend: args.defaultBackend ?? 'in-process',
      permissionMode: 'default',
      teamAllowedPaths: allowedPaths,
      members: [
        {
          agentId: leadAgentId,
          name: 'lead',
          role: 'lead',
          backendType: args.defaultBackend ?? 'in-process',
          status: 'idle',
          currentTaskId: null,
          sessionId: args.sessionId,
          isActive: true,
          startedAt: now,
          completedAt: null
        }
      ],
      tasks: []
    }

    writeJsonFile(teamFilePath, manifest)
    writeJsonFile(messagesFilePath, [])

    return {
      teamName: safeTeamName,
      runtimePath,
      leadAgentId,
      createdAt: now,
      defaultBackend: manifest.defaultBackend,
      permissionMode: manifest.permissionMode,
      teamAllowedPaths: manifest.teamAllowedPaths
    }
  })
}

async function deleteTeamRuntime(args: DeleteTeamRuntimeArgs): Promise<{ success: true }> {
  const runtimePath = getTeamRuntimePath(args.teamName)
  await fs.promises.rm(runtimePath, { recursive: true, force: true })
  return { success: true }
}

async function appendTeamMessage(args: AppendTeamRuntimeMessageArgs): Promise<{ success: true }> {
  const manifest = readManifest(args.teamName)
  if (!manifest) {
    throw new Error(`Team "${args.teamName}" does not exist`)
  }

  const messagesFilePath = getMessagesFilePath(args.teamName)
  const teamFilePath = getTeamFilePath(args.teamName)

  await withJsonFileLock(messagesFilePath, async () => {
    const messages = readMessages(args.teamName)
    messages.push(args.message)
    writeJsonFile(messagesFilePath, messages)
  })

  await withJsonFileLock(teamFilePath, async () => {
    const current = readManifest(args.teamName)
    if (!current) return
    current.updatedAt = Date.now()
    writeJsonFile(teamFilePath, current)
  })

  return { success: true }
}

async function getTeamSnapshot(
  args: GetTeamRuntimeSnapshotArgs
): Promise<TeamRuntimeSnapshot | null> {
  const manifest = readManifest(args.teamName)
  if (!manifest) return null

  const messages = readMessages(args.teamName)
  const limit = Math.max(1, Math.min(args.limit ?? 10, MAX_RECENT_MESSAGES))

  return {
    team: manifest,
    recentMessages: messages.slice(-limit)
  }
}

async function updateTeamManifest(args: UpdateTeamRuntimeManifestArgs): Promise<{ success: true }> {
  const teamFilePath = getTeamFilePath(args.teamName)
  await withJsonFileLock(teamFilePath, async () => {
    const manifest = readManifest(args.teamName)
    if (!manifest) {
      throw new Error(`Team "${args.teamName}" does not exist`)
    }

    Object.assign(manifest, args.patch)
    manifest.updatedAt = Date.now()
    writeJsonFile(teamFilePath, manifest)
  })

  return { success: true }
}

async function updateTeamMember(args: UpdateTeamRuntimeMemberArgs): Promise<{ success: true }> {
  const teamFilePath = getTeamFilePath(args.teamName)
  await withJsonFileLock(teamFilePath, async () => {
    const manifest = readManifest(args.teamName)
    if (!manifest) {
      throw new Error(`Team "${args.teamName}" does not exist`)
    }

    let member = manifest.members.find((item) => item.agentId === args.memberId)
    if (!member) {
      member = {
        agentId: args.memberId,
        name: args.memberId,
        role: 'worker',
        backendType: 'in-process',
        status: 'idle',
        currentTaskId: null,
        isActive: true,
        startedAt: Date.now(),
        completedAt: null
      }
      manifest.members.push(member)
    }

    Object.assign(member, args.patch)
    manifest.updatedAt = Date.now()
    writeJsonFile(teamFilePath, manifest)
  })

  return { success: true }
}

async function consumeTeamMessages(
  args: ConsumeTeamRuntimeMessagesArgs
): Promise<TeamRuntimeMessageRecord[]> {
  const manifest = readManifest(args.teamName)
  if (!manifest) return []

  const limit = Math.max(1, Math.min(args.limit ?? 20, MAX_RECENT_MESSAGES))
  const afterTimestamp = args.afterTimestamp ?? 0
  const recipient = args.recipient?.trim()
  const includeBroadcast = args.includeBroadcast ?? true

  const messages = readMessages(args.teamName).filter((message) => {
    if (message.timestamp <= afterTimestamp) return false
    if (!recipient) return true
    if (message.to === recipient) return true
    if (includeBroadcast && message.to === 'all') return true
    return false
  })

  return messages.slice(-limit)
}

export function registerTeamRuntimeHandlers(): void {
  ensureDir(TEAMS_DIR)

  ipcMain.handle('team-runtime:create', async (_event, args: CreateTeamRuntimeArgs) => {
    return createTeamRuntime(args)
  })

  ipcMain.handle('team-runtime:delete', async (_event, args: DeleteTeamRuntimeArgs) => {
    return deleteTeamRuntime(args)
  })

  ipcMain.handle(
    'team-runtime:message:append',
    async (_event, args: AppendTeamRuntimeMessageArgs) => {
      return appendTeamMessage(args)
    }
  )

  ipcMain.handle('team-runtime:snapshot', async (_event, args: GetTeamRuntimeSnapshotArgs) => {
    return getTeamSnapshot(args)
  })

  ipcMain.handle(
    'team-runtime:member:update',
    async (_event, args: UpdateTeamRuntimeMemberArgs) => {
      return updateTeamMember(args)
    }
  )

  ipcMain.handle(
    'team-runtime:manifest:update',
    async (_event, args: UpdateTeamRuntimeManifestArgs) => {
      return updateTeamManifest(args)
    }
  )

  ipcMain.handle(
    'team-runtime:messages:consume',
    async (_event, args: ConsumeTeamRuntimeMessagesArgs) => {
      return consumeTeamMessages(args)
    }
  )
}
