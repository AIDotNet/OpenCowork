import { app } from 'electron'
import { randomUUID } from 'crypto'
import { hostname, platform } from 'os'
import {
  HttpTransportType,
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel
} from '@microsoft/signalr'
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack'
import {
  REMOTE_CONTROL_INITIAL_STATE,
  encodeRemotePayload,
  normalizeRemoteControlApiBaseUrl,
  type RemoteControlState,
  type RemoteEnvelope,
  type RemoteMobileConnection,
  type RemoteRendererEvent
} from '../../shared/remote-control'
import {
  clearRemoteControlAccessToken,
  getValidRemoteControlAccessToken
} from '../account/remote-token'
import { readSyncConfig, writeSyncConfig } from '../sync/sync-config'
import { readConfig, writeConfig } from '../ipc/secure-key-store'
import { ChunkReassembler, splitEnvelope } from './envelope-codec'
import { createQueryAccessTokenWebSocket } from './signalr-access-token-websocket'
import {
  dispatchRendererEvent as dispatchRouterEvent,
  routeRemoteRequest,
  setRemoteControlRelay,
  setRemoteTerminalWriteEnabled
} from './request-router'
import { safeSendMessagePackToAllWindows } from '../window-ipc'

let connection: HubConnection | null = null
let connecting: Promise<void> | null = null
let deviceId: string | null = null
let state: RemoteControlState = { ...REMOTE_CONTROL_INITIAL_STATE }
const reassembler = new ChunkReassembler()
const stateListeners = new Set<(next: RemoteControlState) => void>()
const TERMINAL_WRITE_CONFIG_KEY = 'remoteControlTerminalWriteEnabled'
const GIT_WRITE_CONFIG_KEY = 'remoteControlGitWriteEnabled'
const API_BASE_URL_CONFIG_KEY = 'remoteControlApiBaseUrl'
let settingsLoaded = false
let connectedApiBaseUrl: string | null = null

async function persistConfig(patch: Record<string, unknown>): Promise<void> {
  const root = await readConfig()
  await writeConfig({ ...root, ...patch })
}

async function loadSettings(): Promise<void> {
  if (settingsLoaded) return
  const config = await readConfig()
  const writeValue = config[TERMINAL_WRITE_CONFIG_KEY]
  const enabled = typeof writeValue === 'boolean' ? writeValue : true
  const gitValue = config[GIT_WRITE_CONFIG_KEY]
  // Off unless it was explicitly turned on: committing is the one remote action
  // that writes to the repository.
  const gitEnabled = gitValue === true
  const apiBaseUrl = normalizeRemoteControlApiBaseUrl(
    typeof config[API_BASE_URL_CONFIG_KEY] === 'string' ? config[API_BASE_URL_CONFIG_KEY] : null
  )
  settingsLoaded = true
  setRemoteTerminalWriteEnabled(enabled)
  state = { ...state, terminalWriteEnabled: enabled, gitWriteEnabled: gitEnabled, apiBaseUrl }
}

async function persistApiBaseUrl(apiBaseUrl: string): Promise<void> {
  emitState({ apiBaseUrl })
  await persistConfig({ [API_BASE_URL_CONFIG_KEY]: apiBaseUrl })
}

type DesktopRegistration = {
  PairingCode?: string
  pairingCode?: string
  RemoteUrl?: string
  remoteUrl?: string
  Rotated?: boolean
  rotated?: boolean
}

type MobileAttachedPayload = {
  MobileId?: string
  mobileId?: string
  UserAgent?: string
  userAgent?: string
  IpAddress?: string
  ipAddress?: string
  AttachedAtMs?: number
  attachedAtMs?: number
}

function emitState(next: Partial<RemoteControlState>): void {
  state = { ...state, ...next }
  safeSendMessagePackToAllWindows('remote-control:changed', state)
  stateListeners.forEach((listener) => listener(state))
}

function normalizeMobile(value: MobileAttachedPayload): RemoteMobileConnection {
  return {
    mobileId: value.MobileId ?? value.mobileId ?? '',
    userAgent: value.UserAgent ?? value.userAgent ?? '',
    ipAddress: value.IpAddress ?? value.ipAddress ?? '',
    attachedAtMs: value.AttachedAtMs ?? value.attachedAtMs ?? Date.now()
  }
}

async function registerDesktop(): Promise<void> {
  if (!connection || !deviceId) return
  const registration = await connection.invoke<DesktopRegistration>('RegisterDesktop', {
    DeviceId: deviceId,
    DeviceName: hostname(),
    Platform: platform(),
    AppVersion: app.getVersion()
  })
  const pairingCode = registration.PairingCode ?? registration.pairingCode ?? null
  const remoteUrl = registration.RemoteUrl ?? registration.remoteUrl ?? null
  emitState({
    pairingCode,
    remoteUrl,
    enabled: true,
    phase: 'online',
    deviceName: hostname(),
    error: null,
    ...(registration.Rotated || registration.rotated ? { pairingRotatedAt: Date.now() } : {})
  })
}

