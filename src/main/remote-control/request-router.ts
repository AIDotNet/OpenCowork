import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import {
  REMOTE_CONTROL_INITIAL_STATE,
  REMOTE_EVENT_OPS,
  REMOTE_MAIN_HANDLED_OPS,
  REMOTE_REQUEST_OPS,
  REMOTE_REQUEST_TIMEOUT_MS,
  REMOTE_TERMINAL_FLUSH_MS,
  decodeRemotePayload,
  encodeRemotePayload,
  unwrapRemoteRouteResult,
  type RemoteEnvelope,
  type RemoteErrorPayload,
  type RemoteRendererEvent,
  type RemoteRendererResponse,
  type RemoteTerminalInputRequest
} from '../../shared/remote-control'
import {
  DEFAULT_PERMISSION_POLICY,
  evaluateToolPermission,
  sanitizePermissionPolicy,
  type PermissionPolicy
} from '../../shared/permission-policy'
import { decodePersistedStoreState } from '../ipc/settings-handlers'
import { readConfig } from '../ipc/secure-key-store'
import {
  createTerminalSession,
  getTerminalSessionSnapshot,
  killTerminalSession,
  listTerminalSessionSnapshots,
  onTerminalSessionExit,
  onTerminalSessionOutput,
  resizeTerminalSession,
  writeTerminalSession
} from '../ipc/terminal-handlers'
import { safeSendMessagePackToWindow } from '../window-ipc'

export type RelayEnvelope = (envelope: RemoteEnvelope) => Promise<void>

const pendingRendererRequests = new Map<
  string,
  { resolve: (value: RemoteRendererResponse) => void; timer: NodeJS.Timeout }
>()
const routedRequestIds = new Map<string, number>()
const terminalLines = new Map<string, string>()
const knownTerminals = new Set<string>()
const subscribedTerminals = new Map<string, Set<string>>()
const pendingOutput = new Map<string, { data: string; seq: number }>()
let outputTimer: NodeJS.Timeout | null = null
let relayEnvelope: RelayEnvelope | null = null
let outputUnsubscribe: (() => void) | null = null
let exitUnsubscribe: (() => void) | null = null
let terminalWriteEnabled = true

/** How long a routed envelope id is remembered; well past the phone's request timeout. */
const ROUTED_REQUEST_TTL_MS = 5 * 60_000
/** Ceiling on remembered ids, so a long uptime cannot grow the map without bound. */
const ROUTED_REQUEST_LIMIT = 4096

function remoteError(
  code: RemoteErrorPayload['code'],
  message: string
): { error: RemoteErrorPayload } {
  return { error: { code, message } }
}

async function currentPolicy(): Promise<PermissionPolicy> {
  const config = await readConfig()
  const persisted = decodePersistedStoreState<Record<string, unknown>>(
    config['opencowork-settings']
  )
  if (persisted) return sanitizePermissionPolicy(persisted.permissionPolicy)
  return { ...DEFAULT_PERMISSION_POLICY }
}

export function setRemoteControlRelay(relay: RelayEnvelope | null): void {
  relayEnvelope = relay
  if (relay && !outputUnsubscribe) {
    outputUnsubscribe = onTerminalSessionOutput((event) => {
      for (const mobileId of subscribedTerminals.get(event.id) ?? []) {
        const key = `${mobileId}:${event.id}`
        const previous = pendingOutput.get(key)
        pendingOutput.set(key, { data: `${previous?.data ?? ''}${event.data}`, seq: event.seq })
      }
      scheduleOutputFlush()
    })
    exitUnsubscribe = onTerminalSessionExit((event) => {
      for (const mobileId of subscribedTerminals.get(event.id) ?? []) {
        void sendEvent(
          REMOTE_EVENT_OPS.TERMINAL_EXIT,
          { terminalId: event.id, exitCode: event.exitCode },
          mobileId
        )
      }
    })
  } else if (!relay && outputUnsubscribe) {
    outputUnsubscribe()
    exitUnsubscribe?.()
    outputUnsubscribe = null
    exitUnsubscribe = null
  }
}

export function setRemoteTerminalWriteEnabled(enabled: boolean): void {
  terminalWriteEnabled = enabled
}

function scheduleOutputFlush(): void {
  if (outputTimer) return
  outputTimer = setTimeout(() => {
    outputTimer = null
    for (const [key, output] of pendingOutput) {
      const separator = key.indexOf(':')
      const mobileId = key.slice(0, separator)
      const terminalId = key.slice(separator + 1)
      pendingOutput.delete(key)
      void sendEvent(
        REMOTE_EVENT_OPS.TERMINAL_OUTPUT,
        { terminalId, data: output.data, seq: output.seq },
        mobileId
      )
    }
  }, REMOTE_TERMINAL_FLUSH_MS)
}

