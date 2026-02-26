import { ipcMain, BrowserWindow } from 'electron'
import { Client, type ConnectConfig, type ClientChannel, type SFTPWrapper } from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import {
  startSshConfigWatcher,
  onSshConfigChange,
  listSshGroups,
  createSshGroup,
  updateSshGroup,
  deleteSshGroup,
  listSshConnections,
  getSshConnection,
  createSshConnection,
  updateSshConnection,
  deleteSshConnection,
  type SshConfigGroup,
  type SshConfigConnection,
} from '../ssh/ssh-config'

// ── SSH Session Manager ──

interface SshSession {
  id: string
  connectionId: string
  client: Client
  shell: ClientChannel | null
  sftp: SFTPWrapper | null
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  error?: string
  homeDir?: string
  outputSeq: number
  outputBuffer: { seq: number; data: Buffer }[]
  outputBufferSize: number
}

const sshSessions = new Map<string, SshSession>()
let nextSessionId = 1
const MAX_OUTPUT_BUFFER_BYTES = 1024 * 1024
let sshConfigWatcherAttached = false

interface SshGroupRow {
  id: string
  name: string
  sort_order: number
  created_at: number
  updated_at: number
}

interface SshConnectionRow {
  id: string
  group_id: string | null
  name: string
  host: string
  port: number
  username: string
  auth_type: string
  private_key_path: string | null
  startup_command: string | null
  default_directory: string | null
  proxy_jump: string | null
  keep_alive_interval: number
  sort_order: number
  last_connected_at: number | null
  created_at: number
  updated_at: number
}

function broadcastToRenderer(channel: string, data: unknown): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data)
  }
}

function ensureSshConfigWatcher(): void {
  if (sshConfigWatcherAttached) return
  sshConfigWatcherAttached = true
  startSshConfigWatcher()
  onSshConfigChange(() => {
    broadcastToRenderer('ssh:config:changed', {})
  })
}

function toGroupRow(group: SshConfigGroup): SshGroupRow {
  return {
    id: group.id,
    name: group.name,
    sort_order: group.sortOrder,
    created_at: group.createdAt,
    updated_at: group.updatedAt,
  }
}

function toConnectionRow(connection: SshConfigConnection): SshConnectionRow {
  return {
    id: connection.id,
    group_id: connection.groupId,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    auth_type: connection.authType,
    private_key_path: connection.privateKeyPath,
    startup_command: connection.startupCommand,
    default_directory: connection.defaultDirectory,
    proxy_jump: connection.proxyJump,
    keep_alive_interval: connection.keepAliveInterval,
    sort_order: connection.sortOrder,
    last_connected_at: connection.lastConnectedAt,
    created_at: connection.createdAt,
    updated_at: connection.updatedAt,
  }
}

function buildConnectConfig(connection: SshConfigConnection): ConnectConfig {
  if (!connection) throw new Error('Connection not found')

  const config: ConnectConfig = {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    keepaliveInterval: (connection.keepAliveInterval ?? 60) * 1000,
    keepaliveCountMax: 3,
    readyTimeout: 30000,
  }

  if (connection.authType === 'password' && connection.password) {
    config.password = connection.password
  } else if (connection.authType === 'privateKey' && connection.privateKeyPath) {
    try {
      config.privateKey = fs.readFileSync(connection.privateKeyPath, 'utf-8')
    } catch (err) {
      throw new Error(`Failed to read private key: ${err}`)
    }
    if (connection.passphrase) {
      config.passphrase = connection.passphrase
    }
  } else if (connection.authType === 'agent') {
    config.agent = process.platform === 'win32'
      ? '\\\\.\\pipe\\openssh-ssh-agent'
      : process.env.SSH_AUTH_SOCK || undefined
  }

  return config
}

async function getSftp(session: SshSession): Promise<SFTPWrapper> {
  if (session.sftp) return session.sftp
  return new Promise((resolve, reject) => {
    session.client.sftp((err, sftp) => {
      if (err) return reject(err)
      session.sftp = sftp
      resolve(sftp)
    })
  })
}

async function getHomeDir(session: SshSession): Promise<string | null> {
  if (session.homeDir) return session.homeDir
  const sftp = await getSftp(session)
  const homeDir = await new Promise<string | null>((resolve) => {
    sftp.realpath('.', (err, resolvedPath) => {
      if (err) return resolve(null)
      resolve(resolvedPath)
    })
  })
  if (homeDir) session.homeDir = homeDir
  return homeDir
}

