import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { WorkerToolDefinition } from './worker-session.js'

/**
 * CLI-side MCP host. The Native Worker persists server configuration
 * (~/.open-cowork/mcp-servers.json via mcp/config-*) and executes MCP tools by reverse
 * request (mcp:call-tool / mcp:read-resource) against whichever host started the run.
 * On desktop that host is the Electron main process; in a terminal-only install this
 * class is that host. It never stores a second copy of the configuration.
 */

export const MCP_TOOL_PREFIX = 'mcp__'

/** Matches the persisted mcp-servers.json entry shape used by the desktop app. */
export interface CliMcpServerConfig {
  id: string
  name: string
  enabled: boolean
  projectId?: string | null
  transport: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  autoFallback?: boolean
  description?: string
}

export interface CliMcpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface CliMcpResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export type CliMcpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface CliMcpServerState {
  config: CliMcpServerConfig
  status: CliMcpServerStatus
  error?: string
  toolCount: number
  resourceCount: number
}

const CONNECT_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 120_000

export function mcpToolWireName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${toolName}`
}

export function mcpResourceWireName(serverId: string, resourceName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__resource__${resourceName}`
}

export function isMcpWireName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX)
}

/** Normalize the Worker's mcp/config-list payload into typed CLI configs. */
export function parseMcpServerConfigs(value: unknown): CliMcpServerConfig[] {
  if (!Array.isArray(value)) return []
  const configs: CliMcpServerConfig[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    const transport = record.transport
    if (!id || (transport !== 'stdio' && transport !== 'sse' && transport !== 'streamable-http')) {
      continue
    }
    configs.push({
      id,
      name: typeof record.name === 'string' && record.name ? record.name : id,
      enabled: record.enabled === true,
      projectId: typeof record.projectId === 'string' ? record.projectId : null,
      transport,
      command: typeof record.command === 'string' ? record.command : undefined,
      args: Array.isArray(record.args)
        ? record.args.filter((item): item is string => typeof item === 'string')
        : undefined,
      env: isStringRecord(record.env) ? record.env : undefined,
      cwd: typeof record.cwd === 'string' ? record.cwd : undefined,
      url: typeof record.url === 'string' ? record.url : undefined,
      headers: isStringRecord(record.headers) ? record.headers : undefined,
      autoFallback: typeof record.autoFallback === 'boolean' ? record.autoFallback : undefined,
      description: typeof record.description === 'string' ? record.description : undefined
    })
  }
  return configs
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((item) => typeof item === 'string')
}

function isNpmCommand(command: string): boolean {
  const name = basename(command)
    .toLowerCase()
    .replace(/\.(cmd|exe)$/u, '')
  return name === 'npm' || name === 'npx'
}

function buildStdioEnv(
  command: string,
  configuredEnv?: Record<string, string>
): Record<string, string> | undefined {
  if (!configuredEnv && !isNpmCommand(command)) return undefined
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, configuredEnv ?? {})
  // Same npm cache isolation the desktop host applies so npx-based servers do not
  // pollute or depend on the user's global npm cache location.
  if (isNpmCommand(command) && !env.NPM_CONFIG_CACHE && !env.npm_config_cache) {
    const cacheDir = join(
      process.env.OPEN_COWORK_DATA_DIR?.trim() || join(homedir(), '.open-cowork'),
      'npm-cache'
    )
    try {
      mkdirSync(cacheDir, { recursive: true })
      env.NPM_CONFIG_CACHE = cacheDir
    } catch {
      // Falling back to the default npm cache is acceptable.
    }
  }
  return env
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type McpTransport =
  | InstanceType<typeof StdioClientTransport>
  | InstanceType<typeof SSEClientTransport>
  | InstanceType<typeof StreamableHTTPClientTransport>

class CliMcpServerConnection {
  status: CliMcpServerStatus = 'disconnected'
  error: string | undefined
  tools: CliMcpTool[] = []
  resources: CliMcpResource[] = []
  private client: Client | null = null
  private transport: McpTransport | null = null

