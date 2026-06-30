import { BrowserWindow, type WebContents } from 'electron'
import { safeSendMessagePackToWindow } from '../window-ipc'
import { getNativeWorker } from '../lib/native-worker'
import { buildShellEnvironment } from './shell-environment'
import { registerMessagePackHandler } from './messagepack-handler'

interface CreateTerminalSessionArgs {
  cwd?: string
  shell?: string
  cols?: number
  rows?: number
  title?: string
  command?: string
}

interface CreateTerminalSessionResult {
  id?: string
  shell?: string
  cwd?: string
  cols?: number
  rows?: number
  createdAt?: number
  title?: string
  command?: string
  error?: string
}

interface TerminalOutputChunk {
  seq: number
  data: string
}

interface TerminalOutputEvent {
  id: string
  data: string
  seq: number
}

interface TerminalExitEvent {
  id: string
  exitCode: number
  signal?: number
}

interface TerminalSessionListEntry {
  id: string
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  title: string
  command?: string
  exitCode?: number
  exitSignal?: number
  buffer?: TerminalOutputChunk[]
}

interface NativeTerminalMutationResult {
  success: boolean
  error?: string | null
}

interface NativeTerminalSnapshotResult {
  success: boolean
  session?: TerminalSessionListEntry | null
  error?: string | null
}

const terminalWindowIds = new Map<string, number | null>()
const terminalOutputListeners = new Set<(event: TerminalOutputEvent) => void>()
const terminalExitListeners = new Set<(event: TerminalExitEvent) => void>()
let nativeTerminalEventsRegistered = false

function resolveOwnerWindowId(sender?: WebContents | null): number | null {
  return sender ? (BrowserWindow.fromWebContents(sender)?.id ?? null) : null
}

function createWindowEvent(windowId: number | null, channel: string, payload: unknown): void {
  const win =
    (typeof windowId === 'number'
      ? BrowserWindow.getAllWindows().find((candidate) => candidate.id === windowId)
      : null) ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  safeSendMessagePackToWindow(win, channel, payload)
}

function emitTerminalOutput(event: TerminalOutputEvent): void {
  terminalOutputListeners.forEach((listener) => listener(event))
}

function emitTerminalExit(event: TerminalExitEvent): void {
  terminalExitListeners.forEach((listener) => listener(event))
}

function serializeShellEnvironment(): Record<string, string> {
  const env = buildShellEnvironment()
  const serialized: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      serialized[key] = value
    }
  }
  return serialized
}

function isNativeTerminalOutputEvent(value: unknown): value is TerminalOutputEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TerminalOutputEvent).id === 'string' &&
    typeof (value as TerminalOutputEvent).data === 'string' &&
    typeof (value as TerminalOutputEvent).seq === 'number'
  )
}

function isNativeTerminalExitEvent(value: unknown): value is TerminalExitEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TerminalExitEvent).id === 'string' &&
    typeof (value as TerminalExitEvent).exitCode === 'number'
  )
}

function ensureNativeTerminalEventBridge(): void {
  if (nativeTerminalEventsRegistered) return
  nativeTerminalEventsRegistered = true
  const nativeWorker = getNativeWorker()

  nativeWorker.onEvent('terminal/output', (params) => {
    if (!isNativeTerminalOutputEvent(params)) return
    createWindowEvent(terminalWindowIds.get(params.id) ?? null, 'terminal:output', params)
    emitTerminalOutput(params)
  })

  nativeWorker.onEvent('terminal/exit', (params) => {
    if (!isNativeTerminalExitEvent(params)) return
    createWindowEvent(terminalWindowIds.get(params.id) ?? null, 'terminal:exit', params)
    emitTerminalExit(params)
  })
}

function toCreatedEvent(result: CreateTerminalSessionResult): TerminalSessionListEntry | null {
  if (!result.id || !result.shell || !result.cwd || !result.createdAt || !result.title) {
    return null
  }

  return {
    id: result.id,
    shell: result.shell,
    cwd: result.cwd,
    cols: result.cols ?? 80,
    rows: result.rows ?? 24,
    createdAt: result.createdAt,
    title: result.title,
    ...(result.command ? { command: result.command } : {})
  }
}

