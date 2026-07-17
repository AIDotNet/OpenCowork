import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'
import { safeSendMessagePackToAllWindows } from '../window-ipc'
import { getConnectionWithSecrets, updateConnection } from './repository'
import { connectWithProxyJump, formatLayeredError } from './auth'

// Connection runtime: one authenticated ssh2 Client per saved connection,
// multiplexing N terminal shells over it. Handles keepalive-detected drops
// with exponential-backoff reconnect and shell re-attach.
//
// Wire compatibility: terminals are exposed to the renderer as "sessions"
// over the pre-existing ssh:status / ssh:output events, so the terminal id
// doubles as the sessionId. The one addition is the 'reconnecting' status.

type TerminalWireStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'

interface TerminalChannel {
  id: string
  stream: ClientChannel | null
  status: 'starting' | 'ready' | 'closed'
  cols: number
  rows: number
  seq: number
  ring: { seq: number; data: Buffer }[]
  ringBytes: number
}

type HandleState = 'connecting' | 'ready' | 'reconnecting' | 'failed' | 'closed'

interface ConnectionHandle {
  connectionId: string
  state: HandleState
  client: Client | null
  jumpClient: Client | null
  lastError?: string
  generation: number
  reconnectAttempts: number
  reconnectTimer: NodeJS.Timeout | null
  lingerTimer: NodeJS.Timeout | null
  connectPromise: Promise<void> | null
  terminals: Map<string, TerminalChannel>
  // Non-terminal consumers (fs/exec ops) currently borrowing this handle.
  busyCount: number
  sftpPromise: Promise<SFTPWrapper> | null
}

// Reads mutable state without TS control-flow narrowing (state changes
// across awaits inside the same function).
function currentState(handle: ConnectionHandle): HandleState {
  return handle.state
}

const handles = new Map<string, ConnectionHandle>()
const terminalIndex = new Map<string, ConnectionHandle>()
let nextTerminalId = 1

const MAX_RING_BYTES = 1024 * 1024
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000]
const MAX_RECONNECT_ATTEMPTS = 5
const LINGER_MS = 60_000
// A shell stream closing right before its client closes is a connection
// drop, not a user exit; wait this long before treating it as an exit.
const STREAM_CLOSE_GRACE_MS = 250

function broadcastStatus(
  terminalId: string,
  connectionId: string,
  status: TerminalWireStatus,
  error?: string
): void {
  safeSendMessagePackToAllWindows('ssh:status', {
    sessionId: terminalId,
    connectionId,
    status,
    ...(error ? { error } : {})
  })
}

function recordTerminalOutput(terminal: TerminalChannel, data: Buffer): void {
  terminal.seq += 1
  const chunk = Buffer.from(data)
  terminal.ring.push({ seq: terminal.seq, data: chunk })
  terminal.ringBytes += chunk.length
  while (terminal.ringBytes > MAX_RING_BYTES && terminal.ring.length > 1) {
    const removed = terminal.ring.shift()
    if (!removed) break
    terminal.ringBytes -= removed.data.length
  }
  const handle = terminalIndex.get(terminal.id)
  safeSendMessagePackToAllWindows('ssh:output', {
    sessionId: terminal.id,
    data: chunk.toString('base64'),
    seq: terminal.seq,
    connectionId: handle?.connectionId
  })
}

function injectNotice(terminal: TerminalChannel, text: string): void {
  recordTerminalOutput(terminal, Buffer.from(`\r\n\x1b[33m── ${text} ──\x1b[0m\r\n`, 'utf-8'))
}

function clearLinger(handle: ConnectionHandle): void {
  if (handle.lingerTimer) {
    clearTimeout(handle.lingerTimer)
    handle.lingerTimer = null
  }
}

function clearReconnectTimer(handle: ConnectionHandle): void {
  if (handle.reconnectTimer) {
    clearTimeout(handle.reconnectTimer)
    handle.reconnectTimer = null
  }
}

function disposeHandle(handle: ConnectionHandle): void {
  handle.state = 'closed'
  clearLinger(handle)
  clearReconnectTimer(handle)
  try {
    handle.client?.end()
  } catch {
    // ignore
  }
  try {
    handle.jumpClient?.end()
  } catch {
    // ignore
  }
  handle.client = null
  handle.jumpClient = null
  if (handles.get(handle.connectionId) === handle) {
    handles.delete(handle.connectionId)
  }
}

