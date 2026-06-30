import { ipcMain } from 'electron'
import { getNativeWorker } from '../lib/native-worker'
import { McpManager } from '../mcp/mcp-manager'
import type { McpServerConfig } from '../mcp/mcp-types'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'

const MCP_CONFIG_TIMEOUT_MS = 60_000

let activeMcpManager: McpManager | null = null

type McpCallToolArgs = {
  serverId: string
  toolName: string
  args: Record<string, unknown>
}

type McpReadResourceArgs = {
  serverId: string
  uri?: string
  resourceName?: string
}

// ── Native config persistence ──

async function readServers(): Promise<McpServerConfig[]> {
  try {
    return await getNativeWorker().request<McpServerConfig[]>(
      'mcp/config-list',
      {},
      MCP_CONFIG_TIMEOUT_MS
    )
  } catch (err) {
    console.error('[MCP] Config read error:', err)
    return []
  }
}

async function addServer(config: McpServerConfig): Promise<{ success: boolean; error?: string }> {
  return await getNativeWorker().request('mcp/config-add', config, MCP_CONFIG_TIMEOUT_MS)
}

async function updateServer(
  id: string,
  patch: Partial<McpServerConfig>
): Promise<{ success: boolean; error?: string }> {
  return await getNativeWorker().request('mcp/config-update', { id, patch }, MCP_CONFIG_TIMEOUT_MS)
}

async function removeServer(id: string): Promise<{ success: boolean; error?: string }> {
  return await getNativeWorker().request('mcp/config-remove', id, MCP_CONFIG_TIMEOUT_MS)
}

function registerMcpMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(args))
  })
}

export async function autoConnectMcpServers(mcpManager: McpManager): Promise<void> {
  const servers = (await readServers()).filter((server) => server.enabled)

  await Promise.allSettled(
    servers.map(async (server) => {
      try {
        await mcpManager.connectServer(server)
      } catch (err) {
        console.error(`[MCP] Auto-connect failed for ${server.name} (${server.id}):`, err)
      }
    })
  )
}

// ── Register IPC handlers ──

export function registerMcpHandlers(mcpManager: McpManager): void {
  activeMcpManager = mcpManager

  // List all configured MCP servers
  registerMcpMessagePackHandler<undefined>('mcp:list', async () => {
    return await readServers()
  })

  // Add a new MCP server config
  registerMcpMessagePackHandler<McpServerConfig>('mcp:add', async (config) => {
    return await addServer(config)
  })

  // Update an MCP server config
  registerMcpMessagePackHandler<{ id: string; patch: Partial<McpServerConfig> }>(
    'mcp:update',
    async ({ id, patch }) => {
      return await updateServer(id, patch)
    }
  )

  // Remove an MCP server config
  registerMcpMessagePackHandler<string>('mcp:remove', async (id) => {
    await mcpManager.disconnectServer(id)
    return await removeServer(id)
  })

  // Connect to an MCP server
  registerMcpMessagePackHandler<string>('mcp:connect', async (id) => {
    const servers = await readServers()
    const config = servers.find((s) => s.id === id)
    if (!config) return { success: false, error: 'Server not found' }

    try {
      await mcpManager.connectServer(config)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })

  // Disconnect from an MCP server
  registerMcpMessagePackHandler<string>('mcp:disconnect', async (id) => {
    await mcpManager.disconnectServer(id)
    return { success: true }
  })

  // Get server status
  registerMcpMessagePackHandler<string>('mcp:status', (id) => {
    return mcpManager.getStatus(id)
  })

  // Get full server info (status + capabilities)
  registerMcpMessagePackHandler<string>('mcp:server-info', (id) => {
    return mcpManager.getServerInfo(id)
  })

  // Get all servers info (config + runtime status + capabilities)
  registerMcpMessagePackHandler<undefined>('mcp:all-servers-info', async () => {
    const servers = await readServers()
    return servers.map((config) => {
      const info = mcpManager.getServerInfo(config.id)
      return {
        config,
        status: info?.status ?? 'disconnected',
        tools: info?.tools ?? [],
        resources: info?.resources ?? [],
        prompts: info?.prompts ?? [],
        error: info?.error
      }
    })
  })

  // List tools for a specific server
  registerMcpMessagePackHandler<string>('mcp:list-tools', (id) => {
    return mcpManager.getTools(id)
  })

  // Call a tool on an MCP server
  registerMcpMessagePackHandler<McpCallToolArgs>('mcp:call-tool', async (args) => {
    return await executeMcpToolFromMain(args)
  })

  // Read a resource from an MCP server
  registerMcpMessagePackHandler<McpReadResourceArgs>('mcp:read-resource', async (args) => {
    return await readMcpResourceFromMain(args)
  })

  // List resources for a server
  registerMcpMessagePackHandler<string>('mcp:list-resources', (id) => {
    return mcpManager.getResources(id)
  })

  // Get a prompt from an MCP server
  registerMcpMessagePackHandler<{
    serverId: string
    promptName: string
    args?: Record<string, string>
  }>('mcp:get-prompt', async ({ serverId, promptName, args }) => {
    try {
      const result = await mcpManager.getPrompt(serverId, promptName, args)
      return { success: true, result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })

  // List prompts for a server
  registerMcpMessagePackHandler<string>('mcp:list-prompts', (id) => {
    return mcpManager.getPrompts(id)
  })

  // Refresh capabilities for a server
  registerMcpMessagePackHandler<string>('mcp:refresh-capabilities', async (id) => {
    try {
      await mcpManager.refreshCapabilities(id)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })
}

function getActiveMcpManager(): McpManager {
  if (!activeMcpManager) {
    throw new Error('MCP manager is not initialized')
  }
  return activeMcpManager
}

export async function executeMcpToolFromMain({
  serverId,
  toolName,
  args
}: McpCallToolArgs): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    const result = await getActiveMcpManager().callTool(serverId, toolName, args)
    return { success: true, result }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}

export async function readMcpResourceFromMain({
  serverId,
  uri,
  resourceName
}: McpReadResourceArgs): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    const manager = getActiveMcpManager()
    const resolvedUri =
      uri ?? manager.getResources(serverId).find((resource) => resource.name === resourceName)?.uri

    if (!resolvedUri) {
      return {
        success: false,
        error: resourceName
          ? `MCP resource "${resourceName}" not found on server ${serverId}`
          : 'MCP resource uri is required'
      }
    }

    const result = await manager.readResource(serverId, resolvedUri)
    return { success: true, result }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
