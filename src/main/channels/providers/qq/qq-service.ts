import WebSocket from 'ws'
import type {
  ChannelEvent,
  ChannelGroup,
  ChannelInstance,
  ChannelMessage,
  MessagingChannelService
} from '../../channel-types'
import { QQApi, parseQQChatId } from './qq-api'
import { decodeQQReplyReference, parseQQWsMessage } from './parse-ws-message'
import { clearSession, loadSession, saveSession } from './session-store'

interface QQGatewayPayload {
  op?: number
  d?: unknown
  s?: number
  t?: string
}

const INTENTS = {
  GUILD_MEMBERS: 1 << 1,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
  PUBLIC_GUILD_MESSAGES: 1 << 30
}

const INTENT_LEVELS = [
  {
    name: 'full',
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C,
    description: '群聊 + C2C + 频道私信 + 频道消息'
  },
  {
    name: 'group-channel',
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C,
    description: '群聊 + C2C + 频道消息'
  },
  {
    name: 'channel-only',
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GUILD_MEMBERS,
    description: '仅频道消息'
  }
] as const

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000]
const INVALID_SESSION_RECONNECT_DELAY = 3000

function parseBooleanConfig(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim())
}

export class QQService implements MessagingChannelService {
  readonly pluginId: string
  readonly pluginType = 'qq-bot'

  private readonly instance: ChannelInstance
  private readonly notify: (event: ChannelEvent) => void
  private api!: QQApi
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private intentionalClose = false
  private reconnectAttempt = 0
  private intentLevelIndex = 0
  private lastSuccessfulIntentLevel = -1
  private lastSeq: number | null = null
  private sessionId: string | null = null
  private isConnecting = false
  private shouldRefreshToken = false

  constructor(instance: ChannelInstance, notify: (event: ChannelEvent) => void) {
    this.instance = instance
    this.notify = notify
    this.pluginId = instance.id
  }

  async start(): Promise<void> {
    if (this.running) return

    const { appId, clientSecret } = this.instance.config
    if (!appId || !clientSecret) {
      throw new Error('Missing required config: App ID and Client Secret must be provided')
    }

    const useSandbox = parseBooleanConfig(this.instance.config.useSandbox)
    const markdownSupport =
      !this.instance.config.markdownSupport ||
      parseBooleanConfig(this.instance.config.markdownSupport)
    this.api = new QQApi(appId, clientSecret, { useSandbox, markdownSupport })
    console.log(
      `[qq-bot:${this.pluginId}] Using QQ ${useSandbox ? 'sandbox' : 'production'} API domain, markdown=${markdownSupport}`
    )
    this.restoreSession()
    await this.api.validate()

    this.intentionalClose = false
    this.running = true
    this.emitStatus('starting')
    await this.connectGateway()
    console.log(`[qq-bot] Started for plugin ${this.pluginId}`)
  }

  async stop(): Promise<void> {
    this.intentionalClose = true
    this.running = false
    this.isConnecting = false
    this.clearReconnectTimer()
    this.stopHeartbeat()
    this.closeSocket()
    this.emitStatus('stopped')
    console.log(`[qq-bot] Stopped for plugin ${this.pluginId}`)
  }

  isRunning(): boolean {
    return this.running
  }

  async sendMessage(chatId: string, content: string): Promise<{ messageId: string }> {
    return this.api.sendMessage(parseQQChatId(chatId), content)
  }

  async replyMessage(messageId: string, content: string): Promise<{ messageId: string }> {
    const replyRef = decodeQQReplyReference(messageId)
    if (!replyRef) {
      throw new Error('QQ reply requires a valid QQ incoming message reference')
    }
    return this.api.sendMessage(parseQQChatId(replyRef.chatId), content, replyRef.messageId)
  }

  async getGroupMessages(chatId: string, count?: number): Promise<ChannelMessage[]> {
    void chatId
    void count
    return []
  }

  async listGroups(): Promise<ChannelGroup[]> {
    return []
  }

  private emit(type: ChannelEvent['type'], data: unknown): void {
    this.notify({
      type,
      pluginId: this.pluginId,
      pluginType: this.pluginType,
      data
    })
  }

  private emitStatus(state: string, _extra?: Record<string, unknown>): void {
    const normalized = state === 'error' ? 'error' : state === 'stopped' ? 'stopped' : 'running'
    this.emit('status_change', normalized)
  }

  private getSessionStoreKey(): string {
    return this.pluginId
  }