function removeTerminal(handle: ConnectionHandle, terminal: TerminalChannel): void {
  terminal.status = 'closed'
  try {
    terminal.stream?.end()
  } catch {
    // ignore
  }
  try {
    terminal.stream?.close()
  } catch {
    // ignore
  }
  terminal.stream = null
  handle.terminals.delete(terminal.id)
  terminalIndex.delete(terminal.id)
}

function scheduleLingerIfIdle(handle: ConnectionHandle): void {
  if (handle.terminals.size > 0 || handle.busyCount > 0 || handle.state === 'closed') return
  clearLinger(handle)
  handle.lingerTimer = setTimeout(() => {
    handle.lingerTimer = null
    if (handle.terminals.size === 0) {
      disposeHandle(handle)
    }
  }, LINGER_MS)
  handle.lingerTimer.unref?.()
}

function attachClientLifecycle(handle: ConnectionHandle, client: Client, generation: number): void {
  client.on('error', (err) => {
    if (generation !== handle.generation || handle.state === 'closed') return
    handle.lastError = formatLayeredError(err)
  })
  client.on('close', () => {
    if (generation !== handle.generation || handle.state === 'closed') return
    handle.client = null
    try {
      handle.jumpClient?.end()
    } catch {
      // ignore
    }
    handle.jumpClient = null
    handle.sftpPromise = null
    if (handle.terminals.size === 0 && handle.busyCount === 0) {
      disposeHandle(handle)
      return
    }
    beginReconnect(handle)
  })
}

async function doConnect(handle: ConnectionHandle): Promise<void> {
  const connection = getConnectionWithSecrets(handle.connectionId)
  if (!connection) {
    handle.lastError = 'Connection not found'
    throw new Error('Connection not found')
  }
  const generation = ++handle.generation
  try {
    const connected = await connectWithProxyJump(connection)
    if (generation !== handle.generation || handle.state === 'closed') {
      try {
        connected.client.end()
        connected.jumpClient?.end()
      } catch {
        // ignore
      }
      throw new Error('Connection superseded')
    }
    handle.client = connected.client
    handle.jumpClient = connected.jumpClient ?? null
    handle.sftpPromise = null
    handle.state = 'ready'
    handle.reconnectAttempts = 0
    handle.lastError = undefined
    attachClientLifecycle(handle, connected.client, generation)
    void updateConnection(handle.connectionId, { lastConnectedAt: Date.now() }).catch(() => {})
  } catch (err) {
    if (!handle.lastError || handle.state !== 'closed') {
      handle.lastError = formatLayeredError(err, connection.authType)
    }
    throw err
  }
}

async function openShell(handle: ConnectionHandle, terminal: TerminalChannel): Promise<void> {
  const client = handle.client
  if (!client) throw new Error('Connection is not ready')
  const connection = getConnectionWithSecrets(handle.connectionId)

  const stream = await new Promise<ClientChannel>((resolve, reject) => {
    client.shell(
      { term: 'xterm-256color', cols: terminal.cols, rows: terminal.rows, modes: {} },
      (err, channel) => {
        if (err) return reject(err)
        resolve(channel)
      }
    )
  })

  terminal.stream = stream
  terminal.status = 'ready'

  stream.on('data', (data: Buffer) => {
    recordTerminalOutput(terminal, data)
  })
  stream.stderr?.on('data', (data: Buffer) => {
    recordTerminalOutput(terminal, data)
  })
  stream.on('close', () => {
    setTimeout(() => {
      // Re-attached, connection-level teardown in progress, or already gone.
      if (terminal.stream !== stream) return
      if (handle.state !== 'ready') return
      if (!handle.terminals.has(terminal.id)) return
      removeTerminal(handle, terminal)
      broadcastStatus(terminal.id, handle.connectionId, 'disconnected')
      scheduleLingerIfIdle(handle)
    }, STREAM_CLOSE_GRACE_MS)
  })

  if (connection?.startupCommand) {
    stream.write(connection.startupCommand + '\n')
  }
  if (connection?.defaultDirectory) {
    stream.write(`cd ${connection.defaultDirectory}\n`)
  }
}

async function reattachTerminals(handle: ConnectionHandle): Promise<void> {
  for (const terminal of [...handle.terminals.values()]) {
    if (terminal.status === 'ready' && terminal.stream) continue
    try {
      await openShell(handle, terminal)
      injectNotice(terminal, 'reconnected')
      broadcastStatus(terminal.id, handle.connectionId, 'connected')
    } catch (err) {
      removeTerminal(handle, terminal)
      broadcastStatus(
        terminal.id,
        handle.connectionId,
        'error',
        `Shell error after reconnect: ${err instanceof Error ? err.message : String(err)}`
      )
      broadcastStatus(terminal.id, handle.connectionId, 'disconnected')
    }
  }
  if (handle.terminals.size === 0) scheduleLingerIfIdle(handle)
}