function installHandlers(conn: HubConnection): void {
  conn.on('Relay', (envelope: RemoteEnvelope) => {
    const payload = reassembler.push(envelope)
    if (!payload) return
    if (envelope.Kind === 'req') void routeRemoteRequest({ ...envelope, Payload: payload }, relay)
  })
  conn.on('MobileAttached', (mobile: MobileAttachedPayload) => {
    const next = normalizeMobile(mobile)
    emitState({
      mobiles: [...state.mobiles.filter((item) => item.mobileId !== next.mobileId), next]
    })
  })
  conn.on('MobileDetached', (mobile: string) => {
    emitState({ mobiles: state.mobiles.filter((item) => item.mobileId !== mobile) })
  })
  conn.on('PairingRotated', (pairingCode: string) => {
    emitState({ pairingCode, pairingRotatedAt: Date.now() })
  })
  conn.onreconnecting((error) =>
    emitState({ phase: 'reconnecting', error: error?.message ?? null })
  )
  conn.onreconnected(() => {
    emitState({ phase: 'connecting' })
    void registerDesktop().catch((error) => emitState({ phase: 'error', error: String(error) }))
  })
  conn.onclose((error) => {
    if (connection === conn)
      emitState({ phase: 'disabled', enabled: false, error: error?.message ?? null })
  })
}

async function relay(envelope: RemoteEnvelope): Promise<void> {
  if (!connection || connection.state !== HubConnectionState.Connected) return
  const chunks = splitEnvelope(
    envelope.Id,
    envelope.Kind,
    envelope.Op,
    envelope.MobileId,
    envelope.Payload
  )
  for (const chunk of chunks) await connection.invoke('RelayToMobile', chunk)
}