  constructor(readonly config: CliMcpServerConfig) {}

  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') return
    this.status = 'connecting'
    this.error = undefined
    try {
      await this.tryConnect(this.config.transport)
    } catch (error) {
      if (
        this.config.transport === 'streamable-http' &&
        this.config.autoFallback !== false &&
        this.config.url
      ) {
        try {
          await this.tryConnect('sse')
          return
        } catch (fallbackError) {
          const message =
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          this.status = 'error'
          this.error = `Streamable HTTP and SSE fallback both failed: ${message}`
          throw new Error(this.error)
        }
      }
      this.status = 'error'
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private async tryConnect(transportType: string): Promise<void> {
    await this.cleanup()
    this.client = new Client({ name: 'OpenCowork', version: '1.0.0' }, { capabilities: {} })
    this.transport = this.createTransport(transportType)
    await withTimeout(
      this.client.connect(this.transport),
      CONNECT_TIMEOUT_MS,
      `Connecting to MCP server "${this.config.name}"`
    )
    this.status = 'connected'
    this.error = undefined
    await this.refreshCapabilities()
  }

  private createTransport(transportType: string): McpTransport {
    switch (transportType) {
      case 'stdio': {
        if (!this.config.command) throw new Error('stdio transport requires a command')
        return new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: buildStdioEnv(this.config.command, this.config.env),
          cwd: this.config.cwd
        })
      }
      case 'sse': {
        if (!this.config.url) throw new Error('SSE transport requires a URL')
        return new SSEClientTransport(new URL(this.config.url), {
          requestInit: this.config.headers ? { headers: this.config.headers } : undefined
        })
      }
      case 'streamable-http': {
        if (!this.config.url) throw new Error('Streamable HTTP transport requires a URL')
        return new StreamableHTTPClientTransport(new URL(this.config.url), {
          requestInit: this.config.headers ? { headers: this.config.headers } : undefined
        })
      }
      default:
        throw new Error(`Unknown MCP transport: ${transportType}`)
    }
  }

  private async refreshCapabilities(): Promise<void> {
    if (!this.client || this.status !== 'connected') return
    try {
      this.tools = await this.fetchAllTools()
    } catch {
      this.tools = []
    }
    try {
      this.resources = await this.fetchAllResources()
    } catch {
      this.resources = []
    }
  }

  private async fetchAllTools(): Promise<CliMcpTool[]> {
    if (!this.client) return []
    const collected: CliMcpTool[] = []
    let cursor: string | undefined
    do {
      const result = await this.client.listTools(cursor ? { cursor } : undefined)
      for (const tool of result.tools ?? []) {
        collected.push({
          name: tool.name,
          description: tool.description,
          inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>
        })
      }
      cursor = result.nextCursor ?? undefined
    } while (cursor)
    return collected
  }

  private async fetchAllResources(): Promise<CliMcpResource[]> {
    if (!this.client) return []
    const collected: CliMcpResource[] = []
    let cursor: string | undefined
    do {
      const result = await this.client.listResources(cursor ? { cursor } : undefined)
      for (const resource of result.resources ?? []) {
        collected.push({
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
          mimeType: resource.mimeType
        })
      }
      cursor = result.nextCursor ?? undefined
    } while (cursor)
    return collected
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client || this.status !== 'connected') {
      throw new Error(`MCP server "${this.config.name}" is not connected`)
    }
    return await withTimeout(
      this.client.callTool({ name: toolName, arguments: args }),
      CALL_TIMEOUT_MS,
      `MCP tool ${toolName} on "${this.config.name}"`
    )
  }

  async readResource(uri: string): Promise<unknown> {
    if (!this.client || this.status !== 'connected') {
      throw new Error(`MCP server "${this.config.name}" is not connected`)
    }
    return await withTimeout(
      this.client.readResource({ uri }),
      CALL_TIMEOUT_MS,
      `MCP resource ${uri} on "${this.config.name}"`
    )
  }

  async disconnect(): Promise<void> {
    await this.cleanup()
    this.status = 'disconnected'
    this.error = undefined
    this.tools = []
    this.resources = []
  }

  private async cleanup(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        // Close failures must not block reconnection or process exit.
      }
      this.client = null
    }
    if (this.transport) {
      try {
        await this.transport.close()
      } catch {
        // Ignore close errors; child processes receive kill signals from the transport.
      }
      this.transport = null
    }
  }
}

