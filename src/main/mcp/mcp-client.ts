import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig, McpServerStatus, McpTool, McpResource, McpPrompt } from './mcp-types'

function buildProcessEnv(): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) base[key] = value
  }
  return base
}

function isNpmCommand(command: string): boolean {
  const name = basename(command).toLowerCase().replace(/\.(cmd|exe)$/, '')
  return name === 'npm' || name === 'npx'
}

function defaultNpmCacheDir(): string {
  return join(homedir(), '.open-cowork', 'npm-cache')
}

function buildStdioEnv(
  command: string,
  configuredEnv?: Record<string, string>
): Record<string, string> | undefined {
  if (!configuredEnv && !isNpmCommand(command)) {
    return undefined
  }

  const env = { ...buildProcessEnv(), ...(configuredEnv ?? {}) }
  if (isNpmCommand(command) && !env.NPM_CONFIG_CACHE && !env.npm_config_cache) {
    const cacheDir = defaultNpmCacheDir()
    try {
      mkdirSync(cacheDir, { recursive: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[MCP] Failed to create npm cache dir ${cacheDir}: ${message}`)
    }
    env.NPM_CONFIG_CACHE = cacheDir
  }
  return env
}

/**
 * McpClientWrapper — wraps @modelcontextprotocol/sdk Client for a single MCP server.
 *
 * Handles transport creation (stdio / SSE / Streamable HTTP),
 * auto-fallback from Streamable HTTP → SSE, and capability caching.
 */
export class McpClientWrapper {
  private client: Client | null = null
  private transport:
    | InstanceType<typeof StdioClientTransport>
    | InstanceType<typeof SSEClientTransport>
    | InstanceType<typeof StreamableHTTPClientTransport>
    | null = null

  private _status: McpServerStatus = 'disconnected'
  private _error: string | undefined
  private _tools: McpTool[] = []
  private _resources: McpResource[] = []
  private _prompts: McpPrompt[] = []
  private _usedFallback = false

  constructor(private config: McpServerConfig) {}

  get status(): McpServerStatus {
    return this._status
  }
  get error(): string | undefined {
    return this._error
  }
  get tools(): McpTool[] {
    return this._tools
  }
  get resources(): McpResource[] {
    return this._resources
  }
  get prompts(): McpPrompt[] {
    return this._prompts
  }
  get usedFallback(): boolean {
    return this._usedFallback
  }

  /** Connect to the MCP server using the configured transport */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') return

    this._status = 'connecting'
    this._error = undefined
    this._usedFallback = false

    try {
      await this.tryConnect(this.config.transport)
    } catch (err) {
      // Auto-fallback: Streamable HTTP → SSE
      if (
        this.config.transport === 'streamable-http' &&
        this.config.autoFallback !== false &&
        this.config.url
      ) {
        console.log(`[MCP:${this.config.name}] Streamable HTTP failed, falling back to SSE...`)
        try {
          await this.tryConnect('sse')
          this._usedFallback = true
          return
        } catch (fallbackErr) {
          const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
          this._status = 'error'
          this._error = `Streamable HTTP and SSE fallback both failed: ${msg}`
          throw new Error(this._error)
        }
      }

      const msg = err instanceof Error ? err.message : String(err)
      this._status = 'error'
      this._error = msg
      throw err
    }
  }

  /** Internal: attempt connection with a specific transport type */
  private async tryConnect(transportType: string): Promise<void> {
    // Clean up any existing client
    await this.cleanupClient()

    this.client = new Client({ name: 'OpenCowork', version: '1.0.0' }, { capabilities: {} })

    this.transport = this.createTransport(transportType)
    await this.client.connect(this.transport)

    this._status = 'connected'
    this._error = undefined

    // Cache capabilities
    await this.refreshCapabilities()

    console.log(
      `[MCP:${this.config.name}] Connected via ${transportType} — ` +
        `${this._tools.length} tools, ${this._resources.length} resources, ${this._prompts.length} prompts`
    )
  }

  /** Create the transport instance based on type */
  private createTransport(
    transportType: string
  ):
    | InstanceType<typeof StdioClientTransport>
    | InstanceType<typeof SSEClientTransport>
    | InstanceType<typeof StreamableHTTPClientTransport> {
    switch (transportType) {
      case 'stdio':
        if (!this.config.command) {
          throw new Error('stdio transport requires a command')
        }
        {
          const mergedEnv = buildStdioEnv(this.config.command, this.config.env)
          return new StdioClientTransport({
            command: this.config.command,
            args: this.config.args,
            env: mergedEnv,
            cwd: this.config.cwd
          })
        }

      case 'sse':
        if (!this.config.url) {
          throw new Error('SSE transport requires a URL')
        }
        return new SSEClientTransport(new URL(this.config.url), {
          requestInit: this.config.headers ? { headers: this.config.headers } : undefined
        })

      case 'streamable-http':
        if (!this.config.url) {
          throw new Error('Streamable HTTP transport requires a URL')
        }
        return new StreamableHTTPClientTransport(new URL(this.config.url), {
          requestInit: this.config.headers ? { headers: this.config.headers } : undefined
        })

      default:
        throw new Error(`Unknown transport type: ${transportType}`)
    }
  }

  /** Disconnect from the MCP server */
  async disconnect(): Promise<void> {
    await this.cleanupClient()
    this._status = 'disconnected'
    this._error = undefined
    this._tools = []
    this._resources = []
    this._prompts = []
    console.log(`[MCP:${this.config.name}] Disconnected`)
  }

  /** Refresh cached tools, resources, and prompts from the server */
  async refreshCapabilities(): Promise<void> {
    if (!this.client || this._status !== 'connected') return

    try {
      // List tools (handle pagination)
      try {
        this._tools = await this.fetchAllTools()
      } catch {
        this._tools = []
      }

      // List resources (handle pagination)
      try {
        this._resources = await this.fetchAllResources()
      } catch {
        this._resources = []
      }

      // List prompts (handle pagination)
      try {
        this._prompts = await this.fetchAllPrompts()
      } catch {
        this._prompts = []
      }
    } catch (err) {
      console.error(`[MCP:${this.config.name}] Failed to refresh capabilities:`, err)
    }
  }

  /** Call a tool on the MCP server */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client || this._status !== 'connected') {
      throw new Error(`MCP server "${this.config.name}" is not connected`)
    }
    const result = await this.client.callTool({ name: toolName, arguments: args })
    return result
  }

  /** Read a resource from the MCP server */
  async readResource(uri: string): Promise<unknown> {
    if (!this.client || this._status !== 'connected') {
      throw new Error(`MCP server "${this.config.name}" is not connected`)
    }
    const result = await this.client.readResource({ uri })
    return result
  }

  /** Get a prompt from the MCP server */
  async getPrompt(name: string, args?: Record<string, string>): Promise<unknown> {
    if (!this.client || this._status !== 'connected') {
      throw new Error(`MCP server "${this.config.name}" is not connected`)
    }
    const result = await this.client.getPrompt({ name, arguments: args })
    return result
  }

  /** Fetch all tools with pagination */
  private async fetchAllTools(): Promise<McpTool[]> {
    if (!this.client) return []

    const collected: McpTool[] = []
    let cursor: string | undefined

    do {
      const result = await this.client.listTools(cursor ? { cursor } : undefined)
      const pageTools = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>
      }))
      collected.push(...pageTools)
      cursor = result.nextCursor ?? undefined
    } while (cursor)

    return collected
  }

  /** Fetch all resources with pagination */
  private async fetchAllResources(): Promise<McpResource[]> {
    if (!this.client) return []

    const collected: McpResource[] = []
    let cursor: string | undefined

    do {
      const result = await this.client.listResources(cursor ? { cursor } : undefined)
      const pageResources = (result.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType
      }))
      collected.push(...pageResources)
      cursor = result.nextCursor ?? undefined
    } while (cursor)

    return collected
  }

  /** Fetch all prompts with pagination */
  private async fetchAllPrompts(): Promise<McpPrompt[]> {
    if (!this.client) return []

    const collected: McpPrompt[] = []
    let cursor: string | undefined

    do {
      const result = await this.client.listPrompts(cursor ? { cursor } : undefined)
      const pagePrompts = (result.prompts ?? []).map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments?.map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required
        }))
      }))
      collected.push(...pagePrompts)
      cursor = result.nextCursor ?? undefined
    } while (cursor)

    return collected
  }

  /** Clean up existing client and transport */
  private async cleanupClient(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        // Ignore close errors
      }
      this.client = null
    }
    if (this.transport) {
      try {
        await this.transport.close()
      } catch {
        // Ignore close errors
      }
      this.transport = null
    }
  }
}