async function sendEvent(op: string, payload: unknown, mobileId?: string | null): Promise<void> {
  if (!relayEnvelope) return
  await relayEnvelope({
    Id: randomUUID(),
    Kind: 'evt',
    Op: op,
    MobileId: mobileId ?? null,
    Seq: 0,
    Total: 1,
    Payload: encodeRemotePayload(payload)
  })
}

async function handleTerminalInput(input: RemoteTerminalInputRequest): Promise<unknown> {
  if (!terminalWriteEnabled)
    return remoteError('terminal_write_disabled', 'Remote terminal writes are disabled')
  let line = terminalLines.get(input.terminalId) ?? ''
  let segment = ''
  for (const char of input.data) {
    if (char !== '\r' && char !== '\n') {
      // Keep command text out of the PTY until it has passed the policy gate.
      // Non-newline control keys (Ctrl-C, arrows, etc.) are safe to forward now.
      // eslint-disable-next-line no-control-regex -- matching raw control bytes is the point
      if (/^[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]$/.test(char)) {
        const written = await writeTerminalSession(input.terminalId, char)
        if (written.error) return remoteError('not_found', written.error)
      } else {
        segment += char
      }
      continue
    }
    line += segment
    const decision = evaluateToolPermission('Bash', { command: line }, await currentPolicy())
    if (decision.decision === 'deny') {
      terminalLines.set(input.terminalId, '')
      return remoteError('terminal_command_denied', decision.rule.pattern)
    }
    const written = await writeTerminalSession(input.terminalId, `${line}${char}`)
    if (written.error) return remoteError('not_found', written.error)
    line = ''
  }
  line += segment
  terminalLines.set(input.terminalId, line)
  return { ok: true }
}

function stringField(
  payload: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  return typeof payload?.[key] === 'string' ? (payload[key] as string) : undefined
}

/**
 * Claims an envelope id, returning false when this process already routed it.
 *
 * Relay delivery is at-least-once: the hub fans a mobile request out to the whole
 * desktop group, so a second copy arrives whenever more than one connection is
 * registered for the device, and a chunked request that reassembles twice lands
 * here twice as well. The writes behind these ops are not idempotent — a repeated
 * `session.send` submits the turn again — so the id is claimed before anything
 * runs. The duplicate needs no reply: the copy that won carries the same id, and
 * its response answers the phone's pending request.
 */
function claimRequestId(id: string): boolean {
  const now = Date.now()
  // Ids are inserted once and never refreshed, so insertion order is chronological
  // and the first entry still inside the window ends the sweep.
  for (const [routedId, routedAt] of routedRequestIds) {
    if (now - routedAt < ROUTED_REQUEST_TTL_MS) break
    routedRequestIds.delete(routedId)
  }
  if (routedRequestIds.has(id)) return false
  routedRequestIds.set(id, now)
  if (routedRequestIds.size > ROUTED_REQUEST_LIMIT) {
    const oldest = routedRequestIds.keys().next()
    if (!oldest.done) routedRequestIds.delete(oldest.value)
  }
  return true
}