export async function createTerminalSession(
  args: CreateTerminalSessionArgs,
  sender?: WebContents | null
): Promise<CreateTerminalSessionResult> {
  ensureNativeTerminalEventBridge()
  const ownerWindowId = resolveOwnerWindowId(sender)
  const result = await getNativeWorker().request<CreateTerminalSessionResult>(
    'terminal/create',
    {
      cwd: args.cwd || process.cwd(),
      ...(args.shell ? { shell: args.shell } : {}),
      cols: Math.max(20, Math.floor(args.cols ?? 80)),
      rows: Math.max(5, Math.floor(args.rows ?? 24)),
      ...(args.title ? { title: args.title } : {}),
      ...(args.command ? { command: args.command } : {}),
      env: serializeShellEnvironment()
    },
    120_000
  )

  if (result.id) {
    terminalWindowIds.set(result.id, ownerWindowId)
    const created = toCreatedEvent(result)
    if (created) {
      createWindowEvent(ownerWindowId, 'terminal:created', created)
    }
  }

  return result
}

export function onTerminalSessionOutput(
  listener: (event: TerminalOutputEvent) => void
): () => void {
  terminalOutputListeners.add(listener)
  return () => terminalOutputListeners.delete(listener)
}

export function onTerminalSessionExit(listener: (event: TerminalExitEvent) => void): () => void {
  terminalExitListeners.add(listener)
  return () => terminalExitListeners.delete(listener)
}

export function registerTerminalHandlers(): void {
  ensureNativeTerminalEventBridge()

  registerMessagePackHandler<CreateTerminalSessionArgs>(
    'terminal:create',
    async (args, event) => {
      return await createTerminalSession(args, event.sender)
    }
  )

  registerMessagePackHandler<{ id: string; data: string }>('terminal:input', async (args) => {
    return await writeTerminalSession(args.id, args.data)
  })

  registerMessagePackHandler<{ id: string; cols: number; rows: number }>(
    'terminal:resize',
    async (args) => {
      const result = await getNativeWorker().request<NativeTerminalMutationResult>(
        'terminal/resize',
        {
          id: args.id,
          cols: Math.max(20, Math.floor(args.cols)),
          rows: Math.max(5, Math.floor(args.rows))
        },
        30_000
      )
      return result.success
        ? { success: true }
        : { error: result.error ?? 'Terminal resize failed' }
    }
  )

  registerMessagePackHandler<{ id: string }>('terminal:kill', async (args) => {
    return await killTerminalSession(args.id)
  })

  registerMessagePackHandler<{ id: string }>('terminal:get', async (args) => {
    const session = await getTerminalSessionSnapshot(args.id)
    return session
      ? { success: true, session }
      : { success: false, error: 'Terminal not found' }
  })

  registerMessagePackHandler<undefined>('terminal:list', async () => {
    ensureNativeTerminalEventBridge()
    return await getNativeWorker().request<TerminalSessionListEntry[]>('terminal/list', {}, 30_000)
  })
}

export async function getTerminalSessionSnapshot(
  id: string
): Promise<TerminalSessionListEntry | undefined> {
  ensureNativeTerminalEventBridge()
  const result = await getNativeWorker().request<NativeTerminalSnapshotResult>(
    'terminal/get',
    { id },
    30_000
  )
  return result.success ? (result.session ?? undefined) : undefined
}

export async function writeTerminalSession(
  id: string,
  data: string
): Promise<{ success?: true; error?: string }> {
  ensureNativeTerminalEventBridge()
  const result = await getNativeWorker().request<NativeTerminalMutationResult>(
    'terminal/input',
    { id, data },
    30_000
  )
  return result.success ? { success: true } : { error: result.error ?? 'Terminal input failed' }
}

export async function killTerminalSession(id: string): Promise<{ success?: true; error?: string }> {
  ensureNativeTerminalEventBridge()
  const result = await getNativeWorker().request<NativeTerminalMutationResult>(
    'terminal/kill',
    { id },
    30_000
  )
  if (result.success) {
    terminalWindowIds.delete(id)
    return { success: true }
  }
  return { error: result.error ?? 'Terminal kill failed' }
}

export function killAllTerminalSessions(): void {
  if (!nativeTerminalEventsRegistered) return
  terminalWindowIds.clear()
  void getNativeWorker()
    .request<NativeTerminalMutationResult>('terminal/kill-all', {}, 30_000)
    .catch((error) => console.warn('[Terminal] Native kill-all failed:', error))
}
