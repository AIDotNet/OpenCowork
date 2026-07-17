import {
  getConnectionWithSecrets as getSshConnection,
  type SshConnectionWithSecrets as SshConfigConnection
} from '../ssh/repository'

function parseOpenSshJumpString(
  raw: string
): { username?: string; host: string; port?: number } | null {
  const value = raw.trim()
  if (!value) return null
  const match = value.match(/^(?:(?<username>[^@]+)@)?(?<host>[^:]+?)(?::(?<port>\d+))?$/)
  if (!match?.groups?.host) return null
  const port = match.groups.port ? Number.parseInt(match.groups.port, 10) : undefined
  return {
    username: match.groups.username,
    host: match.groups.host,
    port: Number.isFinite(port) ? port : undefined
  }
}

function formatNativeProxyJumpConnection(connection: {
  host: string
  username?: string | null
  port?: number | null
}): string {
  const host = connection.host.includes(':') ? `[${connection.host}]` : connection.host
  const prefix = connection.username ? `${connection.username}@` : ''
  return connection.port && connection.port !== 22
    ? `${prefix}${host}:${connection.port}`
    : `${prefix}${host}`
}

function resolveNativeProxyJump(target: SshConfigConnection): string | null {
  const raw = target.proxyJump?.trim()
  if (!raw) return null

  const saved = getSshConnection(raw)
  if (saved) return formatNativeProxyJumpConnection(saved)

  const parsed = parseOpenSshJumpString(raw)
  if (!parsed || (!raw.includes('@') && !raw.includes(':'))) return raw
  return formatNativeProxyJumpConnection({
    host: parsed.host,
    username: parsed.username ?? target.username,
    port: parsed.port ?? 22
  })
}

export function toNativeSshConnection(connection: SshConfigConnection): Record<string, unknown> {
  const authFields: Record<string, unknown> = {}
  if (connection.authType === 'password') {
    authFields.password = connection.password
  } else if (connection.authType === 'privateKey') {
    authFields.privateKeyPath = connection.privateKeyPath
    authFields.passphrase = connection.passphrase
  }

  return {
    id: connection.id,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authType: connection.authType,
    proxyJump: resolveNativeProxyJump(connection),
    ...authFields
  }
}

export function getNativeSshConnectionPayload(
  connectionId: string
): Record<string, unknown> | null {
  const connection = getSshConnection(connectionId)
  return connection ? toNativeSshConnection(connection) : null
}
