import WebSocket from 'ws'

// Electron/Node SignalR puts the hub token on the WebSocket Authorization header.
// FastGateway and most reverse proxies drop those headers on upgrade. Browser
// clients put `access_token` on the query string instead; mirror that here.

export function appendAccessTokenQuery(url: string, token: string): string {
  if (!token || url.includes('access_token=')) return url
  return `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
}

export function createQueryAccessTokenWebSocket(getToken: () => string) {
  return class QueryAccessTokenWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[], options?: WebSocket.ClientOptions) {
      super(appendAccessTokenQuery(typeof url === 'string' ? url : url.toString(), getToken()), protocols, options)
    }
  }
}