  private restoreSession(): void {
    const saved = loadSession(this.getSessionStoreKey())
    if (!saved) return

    this.sessionId = saved.sessionId
    this.lastSeq = saved.lastSeq
    this.intentLevelIndex = saved.intentLevelIndex
    this.lastSuccessfulIntentLevel = saved.intentLevelIndex

    console.log(
      `[qq-bot:${this.pluginId}] Restored session: sessionId=${saved.sessionId}, lastSeq=${saved.lastSeq}, intentLevel=${saved.intentLevelIndex}`
    )
  }

  private persistSession(): void {
    if (!this.sessionId || this.lastSeq == null) return

    saveSession({
      sessionId: this.sessionId,
      lastSeq: this.lastSeq,
      lastConnectedAt: Date.now(),
      intentLevelIndex:
        this.lastSuccessfulIntentLevel >= 0
          ? this.lastSuccessfulIntentLevel
          : this.intentLevelIndex,
      accountId: this.getSessionStoreKey(),
      savedAt: Date.now()
    })
  }

  private async connectGateway(): Promise<void> {
    if (!this.running || this.isConnecting) return
    this.isConnecting = true

    try {
      if (this.shouldRefreshToken) {
        this.api.clearTokenCache()
        this.shouldRefreshToken = false
      }

      const gatewayUrl = await this.api.getGatewayUrl()
      if (!this.running) return

      console.log(`[qq-bot:${this.pluginId}] Connecting to ${gatewayUrl}`)

      this.closeSocket()

      const ws = new WebSocket(gatewayUrl)
      this.ws = ws

      ws.on('open', () => {
        this.reconnectAttempt = 0
        console.log(`[qq-bot:${this.pluginId}] Gateway connected`)
        this.emitStatus('connected')
      })

      ws.on('message', (data: WebSocket.RawData) => {
        const raw = typeof data === 'string' ? data : data.toString()
        void this.handleGatewayMessage(raw).catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[qq-bot:${this.pluginId}] Gateway message handler error:`, error)
          this.emit('error', message)
          this.emitStatus('error', { message })
          this.forceReconnect(false)
        })
      })

      ws.on('close', (code, reason) => {
        if (this.ws === ws) {
          this.ws = null
        }
        this.stopHeartbeat()
        console.log(`[qq-bot:${this.pluginId}] Gateway closed: ${code} ${reason.toString()}`)
        if (this.running && !this.intentionalClose) {
          this.emitStatus('reconnecting', { code, reason: reason.toString() })
          this.scheduleReconnect()
        }
      })

      ws.on('error', (error) => {
        console.error(`[qq-bot:${this.pluginId}] Gateway error: ${error.message}`)
        this.emit('error', error.message)
        this.emitStatus('error', { message: error.message })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[qq-bot:${this.pluginId}] Connect gateway failed: ${message}`)
      this.emit('error', message)
      this.emitStatus('error', { message })
      if (this.running && !this.intentionalClose) {
        this.scheduleReconnect()
      }
    } finally {
      this.isConnecting = false
    }
  }

  private async handleGatewayMessage(raw: string): Promise<void> {
    let payload: QQGatewayPayload
    try {
      payload = JSON.parse(raw) as QQGatewayPayload
    } catch {
      return
    }

    if (typeof payload.s === 'number') {
      this.lastSeq = payload.s
      if (this.sessionId) {
        this.persistSession()
      }
    }

    if (payload.op !== 11) {
      console.log(
        `[qq-bot:${this.pluginId}] Received gateway frame op=${String(payload.op)} t=${payload.t ?? 'unknown'}`
      )
    }

    switch (payload.op) {
      case 10:
        await this.handleHello(payload)
        return
      case 11:
        return
      case 7:
        console.warn(`[qq-bot:${this.pluginId}] Gateway requested reconnect`)
        this.forceReconnect(false)
        return
      case 9: {
        const canResume = payload.d === true
        const currentLevel =
          INTENT_LEVELS[Math.min(this.intentLevelIndex, INTENT_LEVELS.length - 1)]
        const message = `QQ gateway invalid session: ${currentLevel.description}`

        console.error(
          `[qq-bot:${this.pluginId}] Invalid session at intent level ${currentLevel.name} (${currentLevel.description}), canResume=${String(canResume)}`
        )
        this.emit('error', message)
        this.emitStatus('error', {
          message,
          intentLevel: currentLevel.name,
          canResume
        })

        if (!canResume) {
          this.sessionId = null
          this.lastSeq = null
          clearSession(this.getSessionStoreKey())

          if (this.intentLevelIndex < INTENT_LEVELS.length - 1) {
            this.intentLevelIndex += 1
            const nextLevel = INTENT_LEVELS[this.intentLevelIndex]
            console.warn(
              `[qq-bot:${this.pluginId}] Downgrading intents to ${nextLevel.name} (${nextLevel.description})`
            )
          } else {
            console.error(
              `[qq-bot:${this.pluginId}] All intent levels failed, token will be refreshed on next reconnect`
            )
            this.shouldRefreshToken = true
          }
        }

        this.forceReconnect(!canResume, INVALID_SESSION_RECONNECT_DELAY)
        return
      }
      case 0:
        if (payload.t === 'READY') {
          const ready = (payload.d ?? {}) as { session_id?: string }
          if (ready.session_id) {
            this.sessionId = ready.session_id
          }
          this.lastSuccessfulIntentLevel = this.intentLevelIndex
          this.persistSession()

          const currentLevel =
            INTENT_LEVELS[Math.min(this.intentLevelIndex, INTENT_LEVELS.length - 1)]
          console.log(
            `[qq-bot:${this.pluginId}] READY with intents ${currentLevel.name} (${currentLevel.description})`
          )
          this.emitStatus('ready', {
            intents: currentLevel.name,
            description: currentLevel.description
          })
          return
        }

        if (payload.t === 'RESUMED') {
          console.log(`[qq-bot:${this.pluginId}] Gateway session resumed`)
          this.persistSession()
          this.emitStatus('resumed')
          return
        }

        console.log(`[qq-bot:${this.pluginId}] Dispatch event: ${payload.t ?? 'unknown'}`)
        break
      default:
        return
    }

    const parsed = parseQQWsMessage(raw)
    if (!parsed) {
      if (payload.op === 0 && payload.t) {
        console.warn(`[qq-bot:${this.pluginId}] Ignored dispatch event: ${payload.t}`)
      }
      return
    }

    this.emit('incoming_message', parsed)
  }

  private async handleHello(payload: QQGatewayPayload): Promise<void> {
    const hello = (payload.d ?? {}) as { heartbeat_interval?: number }
    const intervalMs = hello.heartbeat_interval
    if (!intervalMs) {
      throw new Error('QQ gateway hello payload missing heartbeat_interval')
    }

    this.startHeartbeat(intervalMs)

    const accessToken = await this.api.getGatewayAccessToken()

    if (this.sessionId && this.lastSeq != null) {
      console.log(`[qq-bot:${this.pluginId}] Resuming session ${this.sessionId}`)
      this.emitStatus('resuming')
      this.sendJson({
        op: 6,
        d: {
          token: `QQBot ${accessToken}`,
          session_id: this.sessionId,
          seq: this.lastSeq
        }
      })
      return
    }

    const levelToUse =
      this.lastSuccessfulIntentLevel >= 0 ? this.lastSuccessfulIntentLevel : this.intentLevelIndex
    const intentLevel = INTENT_LEVELS[Math.min(levelToUse, INTENT_LEVELS.length - 1)]

    console.log(
      `[qq-bot:${this.pluginId}] Sending Identify with intents ${intentLevel.name} (${intentLevel.description})`
    )
    this.emitStatus('identifying', {
      intents: intentLevel.name,
      description: intentLevel.description
    })

    this.sendJson({
      op: 2,
      d: {
        token: `QQBot ${accessToken}`,
        intents: intentLevel.intents,
        shard: [0, 1]
      }
    })
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.sendJson({ op: 1, d: this.lastSeq })
    }, intervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  private forceReconnect(resetSession: boolean, customDelay?: number): void {
    if (resetSession) {
      this.sessionId = null
      this.lastSeq = null
    }

    this.stopHeartbeat()

    if (customDelay != null) {
      this.scheduleReconnect(customDelay)
    }

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      this.ws.close()
      return
    }

    if (customDelay == null && this.running && !this.intentionalClose) {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(customDelay?: number): void {
    if (this.reconnectTimer || !this.running || this.intentionalClose) {
      return
    }

    const delay =
      customDelay ?? RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    this.reconnectAttempt += 1

    console.warn(
      `[qq-bot:${this.pluginId}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connectGateway()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private closeSocket(): void {
    if (!this.ws) return

    const ws = this.ws
    this.ws = null
    ws.removeAllListeners()

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  }
}

export function createQQService(
  instance: ChannelInstance,
  notify: (event: ChannelEvent) => void
): MessagingChannelService {
  return new QQService(instance, notify)
}