async function handleMain(
  op: string,
  payload: Record<string, unknown> | undefined,
  mobileId: string | null | undefined
): Promise<unknown> {
  switch (op) {
    case REMOTE_REQUEST_OPS.TERMINAL_LIST: {
      const terminals = listTerminalSessionSnapshots().map((snapshot) => {
        knownTerminals.add(snapshot.id)
        return {
          id: snapshot.id,
          title: snapshot.title,
          cwd: snapshot.cwd,
          shell: snapshot.shell,
          status: snapshot.exitCode === undefined ? 'running' : 'exited',
          ...(snapshot.exitCode !== undefined ? { exitCode: snapshot.exitCode } : {})
        }
      })
      return { terminals }
    }
    case REMOTE_REQUEST_OPS.TERMINAL_CREATE: {
      const result = await createTerminalSession({
        cwd: stringField(payload, 'cwd'),
        title: stringField(payload, 'title')
      })
      if (!result.id) return remoteError('internal', result.error ?? 'Failed to create terminal')
      knownTerminals.add(result.id)
      return { terminalId: result.id }
    }
    case REMOTE_REQUEST_OPS.TERMINAL_INPUT:
      if (typeof payload?.terminalId !== 'string' || typeof payload.data !== 'string') {
        return remoteError('bad_request', 'Invalid terminal input')
      }
      return await handleTerminalInput(payload as unknown as RemoteTerminalInputRequest)
    case REMOTE_REQUEST_OPS.TERMINAL_RESIZE: {
      const terminalId = stringField(payload, 'terminalId') ?? ''
      const cols = typeof payload?.cols === 'number' ? payload.cols : 80
      const rows = typeof payload?.rows === 'number' ? payload.rows : 24
      const resized = await resizeTerminalSession(terminalId, cols, rows)
      return resized.error ? remoteError('not_found', resized.error) : { ok: true }
    }
    case REMOTE_REQUEST_OPS.TERMINAL_KILL: {
      const result = await killTerminalSession(stringField(payload, 'terminalId') ?? '')
      return result.error ? remoteError('not_found', result.error) : { ok: true }
    }
    case REMOTE_REQUEST_OPS.TERMINAL_SUBSCRIBE: {
      const terminalId = stringField(payload, 'terminalId') ?? ''
      const snapshot = await getTerminalSessionSnapshot(terminalId)
      if (!snapshot) return remoteError('not_found', 'Terminal not found')
      const subscribers = subscribedTerminals.get(terminalId) ?? new Set<string>()
      if (mobileId) subscribers.add(mobileId)
      subscribedTerminals.set(terminalId, subscribers)
      return {
        backlog: (snapshot.buffer ?? []).map((chunk) => chunk.data).join(''),
        seq: snapshot.buffer?.at(-1)?.seq ?? 0
      }
    }
    case REMOTE_REQUEST_OPS.TERMINAL_UNSUBSCRIBE:
      if (mobileId)
        subscribedTerminals.get(stringField(payload, 'terminalId') ?? '')?.delete(mobileId)
      return { ok: true }
    case REMOTE_REQUEST_OPS.SESSION_KEEPALIVE:
      return { ok: true }
    default:
      return remoteError('unsupported_op', `Unsupported operation: ${op}`)
  }
}

export async function routeRemoteRequest(req: RemoteEnvelope, relay: RelayEnvelope): Promise<void> {
  if (!claimRequestId(req.Id)) {
    console.warn('[remote-control] dropped a request that was already routed', {
      id: req.Id,
      op: req.Op
    })
    return
  }
  const payload = decodeRemotePayload<Record<string, unknown>>(req.Payload)
  if (req.Op === REMOTE_REQUEST_OPS.SESSION_SEND) {
    // A turn submitted twice is the one failure a user notices immediately, and the
    // id tells apart "the phone asked twice" from "one ask was delivered twice".
    console.log('[remote-control] session.send', {
      id: req.Id,
      mobileId: req.MobileId,
      sessionId: payload?.sessionId,
      chars: typeof payload?.text === 'string' ? payload.text.length : 0
    })
  }
  const fromMain = REMOTE_MAIN_HANDLED_OPS.includes(req.Op)
  const result = fromMain
    ? await handleMain(req.Op, payload, req.MobileId)
    : await forwardToRenderer({ id: req.Id, op: req.Op, payload })
  const routed = unwrapRemoteRouteResult(result, fromMain ? 'main' : 'renderer')
  await relay({
    Id: req.Id,
    Kind: routed.kind,
    Op: req.Op,
    MobileId: req.MobileId ?? null,
    Seq: 0,
    Total: 1,
    Payload: encodeRemotePayload(routed.payload)
  })
}

function forwardToRenderer(request: {
  id: string
  op: string
  payload: unknown
}): Promise<RemoteRendererResponse> {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win)
    return Promise.resolve({
      id: request.id,
      ok: false,
      error: { code: 'desktop_offline', message: 'Renderer unavailable' }
    })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRendererRequests.delete(request.id)
      resolve({
        id: request.id,
        ok: false,
        error: { code: 'timeout', message: 'Renderer request timed out' }
      })
    }, REMOTE_REQUEST_TIMEOUT_MS)
    pendingRendererRequests.set(request.id, { resolve, timer })
    safeSendMessagePackToWindow(win, 'remote-control:request', request)
  })
}

export function resolveRendererResponse(response: RemoteRendererResponse): void {
  const pending = pendingRendererRequests.get(response.id)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingRendererRequests.delete(response.id)
  pending.resolve(response)
}

export function dispatchRendererEvent(event: RemoteRendererEvent): void {
  void sendEvent(event.op, event.payload)
}

export const remoteControlInitialState = REMOTE_CONTROL_INITIAL_STATE
