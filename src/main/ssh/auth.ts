import * as fs from 'fs'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { getConnectionWithSecrets, type SshConnectionWithSecrets } from './repository'
import { resolveOpenSshHost, type OpenSshHostConfig } from './openssh-config'

// Connection/auth building blocks shared by the connection manager: ssh2
// connect config assembly, proxy-jump resolution (saved connection id /
// OpenSSH alias / user@host:port string) and stage-layered error formatting.

export interface LayeredSshError {
  stage: 'jump_connect' | 'jump_auth' | 'target_connect' | 'target_auth' | 'config'
  message: string
  cause?: unknown
}

export interface ResolvedJumpTarget {
  source: 'alias' | 'connectionId' | 'string'
  label: string
  connection: SshConnectionWithSecrets
}

export function toLayeredError(
  stage: LayeredSshError['stage'],
  message: string,
  cause?: unknown
): LayeredSshError {
  return { stage, message, cause }
}

export function isAuthFailureMessage(message: string): boolean {
  return message.includes('All configured authentication methods failed')
}

export function formatLayeredError(
  err: unknown,
  fallbackAuthType?: SshConnectionWithSecrets['authType']
): string {
  if (err && typeof err === 'object' && 'stage' in err && 'message' in err) {
    const layered = err as LayeredSshError
    const raw = layered.message || ''
    if (layered.stage === 'jump_auth') {
      return `Jump host authentication failed: ${raw}`
    }
    if (layered.stage === 'jump_connect') {
      return `Jump host connection failed: ${raw}`
    }
    if (layered.stage === 'target_auth') {
      if (fallbackAuthType === 'password')
        return 'Target host password authentication failed, please check your password.'
      if (fallbackAuthType === 'privateKey')
        return 'Target host private key authentication failed, please check key or passphrase.'
      if (fallbackAuthType === 'agent')
        return 'Target host SSH Agent authentication failed, please check Agent status.'
      return `Target host authentication failed: ${raw}`
    }
    if (layered.stage === 'target_connect') {
      return `Target host connection failed: ${raw}`
    }
    return raw
  }

  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('ECONNREFUSED')) return 'Connection refused, please check host and port.'
  if (message.includes('ETIMEDOUT') || message.includes('timeout'))
    return 'Connection timed out, please check network reachability.'
  if (message.includes('ENOTFOUND') || message.includes('getaddrinfo'))
    return 'Host not resolvable, please check hostname or IP.'
  if (isAuthFailureMessage(message)) {
    if (fallbackAuthType === 'password')
      return 'Password authentication failed, please check password.'
    if (fallbackAuthType === 'privateKey')
      return 'Private key authentication failed, please check key file and passphrase.'
    if (fallbackAuthType === 'agent')
      return 'SSH Agent authentication failed, please check Agent availability.'
  }
  return message
}

export async function buildConnectConfig(
  connection: SshConnectionWithSecrets
): Promise<ConnectConfig> {
  if (!connection) throw new Error('Connection not found')

  const config: ConnectConfig = {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    keepaliveInterval: (connection.keepAliveInterval ?? 60) * 1000,
    keepaliveCountMax: 3,
    readyTimeout: 30000
  }

  if (connection.authType === 'password') {
    if (!connection.password) {
      throw new Error('Password is required for password authentication')
    }
    config.password = connection.password
  } else if (connection.authType === 'privateKey') {
    if (!connection.privateKeyPath) {
      throw new Error('Private key path is required for private key authentication')
    }
    try {
      const stat = await fs.promises.stat(connection.privateKeyPath)
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        console.warn(
          `[SSH] Private key ${connection.privateKeyPath} is readable by other users (mode ${(
            stat.mode & 0o777
          ).toString(8)})`
        )
      }
      config.privateKey = await fs.promises.readFile(connection.privateKeyPath, 'utf-8')
    } catch (err) {
      throw new Error(`Failed to read private key: ${err}`)
    }
    if (connection.passphrase) {
      config.passphrase = connection.passphrase
    }
  } else if (connection.authType === 'agent') {
    config.agent =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\openssh-ssh-agent'
        : process.env.SSH_AUTH_SOCK || undefined
  } else {
    throw new Error(`Unsupported authentication type: ${connection.authType}`)
  }

  return config
}

