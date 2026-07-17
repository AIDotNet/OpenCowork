import { type SshConnection, type SshSession } from '@renderer/stores/ssh-store'

// Pure helpers for the host list: quick-connect parsing and OS badges.

export type QuickConnectTarget = {
  username: string
  host: string
  port: number
  name: string
  command: string
}

export const TEST_STATUS_TTL_MS = 15000

export function parseQuickConnect(rawValue: string): QuickConnectTarget | null {
  const value = rawValue.trim()
  if (!value) return null

  const command = value.replace(/\s+/g, ' ')
  const startsWithSsh = command.startsWith('ssh ')
  const tokens = startsWithSsh ? command.split(' ').slice(1) : command.split(' ')
  let port = 22
  let loginToken: string | null = null

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue

    if (token === '-p') {
      const nextPort = Number.parseInt(tokens[index + 1] ?? '', 10)
      if (Number.isFinite(nextPort) && nextPort > 0) port = nextPort
      index += 1
      continue
    }

    if (token.startsWith('-p') && token.length > 2) {
      const inlinePort = Number.parseInt(token.slice(2), 10)
      if (Number.isFinite(inlinePort) && inlinePort > 0) port = inlinePort
      continue
    }

    if (token === '-l') {
      index += 1
      continue
    }

    if (token.startsWith('-')) continue
    loginToken = token
  }

  if (!loginToken && !startsWithSsh) loginToken = command
  if (!loginToken || !loginToken.includes('@')) return null

  const cleanedToken = loginToken.replace(/^ssh:\/\//, '').replace(/[;,]$/, '')
  const atIndex = cleanedToken.lastIndexOf('@')
  if (atIndex <= 0 || atIndex >= cleanedToken.length - 1) return null

  const username = cleanedToken.slice(0, atIndex)
  let host = cleanedToken.slice(atIndex + 1)
  const hostWithPort = host.match(/^([^:\s]+):(\d+)$/)
  if (hostWithPort) {
    host = hostWithPort[1]
    port = Number.parseInt(hostWithPort[2], 10) || port
  }

  if (!username || !host) return null

  return {
    username,
    host,
    port,
    name: host,
    command: `ssh ${username}@${host} -p ${port}`
  }
}

export function getSessionForConnection(
  sessions: Record<string, SshSession>,
  connectionId: string
): SshSession | undefined {
  return Object.values(sessions).find(
    (item) =>
      item.connectionId === connectionId &&
      (item.status === 'connected' || item.status === 'connecting')
  )
}

export function getGroupHostCount(connections: SshConnection[], groupId: string | null): number {
  return connections.filter((connection) => connection.groupId === groupId).length
}

export type SshOsKind = 'ubuntu' | 'windows' | 'debian' | 'centos' | 'fedora' | 'macos' | 'linux'

const SSH_OS_META: Record<SshOsKind, { label: string; bg: string; fg: string }> = {
  ubuntu: { label: 'Ubuntu', bg: '#e95420', fg: '#fff7ed' },
  windows: { label: 'Windows', bg: '#0078d4', fg: '#eef7ff' },
  debian: { label: 'Debian', bg: '#a80030', fg: '#fff1f5' },
  centos: { label: 'CentOS', bg: '#6f42c1', fg: '#f5f0ff' },
  fedora: { label: 'Fedora', bg: '#294172', fg: '#edf5ff' },
  macos: { label: 'macOS', bg: '#3f3f46', fg: '#f4f4f5' },
  linux: { label: 'Linux', bg: '#262626', fg: '#f5f5f5' }
}

export function inferSshOsKind(connection: SshConnection): SshOsKind {
  const configured = (connection as SshConnection & { osType?: string | null }).osType
  const text = [
    configured,
    connection.name,
    connection.host,
    connection.username,
    connection.defaultDirectory,
    connection.startupCommand
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (/\b(win|windows|rdp)\b/.test(text)) return 'windows'
  if (text.includes('ubuntu') || connection.authType === 'password') return 'ubuntu'
  if (text.includes('debian')) return 'debian'
  if (text.includes('centos') || text.includes('rocky') || text.includes('almalinux'))
    return 'centos'
  if (text.includes('fedora')) return 'fedora'
  if (text.includes('macos') || text.includes('darwin')) return 'macos'
  return 'linux'
}

export function SshOsBadge({ kind }: { kind: SshOsKind }): React.JSX.Element {
  const meta = SSH_OS_META[kind]

  return (
    <div
      className="inline-flex size-9 items-center justify-center rounded-[9px] border border-[#404040] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
      style={{ backgroundColor: meta.bg, color: meta.fg }}
      title={meta.label}
      aria-label={meta.label}
    >
      {kind === 'windows' ? (
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
          <path
            fill="currentColor"
            d="M3 5.4 10.8 4v7.4H3V5.4Zm8.8-1.6L21 2.2v9.2h-9.2V3.8ZM3 12.6h7.8V20L3 18.6v-6Zm8.8 0H21v9.2l-9.2-1.6v-7.6Z"
          />
        </svg>
      ) : kind === 'ubuntu' ? (
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
          <circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" strokeWidth="2.2" />
          <circle cx="18.3" cy="7.2" r="2.2" fill="currentColor" />
          <circle cx="18.3" cy="16.8" r="2.2" fill="currentColor" />
          <circle cx="6.4" cy="12" r="2.2" fill="currentColor" />
          <path
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="2"
            d="m15.3 9.5 1.5-1.1M15.3 14.5l1.5 1.1M8.1 12H6.4"
          />
        </svg>
      ) : kind === 'macos' ? (
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
          <path
            fill="currentColor"
            d="M16.8 2.8c.1 1.2-.4 2.3-1.1 3.1-.8.9-2 1.5-3.1 1.4-.1-1.1.4-2.3 1.1-3.1.8-.9 2.1-1.5 3.1-1.4Zm3.5 14.6c-.5 1.1-.8 1.6-1.5 2.6-1 1.4-2.4 3.1-4.1 3.1-1.5 0-1.9-1-3.9-1s-2.4 1-3.9 1c-1.7 0-3-1.5-4-2.9-2.7-3.9-3-8.5-1.3-11 1.2-1.8 3.1-2.8 4.9-2.8 1.8 0 2.9 1 4.3 1 1.4 0 2.3-1 4.4-1 1.6 0 3.3.9 4.5 2.3-3.9 2.1-3.3 7.7.6 8.7Z"
          />
        </svg>
      ) : (
        <span className="text-[11px] font-bold uppercase leading-none">
          {meta.label.slice(0, kind === 'linux' ? 3 : 2)}
        </span>
      )}
    </div>
  )
}