async function resolveSftpPath(session: SshSession, inputPath: string): Promise<string> {
  if (!inputPath.startsWith('~')) return inputPath
  const homeDir = await getHomeDir(session)
  if (!homeDir) return inputPath
  if (inputPath === '~') return homeDir
  if (inputPath.startsWith('~/')) return path.posix.join(homeDir, inputPath.slice(2))
  return inputPath
}

function recordOutput(session: SshSession, data: Buffer): void {
  session.outputSeq += 1
  const seq = session.outputSeq
  const chunk = Buffer.from(data)

  session.outputBuffer.push({ seq, data: chunk })
  session.outputBufferSize += chunk.length

  while (session.outputBufferSize > MAX_OUTPUT_BUFFER_BYTES && session.outputBuffer.length > 1) {
    const removed = session.outputBuffer.shift()
    if (!removed) break
    session.outputBufferSize -= removed.data.length
  }

  broadcastToRenderer('ssh:output', {
    sessionId: session.id,
    data: Array.from(chunk),
    seq,
  })
}

export function registerSshHandlers(): void {
  ensureSshConfigWatcher()

  // ── Group CRUD ──

  ipcMain.handle('ssh:group:list', async () => {
    try {
      return listSshGroups().map(toGroupRow)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('ssh:group:create', async (_event, args: { id: string; name: string; sortOrder?: number }) => {
    try {
      const now = Date.now()
      createSshGroup({
        id: args.id,
        name: args.name,
        sortOrder: args.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('ssh:group:update', async (_event, args: { id: string; name?: string; sortOrder?: number }) => {
    try {
      updateSshGroup(args.id, { name: args.name, sortOrder: args.sortOrder, updatedAt: Date.now() })
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle('ssh:group:delete', async (_event, args: { id: string }) => {
    try {
      deleteSshGroup(args.id)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Connection CRUD ──

  ipcMain.handle('ssh:connection:list', async () => {
    try {
      return listSshConnections().map(toConnectionRow)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    'ssh:connection:create',
    async (
      _event,
      args: {
        id: string
        groupId?: string
        name: string
        host: string
        port?: number
        username: string
        authType?: string
        password?: string
        privateKeyPath?: string
        passphrase?: string
        startupCommand?: string
        defaultDirectory?: string
        proxyJump?: string
        keepAliveInterval?: number
        sortOrder?: number
      }
    ) => {
      try {
        const now = Date.now()
        const connection: SshConfigConnection = {
          id: args.id,
          groupId: args.groupId ?? null,
          name: args.name,
          host: args.host,
          port: args.port ?? 22,
          username: args.username,
          authType: (args.authType as SshConfigConnection['authType']) ?? 'password',
          password: args.password ?? null,
          privateKeyPath: args.privateKeyPath ?? null,
          passphrase: args.passphrase ?? null,
          startupCommand: args.startupCommand ?? null,
          defaultDirectory: args.defaultDirectory ?? null,
          proxyJump: args.proxyJump ?? null,
          keepAliveInterval: args.keepAliveInterval ?? 60,
          sortOrder: args.sortOrder ?? 0,
          lastConnectedAt: null,
          createdAt: now,
          updatedAt: now,
        }
        createSshConnection(connection)
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    'ssh:connection:update',
    async (
      _event,
      args: {
        id: string
        groupId?: string | null
        name?: string
        host?: string
        port?: number
        username?: string
        authType?: string
        password?: string | null
        privateKeyPath?: string | null
        passphrase?: string | null
        startupCommand?: string | null
        defaultDirectory?: string | null
        proxyJump?: string | null
        keepAliveInterval?: number
        sortOrder?: number
      }
    ) => {
      try {
        const patch: Partial<Omit<SshConfigConnection, 'id'>> = { updatedAt: Date.now() }
        if (args.groupId !== undefined) patch.groupId = args.groupId
        if (args.name !== undefined) patch.name = args.name
        if (args.host !== undefined) patch.host = args.host
        if (args.port !== undefined) patch.port = args.port
        if (args.username !== undefined) patch.username = args.username
        if (args.authType !== undefined) {
          patch.authType = args.authType as SshConfigConnection['authType']
        }
        if (args.password !== undefined) patch.password = args.password
        if (args.privateKeyPath !== undefined) patch.privateKeyPath = args.privateKeyPath
        if (args.passphrase !== undefined) patch.passphrase = args.passphrase
        if (args.startupCommand !== undefined) patch.startupCommand = args.startupCommand
        if (args.defaultDirectory !== undefined) patch.defaultDirectory = args.defaultDirectory
        if (args.proxyJump !== undefined) patch.proxyJump = args.proxyJump
        if (args.keepAliveInterval !== undefined) patch.keepAliveInterval = args.keepAliveInterval
        if (args.sortOrder !== undefined) patch.sortOrder = args.sortOrder

        updateSshConnection(args.id, patch)
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle('ssh:connection:delete', async (_event, args: { id: string }) => {
    try {
      // Disconnect any active sessions for this connection
      for (const [sessionId, session] of sshSessions) {
        if (session.connectionId === args.id) {
          session.client.end()
          sshSessions.delete(sessionId)
        }
      }
      deleteSshConnection(args.id)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Test Connection ──

  ipcMain.handle('ssh:connection:test', async (_event, args: { id: string }) => {
    try {
      const connection = getSshConnection(args.id)
      if (!connection) return { error: 'Connection not found' }

      const config = buildConnectConfig(connection)
      const client = new Client()

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          client.end()
          resolve({ success: false, error: 'Connection timeout (30s)' })
        }, 30000)

        client
          .on('ready', () => {
            clearTimeout(timeout)
            client.end()
            resolve({ success: true })
          })
          .on('error', (err) => {
            clearTimeout(timeout)
            resolve({ success: false, error: err.message })
          })
          .connect(config)
      })
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── Terminal Session: Connect ──

  ipcMain.handle('ssh:connect', async (_event, args: { connectionId: string }) => {
    try {
      const connection = getSshConnection(args.connectionId)
      if (!connection) return { error: 'Connection not found' }

      const config = buildConnectConfig(connection)
      const client = new Client()
      const sessionId = `ssh-${nextSessionId++}`

      const session: SshSession = {
        id: sessionId,
        connectionId: args.connectionId,
        client,
        shell: null,
        sftp: null,
        status: 'connecting',
        outputSeq: 0,
        outputBuffer: [],
        outputBufferSize: 0,
      }
      sshSessions.set(sessionId, session)

      broadcastToRenderer('ssh:status', {
        sessionId,
        connectionId: args.connectionId,
        status: 'connecting',
      })

      return new Promise((resolve) => {
        const connectTimeout = setTimeout(() => {
          session.status = 'error'
          session.error = 'Connection timeout (30s)'
          client.end()
          sshSessions.delete(sessionId)
          broadcastToRenderer('ssh:status', {
            sessionId,
            connectionId: args.connectionId,
            status: 'error',
            error: 'Connection timeout (30s)',
          })
          resolve({ error: 'Connection timeout (30s)' })
        }, 30000)

        client
          .on('ready', () => {
            clearTimeout(connectTimeout)
            session.status = 'connected'

            // Update last connected time
            updateSshConnection(args.connectionId, { lastConnectedAt: Date.now(), updatedAt: Date.now() })

            // Open shell with PTY
            client.shell(
              {
                term: 'xterm-256color',
                cols: 120,
                rows: 30,
                modes: {},
              },
              (err, stream) => {
                if (err) {
                  session.status = 'error'
                  session.error = `Shell error: ${err.message}`
                  broadcastToRenderer('ssh:status', {
                    sessionId,
                    connectionId: args.connectionId,
                    status: 'error',
                    error: session.error,
                  })
                  resolve({ error: session.error })
                  return
                }

                session.shell = stream

                stream.on('data', (data: Buffer) => {
                  recordOutput(session, data)
                })

                stream.stderr?.on('data', (data: Buffer) => {
                  recordOutput(session, data)
                })

                stream.on('close', () => {
                  session.status = 'disconnected'
                  broadcastToRenderer('ssh:status', {
                    sessionId,
                    connectionId: args.connectionId,
                    status: 'disconnected',
                  })
                  client.end()
                  sshSessions.delete(sessionId)
                })

                broadcastToRenderer('ssh:status', {
                  sessionId,
                  connectionId: args.connectionId,
                  status: 'connected',
                })

                // Execute startup command if configured
                if (connection.startupCommand) {
                  stream.write(connection.startupCommand + '\n')
                }
                // cd to default directory if configured
                if (connection.defaultDirectory) {
                  stream.write(`cd ${connection.defaultDirectory}\n`)
                }

                resolve({ sessionId })
              }
            )
          })
          .on('error', (err) => {
            clearTimeout(connectTimeout)
            session.status = 'error'
            session.error = err.message
            sshSessions.delete(sessionId)
            broadcastToRenderer('ssh:status', {
              sessionId,
              connectionId: args.connectionId,
              status: 'error',
              error: err.message,
            })
            resolve({ error: err.message })
          })
          .on('close', () => {
            if (session.status === 'connected' || session.status === 'connecting') {
              session.status = 'disconnected'
              broadcastToRenderer('ssh:status', {
                sessionId,
                connectionId: args.connectionId,
                status: 'disconnected',
              })
            }
            sshSessions.delete(sessionId)
          })
          .connect(config)
      })
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Terminal Session: Send data ──

  ipcMain.on('ssh:data', (_event, args: { sessionId: string; data: string }) => {
    const session = sshSessions.get(args.sessionId)
    if (session?.shell && session.status === 'connected') {
      session.shell.write(args.data)
    }
  })

  // ── Terminal Session: Resize PTY ──

  ipcMain.on('ssh:resize', (_event, args: { sessionId: string; cols: number; rows: number }) => {
    const session = sshSessions.get(args.sessionId)
    if (session?.shell && session.status === 'connected') {
      session.shell.setWindow(args.rows, args.cols, 0, 0)
    }
  })

  // ── Terminal Session: Disconnect ──

  ipcMain.handle('ssh:disconnect', async (_event, args: { sessionId: string }) => {
    const session = sshSessions.get(args.sessionId)
    if (!session) return { error: 'Session not found' }

    session.status = 'disconnected'
    if (session.shell) session.shell.end()
    session.client.end()
    sshSessions.delete(args.sessionId)

    broadcastToRenderer('ssh:status', {
      sessionId: args.sessionId,
      connectionId: session.connectionId,
      status: 'disconnected',
    })

    return { success: true }
  })

  // ── Terminal Session: List active sessions ──

  ipcMain.handle('ssh:session:list', async () => {
    const list: { id: string; connectionId: string; status: string; error?: string }[] = []
    for (const session of sshSessions.values()) {
      list.push({
        id: session.id,
        connectionId: session.connectionId,
        status: session.status,
        error: session.error,
      })
    }
    return list
  })

  // ── Terminal Session: Output buffer ──

  ipcMain.handle(
    'ssh:output:buffer',
    async (_event, args: { sessionId: string; sinceSeq?: number }) => {
      const session = sshSessions.get(args.sessionId)
      if (!session) return { error: 'Session not found' }

      const sinceSeq = args.sinceSeq ?? 0
      const chunks = session.outputBuffer
        .filter((entry) => entry.seq > sinceSeq)
        .map((entry) => Array.from(entry.data))

      return {
        lastSeq: session.outputSeq,
        chunks,
      }
    }
  )

  // ── SFTP: Read file ──

  ipcMain.handle(
    'ssh:fs:read-file',
    async (_event, args: { connectionId: string; path: string; offset?: number; limit?: number }) => {
      try {
        const session = findSessionByConnection(args.connectionId)
        if (!session) return { error: 'No active SSH session for this connection' }

        const sftp = await getSftp(session)
        const resolvedPath = await resolveSftpPath(session, args.path)
        const content = await new Promise<string>((resolve, reject) => {
          sftp.readFile(resolvedPath, 'utf-8', (err, data) => {
            if (err) return reject(err)
            resolve(typeof data === 'string' ? data : data.toString('utf-8'))
          })
        })

        if (args.offset !== undefined || args.limit !== undefined) {
          const lines = content.split('\n')
          const start = (args.offset ?? 1) - 1
          const end = args.limit ? start + args.limit : lines.length
          return lines
            .slice(start, end)
            .map((line, i) => `${start + i + 1}\t${line}`)
            .join('\n')
        }
        return content
      } catch (err) {
        return JSON.stringify({ error: String(err) })
      }
    }
  )

  // ── SFTP: Write file ──

  ipcMain.handle(
    'ssh:fs:write-file',
    async (_event, args: { connectionId: string; path: string; content: string }) => {
      try {
        const session = findSessionByConnection(args.connectionId)
        if (!session) return { error: 'No active SSH session for this connection' }

        const sftp = await getSftp(session)
        const resolvedPath = await resolveSftpPath(session, args.path)

        // Ensure parent directory exists
        const dir = path.posix.dirname(resolvedPath)
        await sftpMkdirRecursive(sftp, dir)

        await new Promise<void>((resolve, reject) => {
          sftp.writeFile(resolvedPath, args.content, 'utf-8', (err) => {
            if (err) return reject(err)
            resolve()
          })
        })
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SFTP: Read binary file ──

  ipcMain.handle(
    'ssh:fs:read-file-binary',
    async (_event, args: { connectionId: string; path: string }) => {
      try {
        const session = findSessionByConnection(args.connectionId)
        if (!session) return { error: 'No active SSH session for this connection' }

        const sftp = await getSftp(session)
        const resolvedPath = await resolveSftpPath(session, args.path)
        const buffer = await new Promise<Buffer>((resolve, reject) => {
          sftp.readFile(resolvedPath, (err, data) => {
            if (err) return reject(err)
            const output = Buffer.isBuffer(data) ? data : Buffer.from(data)
            resolve(output)
          })
        })
        return { data: buffer.toString('base64') }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SFTP: Write binary file ──

  ipcMain.handle(
    'ssh:fs:write-file-binary',
    async (_event, args: { connectionId: string; path: string; data: string }) => {
      try {
        const session = findSessionByConnection(args.connectionId)
        if (!session) return { error: 'No active SSH session for this connection' }

        const sftp = await getSftp(session)
        const resolvedPath = await resolveSftpPath(session, args.path)
        const dir = path.posix.dirname(resolvedPath)
        await sftpMkdirRecursive(sftp, dir)

        const buffer = Buffer.from(args.data, 'base64')
        await new Promise<void>((resolve, reject) => {
          sftp.writeFile(resolvedPath, buffer, (err) => {
            if (err) return reject(err)
            resolve()
          })
        })
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SFTP: List directory ──

  ipcMain.handle(
    'ssh:fs:list-dir',
    async (_event, args: { connectionId: string; path: string }) => {
      try {
        const session = findSessionByConnection(args.connectionId)
        if (!session) return { error: 'No active SSH session for this connection' }

        const sftp = await getSftp(session)
        const resolvedPath = await resolveSftpPath(session, args.path)
        const entries = await new Promise<
          { name: string; type: string; path: string }[]
        >((resolve, reject) => {
          sftp.readdir(resolvedPath, (err, list) => {
            if (err) return reject(err)
            resolve(
              list.map((item) => {
                const isDirectory = item.attrs.isDirectory()
                const isSymlink = item.attrs.isSymbolicLink?.() ?? false
                const type = isDirectory ? 'directory' : isSymlink ? 'symlink' : 'file'
                return {
                  name: item.filename,
                  type,
                  path: path.posix.join(resolvedPath, item.filename),
                  size: item.attrs.size ?? 0,
                  modifyTime: item.attrs.mtime ? item.attrs.mtime * 1000 : 0,
                }
              })
            )
          })
        })
        return entries
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SFTP: Mkdir ──

  ipcMain.handle(
    'ssh:fs:mkdir',
    async (_event, args: { connectionId: string; path: string }) => {
      try {
        const session = findSessionByConnection(args.connectionId)
        if (!session) return { error: 'No active SSH session for this connection' }

        const sftp = await getSftp(session)
        const resolvedPath = await resolveSftpPath(session, args.path)
        await sftpMkdirRecursive(sftp, resolvedPath)
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SFTP: Delete ──

  ipcMain.handle(
    'ssh:fs:delete',
    async (_event, args: { connectionId: string; path: string }) => {
      try {
        const session = findSessionByConnection(args.connectionId)
        if (!session) return { error: 'No active SSH session for this connection' }

        const sftp = await getSftp(session)
        const resolvedPath = await resolveSftpPath(session, args.path)
        const stat = await sftpStat(sftp, resolvedPath)
        if (stat?.isDirectory()) {
          // Use exec for recursive delete
          await sshExec(session, `rm -rf ${shellEscape(resolvedPath)}`)
        } else {
          await new Promise<void>((resolve, reject) => {
            sftp.unlink(resolvedPath, (err) => {
              if (err) return reject(err)
              resolve()
            })
          })
        }
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SFTP: Move/Rename ──

  ipcMain.handle(
    'ssh:fs:move',
    async (_event, args: { connectionId: string; from: string; to: string }) => {
      try {
        const session = findSessionByConnection(args.connectionId)
        if (!session) return { error: 'No active SSH session for this connection' }

        const sftp = await getSftp(session)
        const from = await resolveSftpPath(session, args.from)
        const to = await resolveSftpPath(session, args.to)
        await new Promise<void>((resolve, reject) => {
          sftp.rename(from, to, (err) => {
            if (err) return reject(err)
            resolve()
          })
        })
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SSH Exec (non-interactive command) ──

  ipcMain.handle(
    'ssh:exec',
    async (_event, args: { connectionId: string; command: string; timeout?: number }) => {
      try {
        const session = findSessionByConnection(args.connectionId)
        if (!session) return { error: 'No active SSH session for this connection' }

        const result = await sshExec(session, args.command, args.timeout)
        return result
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SSH Glob (via remote find) ──

  ipcMain.handle(
    'ssh:fs:glob',
    async (_event, args: { connectionId: string; pattern: string; path?: string }) => {
      try {
        const session = findSessionByConnection(args.connectionId)
        if (!session) return { error: 'No active SSH session for this connection' }

        const cwdInput = args.path || '.'
        const cwd = await resolveSftpPath(session, cwdInput)
        const result = await sshExec(
          session,
          `find ${shellEscape(cwd)} -name ${shellEscape(args.pattern)} -maxdepth 5 2>/dev/null | head -100`
        )
        if (result.exitCode !== 0) return []
        return result.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SSH Grep (via remote grep) ──

  ipcMain.handle(
    'ssh:fs:grep',
    async (
      _event,
      args: { connectionId: string; pattern: string; path?: string; include?: string }
    ) => {
      try {
        const session = findSessionByConnection(args.connectionId)
        if (!session) return { error: 'No active SSH session for this connection' }

        const cwdInput = args.path || '.'
        const cwd = await resolveSftpPath(session, cwdInput)
        let cmd = `grep -rn ${shellEscape(args.pattern)} ${shellEscape(cwd)}`
        if (args.include) cmd += ` --include=${shellEscape(args.include)}`
        cmd += ' 2>/dev/null | head -100'

        const result = await sshExec(session, cmd)
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          return { error: result.stderr || 'grep failed' }
        }

        const matches: { file: string; line: number; text: string }[] = []
        for (const rawLine of result.stdout.split('\n')) {
          const match = rawLine.match(/^(.+?):(\d+):(.*)$/)
          if (match) {
            matches.push({ file: match[1], line: parseInt(match[2], 10), text: match[3] })
          }
        }
        return matches
      } catch (err) {
        return { error: String(err) }
      }
    }
  )
}

// ── Helpers ──

function findSessionByConnection(connectionId: string): SshSession | undefined {
  for (const session of sshSessions.values()) {
    if (session.connectionId === connectionId && session.status === 'connected') {
      return session
    }
  }
  return undefined
}

function sshExec(
  session: SshSession,
  command: string,
  timeout = 60000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('SSH exec timeout'))
    }, timeout)

    session.client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        return reject(err)
      }

      let stdout = ''
      let stderr = ''

      stream.on('data', (data: Buffer) => {
        stdout += data.toString('utf-8')
      })

      stream.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString('utf-8')
      })

      stream.on('close', (code: number) => {
        clearTimeout(timer)
        resolve({ exitCode: code ?? 0, stdout, stderr })
      })
    })
  })
}

function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<import('ssh2').Stats | null> {
  return new Promise((resolve) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) return resolve(null)
      resolve(stats)
    })
  })
}

async function sftpMkdirRecursive(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  const parts = remotePath.split('/').filter(Boolean)
  let current = remotePath.startsWith('/') ? '/' : ''

  for (const part of parts) {
    current = current ? path.posix.join(current, part) : part
    const stat = await sftpStat(sftp, current)
    if (!stat) {
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(current, (err) => {
          if (err && (err as NodeJS.ErrnoException).code !== 'FAILURE') return reject(err)
          resolve()
        })
      })
    }
  }
}

function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

// ── Cleanup ──

export function closeAllSshSessions(): void {
  for (const session of sshSessions.values()) {
    try {
      if (session.shell) session.shell.end()
      session.client.end()
    } catch {
      // ignore
    }
  }
  sshSessions.clear()
}
