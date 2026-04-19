import type { ChatView } from '@renderer/stores/ui-store'

export interface ChatRouteState {
  chatView: ChatView
  projectId: string | null
  sessionId: string | null
}

const DEFAULT_ROUTE: ChatRouteState = {
  chatView: 'home',
  projectId: null,
  sessionId: null
}

function normalizeHash(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const path = raw.trim()
  if (!path || path === '/') return '/'
  return path.startsWith('/') ? path : `/${path}`
}

export function parseChatRoute(hash: string): ChatRouteState {
  const normalized = normalizeHash(hash)
  if (normalized === '/' || normalized === '/home') return DEFAULT_ROUTE

  const segments = normalized.split('/').filter(Boolean)
  if (segments[0] === 'chat') {
    const sessionId = decodeURIComponent(segments[1] ?? '') || null
    return {
      chatView: sessionId ? 'session' : 'home',
      projectId: null,
      sessionId
    }
  }

  if (segments[0] !== 'project') return DEFAULT_ROUTE

  const projectId = decodeURIComponent(segments[1] ?? '') || null
  if (!projectId) return DEFAULT_ROUTE

  if (segments[2] === 'session') {
    const sessionId = decodeURIComponent(segments[3] ?? '') || null
    return {
      chatView: sessionId ? 'session' : 'project',
      projectId,
      sessionId
    }
  }

  if (segments[2] === 'archive') {
    return { chatView: 'archive', projectId, sessionId: null }
  }

  if (segments[2] === 'channels') {
    return { chatView: 'channels', projectId, sessionId: null }
  }

  if (segments[2] === 'git') {
    return { chatView: 'git', projectId, sessionId: null }
  }

  return { chatView: 'project', projectId, sessionId: null }
}

export function buildChatRoute(state: ChatRouteState): string {
  if (state.chatView === 'session' && state.sessionId && !state.projectId) {
    return `#/chat/${encodeURIComponent(state.sessionId)}`
  }

  if (state.chatView === 'home' || !state.projectId) return '#/'

  const encodedProjectId = encodeURIComponent(state.projectId)

  if (state.chatView === 'session' && state.sessionId) {
    return `#/project/${encodedProjectId}/session/${encodeURIComponent(state.sessionId)}`
  }

  if (state.chatView === 'archive') return `#/project/${encodedProjectId}/archive`
  if (state.chatView === 'channels') return `#/project/${encodedProjectId}/channels`
  if (state.chatView === 'git') return `#/project/${encodedProjectId}/git`

  return `#/project/${encodedProjectId}`
}

export function replaceChatRoute(state: ChatRouteState): void {
  const nextHash = buildChatRoute(state)
  if (window.location.hash === nextHash) return
  window.history.replaceState(null, '', nextHash)
}
