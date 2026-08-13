import type { McpClientWrapper } from './mcp-client'
import type { McpServerConfig, McpServerInfo } from './mcp-types'

/**
 * McpManager — manages multiple MCP server connections with lifecycle control.
 *
 * Similar pattern to PluginManager but for MCP protocol servers.
 */
export class McpManager {
  private clients = new Map<string, McpClientWrapper>()

  /** Connect to an MCP server */
  async connectServer(config: McpServerConfig): Promise<void> {
    // Disconnect existing client if any
    if (this.clients.has(config.id)) {
      await this.disconnectServer(config.id)
    }

    const { McpClientWrapper } = await import('./mcp-client')
    const client = new McpClientWrapper(config)
    this.clients.set(config.id, client)

    try {
      await client.connect()
      console.log(`[McpManager] Connected: ${config.name} (${config.id})`)
    } catch (err) {
      console.error(`[McpManager] Failed to connect ${config.name}:`, err)
      throw err
    }
  }

  /** Disconnect an MCP server */
  async disconnectServer(id: string): Promise<void> {
    const client = this.clients.get(id)
    if (!client) return

    try {
      await client.disconnect()
      console.log(`[McpManager] Disconnected: ${id}`)
    } catch (err) {
      console.error(`[McpManager] Error disconnecting ${id}:`, err)
    } finally {
      this.clients.delete(id)
    }
  }

  /** Reconnect an MCP server */
  async reconnectServer(config: McpServerConfig): Promise<void> {
    await this.disconnectServer(config.id)
    await this.connectServer(config)
  }

  /** Get full info for a single server */
  getServerInfo(id: string): McpServerInfo | undefined {
    const client = this.clients.get(id)
    if (!client) return undefined

    return {
      config: { id } as McpServerConfig, // minimal — full config comes from persistence
      status: client.status,
      tools: client.tools,
      resources: client.resources,
      prompts: client.prompts,
      error: client.error
    }
  }

  /** Get status for a server */
  getStatus(id: string): string {
    const client = this.clients.get(id)
    return client?.status ?? 'disconnected'
  }

  /** Get tools for a server */
  getTools(
    id: string
  ): { name: string; description?: string; inputSchema: Record<string, unknown> }[] {
    const client = this.clients.get(id)
    return client?.tools ?? []
  }

  /** Get resources for a server */
  getResources(
    id: string
  ): { uri: string; name: string; description?: string; mimeType?: string }[] {
    const client = this.clients.get(id)
    return client?.resources ?? []
  }

  /** Get prompts for a server */
  getPrompts(id: string): {
    name: string
    description?: string
    arguments?: Array<{ name: string; description?: string; required?: boolean }>
  }[] {
    const client = this.clients.get(id)
    return client?.prompts ?? []
  }

  /** Call a tool on a specific MCP server */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const client = this.clients.get(serverId)
    if (!client) {
      throw new Error(`MCP server ${serverId} is not connected`)
    }
    return await client.callTool(toolName, args)
  }

  /** Read a resource from a specific MCP server */
  async readResource(serverId: string, uri: string): Promise<unknown> {
    const client = this.clients.get(serverId)
    if (!client) {
      throw new Error(`MCP server ${serverId} is not connected`)
    }
    return await client.readResource(uri)
  }

  /** Get a prompt from a specific MCP server */
  async getPrompt(
    serverId: string,
    promptName: string,
    args?: Record<string, string>
  ): Promise<unknown> {
    const client = this.clients.get(serverId)
    if (!client) {
      throw new Error(`MCP server ${serverId} is not connected`)
    }
    return await client.getPrompt(promptName, args)
  }

  /** Refresh capabilities for a server */
  async refreshCapabilities(serverId: string): Promise<void> {
    const client = this.clients.get(serverId)
    if (!client) return
    await client.refreshCapabilities()
  }

  /** Check if a server is connected */
  isConnected(id: string): boolean {
    const client = this.clients.get(id)
    return client?.status === 'connected'
  }

  listConnectedServers(): Array<{
    id: string
    name: string
    description?: string
    transport: string
    projectId?: string | null
    tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[]
  }> {
    const servers: Array<{
      id: string
      name: string
      description?: string
      transport: string
      projectId?: string | null
      tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[]
    }> = []
    for (const [id, client] of this.clients) {
      if (client.status !== 'connected') continue
      const config = client.serverConfig
      servers.push({
        id,
        name: config.name,
        description: config.description,
        transport: config.transport,
        projectId: config.projectId,
        tools: client.tools
      })
    }
    return servers
  }

  /** Disconnect all servers (app shutdown) */
  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.clients.keys())
    await Promise.allSettled(ids.map((id) => this.disconnectServer(id)))
    console.log(`[McpManager] All MCP servers disconnected`)
  }
}
