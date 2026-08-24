export type UriScheme =
  | 'file'
  | 'agent-diff'
  | 'git-diff'
  | 'term'
  | 'webview'
  | 'extension'
  | 'subagent'
  | 'review'
  | 'changes'

export interface ResourceUri {
  scheme: UriScheme
  authority?: string
  path: string
  query?: Record<string, string>
  fragment?: string
}

export function formatResourceUri(uri: ResourceUri): string {
  const queryStr = uri.query
    ? `?${Object.entries(uri.query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')}`
    : ''
  const fragStr = uri.fragment ? `#${encodeURIComponent(uri.fragment)}` : ''
  const authority = uri.authority ? `//${uri.authority}` : ''
  return `${uri.scheme}:${authority}${uri.path}${queryStr}${fragStr}`
}

export function parseResourceUri(uriStr: string): ResourceUri {
  const match = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(
    uriStr
  )
  if (!match) {
    return {
      scheme: 'file',
      path: uriStr
    }
  }

  const scheme = match[1].toLowerCase() as UriScheme
  const authority = match[2] || undefined
  const path = match[3] || ''
  let query: Record<string, string> | undefined
  if (match[4]) {
    query = {}
    const pairs = match[4].split('&')
    for (const pair of pairs) {
      const [k, v] = pair.split('=')
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '')
    }
  }
  const fragment = match[5] ? decodeURIComponent(match[5]) : undefined

  return {
    scheme,
    authority,
    path,
    query,
    fragment
  }
}

export function createFileUri(filePath: string): ResourceUri {
  const normalized = filePath.replace(/\\/g, '/')
  return {
    scheme: 'file',
    path: normalized.startsWith('/') ? normalized : `/${normalized}`
  }
}

export function createAgentDiffUri(
  sessionId: string,
  turnId: string,
  filePath: string
): ResourceUri {
  return {
    scheme: 'agent-diff',
    authority: sessionId,
    path: filePath.startsWith('/') ? filePath : `/${filePath}`,
    query: { turnId }
  }
}

export function createGitDiffUri(repoPath: string, filePath: string, ref?: string): ResourceUri {
  return {
    scheme: 'git-diff',
    authority: encodeURIComponent(repoPath),
    path: filePath.startsWith('/') ? filePath : `/${filePath}`,
    query: ref ? { ref } : undefined
  }
}

export function createTerminalUri(
  source: 'local' | 'ssh',
  tabId: string,
  sessionId?: string
): ResourceUri {
  return {
    scheme: 'term',
    authority: source,
    path: `/${tabId}`,
    query: sessionId ? { sessionId } : undefined
  }
}

export function createWebviewUri(sessionId: string | null | undefined, url: string): ResourceUri {
  return {
    scheme: 'webview',
    authority: sessionId || 'global',
    path: '/browser',
    query: { url }
  }
}

export function createReviewUri(sessionId?: string | null): ResourceUri {
  return {
    scheme: 'review',
    authority: sessionId || 'active',
    path: '/changes'
  }
}

export function createSubagentUri(
  sessionId: string | null | undefined,
  toolUseId?: string
): ResourceUri {
  return {
    scheme: 'subagent',
    authority: sessionId || 'active',
    path: toolUseId ? `/${toolUseId}` : '/list'
  }
}

export function areUrisEqual(a?: ResourceUri | null, b?: ResourceUri | null): boolean {
  if (!a || !b) return a === b
  return formatResourceUri(a) === formatResourceUri(b)
}