export async function startRemoteControl(input?: {
  apiBaseUrl?: string
}): Promise<RemoteControlState> {
  await loadSettings()
  if (input?.apiBaseUrl !== undefined) {
    const apiBaseUrl = normalizeRemoteControlApiBaseUrl(input.apiBaseUrl)
    if (apiBaseUrl !== state.apiBaseUrl) await persistApiBaseUrl(apiBaseUrl)
  }
  if (connecting) {
    await connecting
    if (
      connection?.state === HubConnectionState.Connected &&
      connectedApiBaseUrl === state.apiBaseUrl
    ) {
      return state
    }
  }
  if (connection) {
    if (
      connection.state === HubConnectionState.Connected &&
      connectedApiBaseUrl === state.apiBaseUrl
    ) {
      return state
    }
    await stopRemoteControl()
  }
  connecting = (async () => {
    const apiBaseUrl = state.apiBaseUrl
    const token = await getValidRemoteControlAccessToken(apiBaseUrl)
    if (!token) {
      emitState({ phase: 'disabled', enabled: false, error: null })
      return
    }
    const config = await readSyncConfig()
    // readSyncConfig supplies an in-memory UUID when the persisted config is absent;
    // write it back on startup so the device identity survives the next restart.
    const persisted = await writeSyncConfig(config)
    deviceId = persisted.deviceId
    emitState({ phase: 'connecting', deviceId, deviceName: hostname() })
    let hubToken = token
    const hubOptions = {
      accessTokenFactory: async () => {
        hubToken = (await getValidRemoteControlAccessToken(apiBaseUrl)) ?? ''
        return hubToken
      },
      // Node WebSocket upgrades often lose Authorization headers at the proxy.
      // Skip negotiate so the socket does not depend on sticky sessions, and
      // put the token on the query string the same way the browser client does.
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
      WebSocket: createQueryAccessTokenWebSocket(() => hubToken)
    }
    const conn = new HubConnectionBuilder()
      .withUrl(`${apiBaseUrl}/hubs/remote-control`, hubOptions)
      .withHubProtocol(new MessagePackHubProtocol())
      .withAutomaticReconnect([0, 1000, 2000, 5000, 10000, 15000, 30000])
      .configureLogging(LogLevel.Warning)
      .build()
    conn.keepAliveIntervalInMilliseconds = 15_000
    conn.serverTimeoutInMilliseconds = 40_000
    connection = conn
    connectedApiBaseUrl = apiBaseUrl
    installHandlers(conn)
    setRemoteControlRelay(relay)
    setRemoteTerminalWriteEnabled(state.terminalWriteEnabled)
    await conn.start()
    await registerDesktop()
  })()
  try {
    await connecting
  } catch (error) {
    connectedApiBaseUrl = null
    emitState({
      phase: 'error',
      enabled: false,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    connecting = null
  }
  return state
}

export async function stopRemoteControl(): Promise<void> {
  const conn = connection
  const { apiBaseUrl, terminalWriteEnabled } = state
  connection = null
  connectedApiBaseUrl = null
  clearRemoteControlAccessToken()
  setRemoteControlRelay(null)
  reassembler.dispose()
  if (conn) await conn.stop().catch(() => undefined)
  emitState({ ...REMOTE_CONTROL_INITIAL_STATE, deviceId, apiBaseUrl, terminalWriteEnabled })
}

export async function setApiBaseUrl(value: string): Promise<RemoteControlState> {
  await loadSettings()
  const apiBaseUrl = normalizeRemoteControlApiBaseUrl(value)
  if (apiBaseUrl === state.apiBaseUrl) return state
  await persistApiBaseUrl(apiBaseUrl)
  if (connecting) await connecting
  if (connection) {
    if (connection.state === HubConnectionState.Connected && connectedApiBaseUrl === apiBaseUrl) {
      return state
    }
    await stopRemoteControl()
    return startRemoteControl()
  }
  return state
}

export async function rotatePairingCode(): Promise<RemoteControlState> {
  if (!connection) return state
  const pairingCode = await connection.invoke<string>('RotatePairingCode')
  emitState({ pairingCode, pairingRotatedAt: Date.now() })
  return state
}

export async function disconnectMobile(id: string): Promise<{ success: true } | { error: string }> {
  if (!connection) return { error: 'Remote control is offline' }
  await connection.invoke('DisconnectMobile', id)
  emitState({ mobiles: state.mobiles.filter((mobile) => mobile.mobileId !== id) })
  return { success: true }
}

export async function disconnectAllMobiles(): Promise<{ success: true } | { error: string }> {
  if (!connection) return { error: 'Remote control is offline' }
  await connection.invoke('DisconnectAllMobiles')
  emitState({ mobiles: [] })
  return { success: true }
}

/** Phones read capabilities as one object, so both flags travel together. */
function broadcastCapabilities(): void {
  if (connection?.state !== HubConnectionState.Connected) return
  void relay({
    Id: randomUUID(),
    Kind: 'evt',
    Op: 'evt.capabilities',
    MobileId: null,
    Seq: 0,
    Total: 1,
    Payload: encodeRemotePayload({
      terminalWriteEnabled: state.terminalWriteEnabled,
      gitWriteEnabled: state.gitWriteEnabled
    })
  })
}

export function setTerminalWriteEnabled(enabled: boolean): RemoteControlState {
  settingsLoaded = true
  setRemoteTerminalWriteEnabled(enabled)
  emitState({ terminalWriteEnabled: enabled })
  void persistConfig({ [TERMINAL_WRITE_CONFIG_KEY]: enabled })
  broadcastCapabilities()
  return state
}

export function setGitWriteEnabled(enabled: boolean): RemoteControlState {
  settingsLoaded = true
  emitState({ gitWriteEnabled: enabled })
  void persistConfig({ [GIT_WRITE_CONFIG_KEY]: enabled })
  broadcastCapabilities()
  return state
}

export async function getRemoteControlState(): Promise<RemoteControlState> {
  await loadSettings()
  return state
}

export async function sendRemoteEvent(op: string, payload: unknown): Promise<void> {
  await relay({
    Id: randomUUID(),
    Kind: 'evt',
    Op: op,
    MobileId: null,
    Seq: 0,
    Total: 1,
    Payload: encodeRemotePayload(payload)
  })
}

export async function disposeRemoteControl(): Promise<void> {
  await stopRemoteControl()
  stateListeners.clear()
}

export function onRemoteControlStateChanged(
  listener: (next: RemoteControlState) => void
): () => void {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

/**
 * Blocking inbox items already seen, so a phone is only woken for something new.
 * Keyed by item id; the desktop sends the whole list on every change.
 */
const pushedInboxIds = new Set<string>()

/**
 * Asks the server to wake a phone that is not attached.
 *
 * The server never reads relay payloads — they are opaque to it by contract — so the
 * decision of *whether* something is worth a notification is made here, where the
 * inbox is already understood, and sent as an explicit request.
 */
function maybeRequestPush(event: RemoteRendererEvent): void {
  if (event.op !== 'evt.inbox.changed') return
  if (connection?.state !== HubConnectionState.Connected) return

  const payload = event.payload as { inbox?: Array<Record<string, unknown>> } | undefined
  const blocking = (payload?.inbox ?? []).filter(
    (item) => item.type === 'approval' || item.type === 'ask_user'
  )
  const live = new Set(blocking.map((item) => String(item.id)))
  for (const id of pushedInboxIds) if (!live.has(id)) pushedInboxIds.delete(id)

  const fresh = blocking.filter((item) => !pushedInboxIds.has(String(item.id)))
  if (fresh.length === 0) return
  for (const item of fresh) pushedInboxIds.add(String(item.id))

  const first = fresh[0]
  const session = typeof first.sessionTitle === 'string' ? first.sessionTitle : '会话'
  const body =
    first.type === 'approval'
      ? `${session} 需要批准 ${String(first.title ?? '')}`.trim()
      : `${session} 在等你回答`
  void connection
    .invoke('RequestPush', {
      Title: 'OpenCowork',
      Body: fresh.length > 1 ? `${body}（共 ${fresh.length} 项）` : body
    })
    .catch(() => {
      // Push is best effort; an older server without the method must not break relaying.
    })
}

export function dispatchRendererEvent(event: RemoteRendererEvent): void {
  maybeRequestPush(event)
  dispatchRouterEvent(event)
}