export function createDerivedConnection(
  base: SshConnectionWithSecrets,
  patch: Partial<SshConnectionWithSecrets>
): SshConnectionWithSecrets {
  return {
    ...base,
    ...patch,
    id: patch.id ?? base.id,
    name: patch.name ?? base.name,
    host: patch.host ?? base.host,
    port: patch.port ?? base.port,
    username: patch.username ?? base.username,
    authType: patch.authType ?? base.authType,
    password: patch.password ?? base.password,
    privateKeyPath: patch.privateKeyPath ?? base.privateKeyPath,
    passphrase: patch.passphrase ?? base.passphrase,
    keepAliveInterval: patch.keepAliveInterval ?? base.keepAliveInterval,
    proxyJump: patch.proxyJump ?? base.proxyJump
  }
}

export function parseOpenSshJumpString(
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

function openSshHostToConnection(
  alias: string,
  hostConfig: OpenSshHostConfig,
  target: SshConnectionWithSecrets
): SshConnectionWithSecrets {
  return createDerivedConnection(target, {
    id: `alias:${alias}`,
    name: alias,
    host: hostConfig.hostName ?? alias,
    port: hostConfig.port ?? 22,
    username: hostConfig.user ?? target.username,
    authType: hostConfig.identityFile ? 'privateKey' : target.authType,
    privateKeyPath: hostConfig.identityFile ?? target.privateKeyPath,
    password: hostConfig.identityFile ? null : target.password,
    passphrase: target.passphrase,
    proxyJump: null
  })
}

export async function resolveProxyJumpTarget(
  target: SshConnectionWithSecrets
): Promise<ResolvedJumpTarget | null> {
  const raw = target.proxyJump?.trim()
  if (!raw) return null

  const aliasConfig = await resolveOpenSshHost(raw)
  if (aliasConfig) {
    return {
      source: 'alias',
      label: raw,
      connection: openSshHostToConnection(raw, aliasConfig, target)
    }
  }

  const saved = getConnectionWithSecrets(raw)
  if (saved) {
    return {
      source: 'connectionId',
      label: saved.name || saved.id,
      connection: createDerivedConnection(saved, { proxyJump: null })
    }
  }

  const parsed = parseOpenSshJumpString(raw)
  if (!parsed) return null
  return {
    source: 'string',
    label: raw,
    connection: createDerivedConnection(target, {
      id: `jump:${raw}`,
      name: raw,
      host: parsed.host,
      port: parsed.port ?? 22,
      username: parsed.username ?? target.username,
      proxyJump: null
    })
  }
}

async function connectClient(client: Client, config: ConnectConfig): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client
      .once('ready', () => resolve())
      .once('error', (err) => reject(err))
      .connect(config)
  })
}

export async function connectWithProxyJump(
  connection: SshConnectionWithSecrets
): Promise<{ client: Client; jumpClient?: Client }> {
  const targetConfig = await buildConnectConfig(connection)
  const jumpTarget = await resolveProxyJumpTarget(connection)
  if (!jumpTarget) {
    const client = new Client()
    await connectClient(client, targetConfig)
    return { client }
  }

  const jumpClient = new Client()
  try {
    await connectClient(jumpClient, await buildConnectConfig(jumpTarget.connection))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw isAuthFailureMessage(message)
      ? toLayeredError('jump_auth', message, err)
      : toLayeredError('jump_connect', message, err)
  }

  const targetClient = new Client()
  try {
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      jumpClient.forwardOut('127.0.0.1', 0, connection.host, connection.port, (err, channel) => {
        if (err) return reject(err)
        resolve(channel)
      })
    })

    await connectClient(targetClient, { ...targetConfig, sock: stream })
    return { client: targetClient, jumpClient }
  } catch (err) {
    try {
      jumpClient.end()
    } catch {
      // ignore
    }
    const message = err instanceof Error ? err.message : String(err)
    throw isAuthFailureMessage(message)
      ? toLayeredError('target_auth', message, err)
      : toLayeredError('target_connect', message, err)
  }
}