async function attemptReconnect(handle: ConnectionHandle): Promise<void> {
  clearReconnectTimer(handle)
  handle.connectPromise ??= doConnect(handle).finally(() => {
    handle.connectPromise = null
  })
  await handle.connectPromise
  await reattachTerminals(handle)
}

function giveUpReconnect(handle: ConnectionHandle): void {
  handle.state = 'failed'
  const error = handle.lastError ?? 'Reconnect failed'
  for (const terminal of [...handle.terminals.values()]) {
    broadcastStatus(terminal.id, handle.connectionId, 'error', error)
    broadcastStatus(terminal.id, handle.connectionId, 'disconnected')
    removeTerminal(handle, terminal)
  }
  disposeHandle(handle)
}

function scheduleReconnectAttempt(handle: ConnectionHandle): void {
  if (handle.state !== 'reconnecting') return
  if (handle.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    giveUpReconnect(handle)
    return
  }
  const delay =
    RECONNECT_DELAYS_MS[Math.min(handle.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)]
  handle.reconnectAttempts += 1
  clearReconnectTimer(handle)
  handle.reconnectTimer = setTimeout(() => {
    handle.reconnectTimer = null
    if (handle.state !== 'reconnecting') return
    attemptReconnect(handle).catch(() => {
      if (handle.state !== 'reconnecting') return
      scheduleReconnectAttempt(handle)
    })
  }, delay)
}

function beginReconnect(handle: ConnectionHandle): void {
  handle.state = 'reconnecting'
  handle.reconnectAttempts = 0
  for (const terminal of handle.terminals.values()) {
    terminal.stream = null
    terminal.status = 'starting'
    broadcastStatus(terminal.id, handle.connectionId, 'reconnecting', handle.lastError)
  }
  scheduleReconnectAttempt(handle)
}

async function ensureConnected(handle: ConnectionHandle): Promise<void> {
  if (handle.state === 'ready') return
  if (handle.state === 'closed' || handle.state === 'failed') {
    throw new Error(handle.lastError ?? 'Connection closed')
  }
  if (handle.state === 'reconnecting') {
    try {
      await attemptReconnect(handle)
    } catch (err) {
      if (handle.state === 'reconnecting') scheduleReconnectAttempt(handle)
      throw err
    }
    return
  }
  handle.connectPromise ??= doConnect(handle).finally(() => {
    handle.connectPromise = null
  })
  await handle.connectPromise
  if (currentState(handle) !== 'ready') {
    throw new Error(handle.lastError ?? 'Connection failed')
  }
}

function acquireHandle(connectionId: string): ConnectionHandle {
  let handle = handles.get(connectionId)
  if (!handle || handle.state === 'closed' || handle.state === 'failed') {
    handle = {
      connectionId,
      state: 'connecting',
      client: null,
      jumpClient: null,
      generation: 0,
      reconnectAttempts: 0,
      reconnectTimer: null,
      lingerTimer: null,
      connectPromise: null,
      terminals: new Map(),
      busyCount: 0,
      sftpPromise: null
    }
    handles.set(connectionId, handle)
  }
  clearLinger(handle)
  return handle
}

// ── Public API ──

export async function openSshTerminal(
  connectionId: string
): Promise<{ sessionId: string } | { error: string }> {
  if (!getConnectionWithSecrets(connectionId)) {
    return { error: 'Connection not found' }
  }

  const handle = acquireHandle(connectionId)

  const terminal: TerminalChannel = {
    id: `ssh-${nextTerminalId++}`,
    stream: null,
    status: 'starting',
    cols: 120,
    rows: 30,
    seq: 0,
    ring: [],
    ringBytes: 0
  }
  handle.terminals.set(terminal.id, terminal)
  terminalIndex.set(terminal.id, handle)
  broadcastStatus(terminal.id, connectionId, 'connecting')

  try {
    await ensureConnected(handle)
  } catch (err) {
    removeTerminal(handle, terminal)
    const message = handle.lastError ?? formatLayeredError(err)
    broadcastStatus(terminal.id, connectionId, 'error', message)
    if (handle.terminals.size === 0 && handle.state !== 'reconnecting') {
      disposeHandle(handle)
    }
    return { error: message }
  }

  try {
    await openShell(handle, terminal)
  } catch (err) {
    removeTerminal(handle, terminal)
    const message = `Shell error: ${err instanceof Error ? err.message : String(err)}`
    broadcastStatus(terminal.id, connectionId, 'error', message)
    scheduleLingerIfIdle(handle)
    return { error: message }
  }

  broadcastStatus(terminal.id, connectionId, 'connected')
  return { sessionId: terminal.id }
}

