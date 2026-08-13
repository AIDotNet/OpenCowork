import { decodePersistedStoreState } from '../settings-handlers'
import { getConfigValue } from '../secure-key-store'
import { tryGetActiveMcpManager } from '../mcp-handlers'
import { nativeExtensionRequest } from '../extension-native-bridge'
import { readChannelPlugins } from '../../channels/channel-config-store'
import type { ExtensionInstance } from '../../../shared/extension-types'
import {
  buildActiveMcpPromptSection,
  buildProjectChannelsPromptSection,
  selectTeamCoordinatorForSession,
  type TeamCoordinatorSnapshot
} from '../../../shared/agent-system-prompt'
import type { SessionToolDefinition } from './session-tool-catalog'
import { toHostedDynamicTool } from './session-tool-families'

const GLOBAL_SCOPE = '__global__'
const APP_PLUGIN_STORE_KEY = 'opencowork-app-plugins'
const EXTENSION_ACTIVATION_STORE_KEY = 'opencowork-extension-activation'
const TEAM_STORE_KEY = 'opencowork-team'

const APP_PLUGIN_DEFAULTS: Record<string, boolean> = {
  image: true,
  browser: true,
  'desktop-control': false,
  codegraph: false
}

export type HostedAppPluginFlags = {
  browserEnabled: boolean
  imageGenerateEnabled: boolean
  desktopControlEnabled: boolean
}

export type HostedPromptContextSections = {
  mcpSection: string | null
  channelSection: string | null
}

function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`
}

function extensionToolName(extensionId: string, toolName: string): string {
  return `extension__${extensionId}__${toolName}`
}

function serverVisibleForProject(
  serverProjectId: string | null | undefined,
  projectId: string | null
): boolean {
  if (!serverProjectId) return true
  return serverProjectId === projectId
}

async function readPersistedConfigState<T>(key: string): Promise<T | null> {
  try {
    return decodePersistedStoreState<T>(await getConfigValue(key))
  } catch {
    return null
  }
}

export async function readHostedAppPluginFlags(
  projectId: string | null
): Promise<HostedAppPluginFlags> {
  const persisted = await readPersistedConfigState<{
    pluginsByProject?: Record<string, Array<{ id?: string; enabled?: boolean }>>
  }>(APP_PLUGIN_STORE_KEY)
  const byProject = persisted?.pluginsByProject ?? {}
  const globalPlugins = Array.isArray(byProject[GLOBAL_SCOPE]) ? byProject[GLOBAL_SCOPE] : []
  const projectPlugins =
    projectId && Array.isArray(byProject[projectId]) ? byProject[projectId] : []

  const resolve = (id: string): boolean => {
    const project = projectPlugins.find((plugin) => plugin.id === id)
    if (id !== 'codegraph' && typeof project?.enabled === 'boolean') return project.enabled
    const global = globalPlugins.find((plugin) => plugin.id === id)
    if (typeof global?.enabled === 'boolean') return global.enabled
    return APP_PLUGIN_DEFAULTS[id] === true
  }

  return {
    browserEnabled: resolve('browser'),
    imageGenerateEnabled: resolve('image'),
    desktopControlEnabled: resolve('desktop-control')
  }
}

export async function loadHostedMcpTools(projectId: string | null): Promise<{
  tools: SessionToolDefinition[]
  servers: Array<{
    id: string
    name: string
    transport: string
    description?: string
    toolNames: string[]
  }>
}> {
  const manager = tryGetActiveMcpManager()
  if (!manager) return { tools: [], servers: [] }
  const servers = manager
    .listConnectedServers()
    .filter((server) => serverVisibleForProject(server.projectId, projectId))
  const tools: SessionToolDefinition[] = []
  const promptServers: Array<{
    id: string
    name: string
    transport: string
    description?: string
    toolNames: string[]
  }> = []
  for (const server of servers) {
    const toolNames: string[] = []
    for (const tool of server.tools) {
      const name = mcpToolName(server.id, tool.name)
      toolNames.push(name)
      const mapped = toHostedDynamicTool({
        name,
        description: `[MCP: ${server.name}] ${tool.description ?? tool.name}`,
        inputSchema: tool.inputSchema
      })
      if (mapped) tools.push(mapped)
    }
    promptServers.push({
      id: server.id,
      name: server.name,
      transport: server.transport,
      description: server.description,
      toolNames
    })
  }
  return { tools, servers: promptServers }
}

export async function loadHostedExtensionTools(
  projectId: string | null
): Promise<SessionToolDefinition[]> {
  let extensions: ExtensionInstance[] = []
  try {
    const listed = await nativeExtensionRequest<ExtensionInstance[]>('extension/list')
    extensions = Array.isArray(listed) ? listed : []
  } catch {
    return []
  }
  const activation = await readPersistedConfigState<{
    activeExtensionIdsByProject?: Record<string, string[]>
  }>(EXTENSION_ACTIVATION_STORE_KEY)
  const activeIds = new Set(
    activation?.activeExtensionIdsByProject?.[projectId ?? GLOBAL_SCOPE] ?? []
  )
  if (activeIds.size === 0) return []
  const tools: SessionToolDefinition[] = []
  for (const extension of extensions) {
    if (!extension.enabled || !activeIds.has(extension.id)) continue
    for (const tool of extension.manifest.tools ?? []) {
      const mapped = toHostedDynamicTool({
        name: extensionToolName(extension.id, tool.name),
        description: `[Extension: ${extension.manifest.name}] ${tool.description}`,
        inputSchema: tool.inputSchema
      })
      if (mapped) tools.push(mapped)
    }
  }
  return tools
}

export async function loadHostedChannelContext(projectId: string | null): Promise<{
  pluginToolsEnabled: boolean
  channels: Array<{ id: string; name: string; type: string }>
}> {
  try {
    const plugins = await readChannelPlugins()
    const channels = plugins
      .filter((plugin) => plugin.enabled)
      .filter((plugin) => !plugin.projectId || plugin.projectId === projectId)
      .map((plugin) => ({ id: plugin.id, name: plugin.name, type: plugin.type }))
    return { pluginToolsEnabled: channels.length > 0, channels }
  } catch {
    return { pluginToolsEnabled: false, channels: [] }
  }
}

export async function loadHostedActiveTeam(
  sessionId: string
): Promise<TeamCoordinatorSnapshot | null> {
  const persisted = await readPersistedConfigState<{
    activeTeam?: (TeamCoordinatorSnapshot & { sessionId?: string | null }) | null
  }>(TEAM_STORE_KEY)
  return selectTeamCoordinatorForSession(persisted, sessionId)
}

export async function loadHostedPromptContextSections(
  projectId: string | null
): Promise<HostedPromptContextSections> {
  const [mcp, channels] = await Promise.all([
    loadHostedMcpTools(projectId),
    loadHostedChannelContext(projectId)
  ])
  return {
    mcpSection: buildActiveMcpPromptSection(mcp.servers),
    channelSection: buildProjectChannelsPromptSection(channels.channels)
  }
}

export function joinPromptRuleSections(
  userRules: string | null | undefined,
  sections: Array<string | null | undefined>
): string | undefined {
  const parts = [userRules?.trim(), ...sections.map((section) => section?.trim())].filter(
    (part): part is string => Boolean(part)
  )
  return parts.length > 0 ? parts.join('\n') : undefined
}
