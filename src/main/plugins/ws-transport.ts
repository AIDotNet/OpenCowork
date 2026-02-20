import WebSocket from 'ws'

export interface WsTransportOptions {
  url: string
  onMessage: (raw: string) => void
  onStatusChange: (status: 'connected' | 'disconnected' | 'reconnecting') => void
  onError: (error: Error) => void
  reconnect?: boolean
  heartbeatIntervalMs?: number
}

/**
 * Abstract WebSocket transport with auto-reconnect.
 * Used by all plugin services to receive messages from a WS endpoint.
 */
export class WebSocketTransport {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectAttempt = 0
  private intentionalClose = false

  private readonly url: string
  private readonly onMessage: (raw: string) => void
  private readonly onStatusChange: (status: 'connected' | 'disconnected' | 'reconnecting') => void
  private readonly onError: (error: Error) => void
  private readonly shouldReconnect: boolean
  private readonly heartbeatIntervalMs: number

  private static readonly MAX_RECONNECT_DELAY = 30_000
  private static readonly BASE_RECONNECT_DELAY = 1_000

  constructor(options: WsTransportOptions) {
    this.url = options.url
    this.onMessage = options.onMessage
    this.onStatusChange = options.onStatusChange
    this.onError = options.onError
    this.shouldReconnect = options.reconnect ?? true
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000
  }

  connect(): void {
    this.intentionalClose = false
    this.doConnect()
  }

  disconnect(): void {
    this.intentionalClose = true
    this.cleanup()
    this.onStatusChange('disconnected')
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data)
    }
  }

  private doConnect(): void {
    try {
      this.ws = new WebSocket(this.url)

      this.ws.on('open', () => {
        this.reconnectAttempt = 0
        this.onStatusChange('connected')
        this.startHeartbeat()
        console.log(`[WsTransport] Connected to ${this.url}`)
      })

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const raw = typeof data === 'string' ? data : data.toString()
          this.onMessage(raw)
        } catch (err) {
          this.onError(err instanceof Error ? err : new Error(String(err)))
        }
      })

      this.ws.on('close', (code, reason) => {
        console.log(`[WsTransport] Closed: ${code} ${reason.toString()}`)
        this.stopHeartbeat()
        if (!this.intentionalClose && this.shouldReconnect) {
          this.scheduleReconnect()
        } else {
          this.onStatusChange('disconnected')
        }
      })

      this.ws.on('error', (err) => {
        console.error('[WsTransport] Error:', err.message)
        this.onError(err)
      })

      this.ws.on('pong', () => {
        // Heartbeat acknowledged
      })
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)))
      if (this.shouldReconnect) {
        this.scheduleReconnect()
      }
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      WebSocketTransport.BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempt),
      WebSocketTransport.MAX_RECONNECT_DELAY
    )
    this.reconnectAttempt++
    this.onStatusChange('reconnecting')
    console.log(`[WsTransport] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.doConnect()
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping()
      }
    }, this.heartbeatIntervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private cleanup(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.removeAllListeners()
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
      this.ws = null
    }
  }
}