export function writeSshTerminal(terminalId: string, data: string): void {
  const handle = terminalIndex.get(terminalId)
  if (!handle || handle.state !== 'ready') return
  const terminal = handle.terminals.get(terminalId)
  if (terminal?.stream && terminal.status === 'ready') {
    terminal.stream.write(data)
  }
}

export function resizeSshTerminal(terminalId: string, cols: number, rows: number): void {
  const handle = terminalIndex.get(terminalId)
  const terminal = handle?.terminals.get(terminalId)
  if (!terminal) return
  terminal.cols = cols
  terminal.rows = rows
  if (terminal.stream && terminal.status === 'ready') {
    terminal.stream.setWindow(rows, cols, 0, 0)
  }
}

export function closeSshTerminal(terminalId: string): { success: true } | { error: string } {
  const handle = terminalIndex.get(terminalId)
  const terminal = handle?.terminals.get(terminalId)
  if (!handle || !terminal) return { error: 'Session not found' }
  removeTerminal(handle, terminal)
  broadcastStatus(terminalId, handle.connectionId, 'disconnected')
  scheduleLingerIfIdle(handle)
  return { success: true }
}

export function getSshTerminalBuffer(
  terminalId: string,
  sinceSeq = 0
): { lastSeq: number; chunks: string[] } | { error: string } {
  const handle = terminalIndex.get(terminalId)
  const terminal = handle?.terminals.get(terminalId)
  if (!terminal) return { error: 'Session not found' }
  return {
    lastSeq: terminal.seq,
    chunks: terminal.ring
      .filter((entry) => entry.seq > sinceSeq)
      .map((entry) => entry.data.toString('base64'))
  }
}

export function listSshTerminals(): {
  id: string
  connectionId: string
  status: TerminalWireStatus
  error?: string
}[] {
  const list: { id: string; connectionId: string; status: TerminalWireStatus; error?: string }[] =
    []
  for (const handle of handles.values()) {
    for (const terminal of handle.terminals.values()) {
      let status: TerminalWireStatus
      if (handle.state === 'reconnecting') status = 'reconnecting'
      else if (handle.state === 'ready' && terminal.status === 'ready') status = 'connected'
      else if (terminal.status === 'starting') status = 'connecting'
      else status = 'disconnected'
      list.push({
        id: terminal.id,
        connectionId: handle.connectionId,
        status,
        ...(handle.lastError ? { error: handle.lastError } : {})
      })
    }
  }
  return list
}

export function closeSshConnectionHandles(connectionId: string): void {
  const handle = handles.get(connectionId)
  if (!handle) return
  for (const terminal of [...handle.terminals.values()]) {
    removeTerminal(handle, terminal)
    broadcastStatus(terminal.id, connectionId, 'disconnected')
  }
  disposeHandle(handle)
}

export function closeAllSshConnections(): void {
  for (const connectionId of [...handles.keys()]) {
    closeSshConnectionHandles(connectionId)
  }
}

// Borrow the shared authenticated connection for a non-terminal operation
// (fs/exec). The borrow count keeps the handle out of linger teardown.
export async function withSshConnection<T>(
  connectionId: string,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  if (!getConnectionWithSecrets(connectionId)) {
    throw new Error('Connection not found')
  }
  const handle = acquireHandle(connectionId)
  handle.busyCount += 1
  try {
    await ensureConnected(handle)
    const client = handle.client
    if (!client) throw new Error(handle.lastError ?? 'Connection is not ready')
    return await fn(client)
  } finally {
    handle.busyCount -= 1
    scheduleLingerIfIdle(handle)
  }
}

// Borrow the handle's shared SFTP subsystem session (opened lazily, dropped
// with the client on disconnect/reconnect).
export async function withSshSftp<T>(
  connectionId: string,
  fn: (sftp: SFTPWrapper) => Promise<T>
): Promise<T> {
  return withSshConnection(connectionId, async (client) => {
    const handle = handles.get(connectionId)
    if (!handle) throw new Error('Connection is not ready')
    handle.sftpPromise ??= new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    }).catch((err) => {
      handle.sftpPromise = null
      throw err
    })
    const sftp = await handle.sftpPromise
    return fn(sftp)
  })
}
