import type {
  MessagingPluginService,
  PluginInstance,
  PluginEvent,
  PluginMessage,
  PluginGroup,
  WsMessageParser,
} from './plugin-types'
import { WebSocketTransport } from './ws-transport'

/**
 * Abstract base class for all plugin services.
 * Handles WebSocket lifecycle, parser wiring, and event emission.
 * Subclasses implement API methods and provide a message parser.
 */
export abstract class BasePluginService implements MessagingPluginService {
  readonly pluginId: string
  abstract readonly pluginType: string

  protected _instance: PluginInstance
  private _notify: (event: PluginEvent) => void
  private ws: WebSocketTransport | null = null
  private _running = false
  private _parser: WsMessageParser | null = null

  constructor(instance: PluginInstance, notify: (event: PluginEvent) => void) {
    this._instance = instance
    this._notify = notify
    this.pluginId = instance.id
  }

  get instance(): PluginInstance {
    return this._instance
  }

  /** Set the WS message parser (called by PluginManager before start) */
  setParser(parser: WsMessageParser): void {
    this._parser = parser
  }

  /** Emit a plugin event to the renderer */
  protected emit(event: PluginEvent): void {
    this._notify(event)
  }

  /** Subclass hook: validate config and initialize API client. Throw on error. */
  protected abstract onStart(): Promise<void>

  /** Subclass hook: cleanup on stop (optional) */
  protected onStop(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Resolve the WebSocket URL to connect to.
   * Subclasses with built-in WS endpoints should override this.
   * Default: returns user-configured wsUrl from config, or null.
   */
  protected async resolveWsUrl(): Promise<string | null> {
    return this._instance.config.wsUrl || null
  }

  async start(): Promise<void> {
    // Subclass validation + API init
    await this.onStart()
    this._running = true

    // Start WebSocket if URL available (built-in or user-configured)
    const wsUrl = await this.resolveWsUrl()
    if (wsUrl) {
      this.ws = new WebSocketTransport({
        url: wsUrl,
        onMessage: (raw) => this.handleWsMessage(raw),
        onStatusChange: (status) => {
          console.log(`[${this.pluginType}:${this.pluginId}] WS status: ${status}`)
          if (status === 'disconnected' && this._running) {
            // WS disconnected while service is running
            this.emit({
              type: 'status_change',
              pluginId: this.pluginId,
              pluginType: this.pluginType,
              data: 'running', // service still running, just WS reconnecting
            })
          }
        },
        onError: (err) => {
          console.error(`[${this.pluginType}:${this.pluginId}] WS error:`, err.message)
          this.emit({
            type: 'error',
            pluginId: this.pluginId,
            pluginType: this.pluginType,
            data: err.message,
          })
        },
      })
      this.ws.connect()
    }

    console.log(`[${this.pluginType}] Started for plugin ${this.pluginId}`)
  }

  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.disconnect()
      this.ws = null
    }
    await this.onStop()
    this._running = false
    console.log(`[${this.pluginType}] Stopped for plugin ${this.pluginId}`)
  }

  isRunning(): boolean {
    return this._running
  }

  /** Filter out messages older than 15 minutes to avoid processing stale messages */
  private isMessageFresh(timestamp?: number): boolean {
    if (!timestamp) return true // No timestamp, assume fresh
    const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000
    return timestamp >= fifteenMinutesAgo
  }

  private handleWsMessage(raw: string): void {
    if (!this._parser) {
      console.warn(`[${this.pluginType}:${this.pluginId}] No parser set, ignoring WS message`)
      return
    }

    const parsed = this._parser(raw)
    if (!parsed) return

    // Filter out stale messages (> 15 minutes old)
    if (!this.isMessageFresh(parsed.timestamp)) {
      console.log(
        `[${this.pluginType}:${this.pluginId}] Ignoring stale message from ${new Date(parsed.timestamp!).toISOString()}`
      )
      return
    }

    this.emit({
      type: 'incoming_message',
      pluginId: this.pluginId,
      pluginType: this.pluginType,
      data: parsed,
    })
  }

  // ── Abstract API methods — subclasses must implement ──

  abstract sendMessage(chatId: string, content: string): Promise<{ messageId: string }>
  abstract replyMessage(messageId: string, content: string): Promise<{ messageId: string }>
  abstract getGroupMessages(chatId: string, count?: number): Promise<PluginMessage[]>
  abstract listGroups(): Promise<PluginGroup[]>
}