export class CliMcpHost {
  private readonly connections = new Map<string, CliMcpServerConnection>()

  /**
   * Reconcile live connections with the persisted configuration: connect enabled
   * workspace-unbound servers, drop removed or disabled ones. Connection failures are
   * captured per server; one broken server never blocks the others or the agent turn.
   */
  async sync(configs: CliMcpServerConfig[]): Promise<void> {
    // Desktop binds some servers to specific projects. The CLI has no project scoping,
    // so it hosts only globally enabled (unbound) servers.
    const wanted = new Map(
      configs
        .filter((config) => config.enabled && !config.projectId)
        .map((config) => [config.id, config])
    )
    const removals: Promise<void>[] = []
    for (const [id, connection] of this.connections) {
      const target = wanted.get(id)
      if (!target || JSON.stringify(target) !== JSON.stringify(connection.config)) {
        this.connections.delete(id)
        removals.push(connection.disconnect().catch(() => undefined))
      }
    }
    await Promise.all(removals)

    const connects: Promise<void>[] = []
    for (const config of wanted.values()) {
      if (this.connections.has(config.id)) continue
      const connection = new CliMcpServerConnection(config)
      this.connections.set(config.id, connection)
      connects.push(connection.connect().catch(() => undefined))
    }
    await Promise.all(connects)
  }

  getServerStates(): CliMcpServerState[] {
    return Array.from(this.connections.values()).map((connection) => ({
      config: connection.config,
      status: connection.status,
      error: connection.error,
      toolCount: connection.tools.length,
      resourceCount: connection.resources.length
    }))
  }

  /** Advertised tool definitions using the shared mcp__{serverId}__{tool} naming. */
  getToolDefinitions(): WorkerToolDefinition[] {
    const definitions: WorkerToolDefinition[] = []
    for (const connection of this.connections.values()) {
      if (connection.status !== 'connected') continue
      const server = connection.config
      for (const tool of connection.tools) {
        definitions.push({
          name: mcpToolWireName(server.id, tool.name),
          description: `[MCP: ${server.name}] ${tool.description ?? tool.name}`,
          inputSchema: {
            type: 'object',
            properties: (tool.inputSchema.properties as Record<string, unknown>) ?? {},
            required: (tool.inputSchema.required as string[]) ?? []
          }
        })
      }
      for (const resource of connection.resources) {
        definitions.push({
          name: mcpResourceWireName(server.id, resource.name),
          description: `[MCP: ${server.name}] Resource: ${resource.name}${resource.description ? ` — ${resource.description}` : ''} (${resource.mimeType ?? 'unknown'})`,
          inputSchema: { type: 'object', properties: {} }
        })
      }
    }
    return definitions
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const connection = this.connections.get(serverId)
    if (!connection) throw new Error(`MCP server "${serverId}" is not hosted by this CLI session`)
    return await connection.callTool(toolName, args)
  }

  async readResource(
    serverId: string,
    reference: { uri?: string; resourceName?: string }
  ): Promise<unknown> {
    const connection = this.connections.get(serverId)
    if (!connection) throw new Error(`MCP server "${serverId}" is not hosted by this CLI session`)
    const uri =
      reference.uri ??
      connection.resources.find((resource) => resource.name === reference.resourceName)?.uri
    if (!uri) {
      throw new Error(
        reference.resourceName
          ? `MCP resource "${reference.resourceName}" not found on server ${serverId}`
          : 'MCP resource uri is required'
      )
    }
    return await connection.readResource(uri)
  }

  async dispose(): Promise<void> {
    const connections = Array.from(this.connections.values())
    this.connections.clear()
    await Promise.all(
      connections.map((connection) => connection.disconnect().catch(() => undefined))
    )
  }
}
