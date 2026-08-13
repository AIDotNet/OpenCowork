import { getNativeWorker } from '../../lib/native-worker'
import { readPersistedProviderStore } from '../../lib/ai-provider-store'
import {
  buildProviderConfigById,
  getFastProviderConfig,
  type PersistedProvidersState
} from '../../lib/provider-run-config'
import { getSession } from '../../db/sessions-dao'
import { getMessages } from '../../db/messages-dao'
import { getSshConnection } from '../../db/ssh-dao'
import {
  decodePersistedStoreState,
  readPermissionPolicySnapshot,
  readPersistedSettingsState
} from '../settings-handlers'
import { nativeSkillsRequest, type SkillInfo } from '../skills-handlers'
import { AgentSessionService } from './agent-session-service'
import { assembleSessionContext, type SessionRecord } from './run-context-assembler'
import { loadHostedMemoryContext } from './session-memory-context'
import {
  joinPromptRuleSections,
  loadHostedActiveTeam,
  loadHostedChannelContext,
  loadHostedExtensionTools,
  loadHostedMcpTools,
  loadHostedPromptContextSections,
  readHostedAppPluginFlags
} from './session-host-catalog'
import { readSessionRunSettings, type SessionRunSettings } from './session-run-settings'
import { buildHostedSessionSystemPrompt } from './session-system-prompt'
import {
  buildSkillToolDefinition,
  listSessionTools,
  toRuntimeToolCatalogEntries,
  type SessionToolDefinition
} from './session-tool-catalog'
import { toCodeGraphSessionTool } from './session-tool-families'

function loadPersistedProvidersState(): PersistedProvidersState {
  return (
    decodePersistedStoreState<PersistedProvidersState>(readPersistedProviderStore()) ?? {
      providers: []
    }
  )
}

function resolveProviderFromStore(
  providerId: string,
  modelId: string
): Record<string, unknown> | null {
  if (!providerId || !modelId) return null
  const config = buildProviderConfigById(
    loadPersistedProvidersState(),
    readPersistedSettingsState(),
    providerId,
    modelId
  )
  return config ? { ...config } : null
}

async function loadHostedSkills(): Promise<SkillInfo[]> {
  try {
    const skills = await nativeSkillsRequest<SkillInfo[]>('skills/list')
    return Array.isArray(skills) ? skills : []
  } catch {
    return []
  }
}

async function loadSshPromptConnection(sshConnectionId: string | null): Promise<{
  name?: string | null
  host?: string | null
  defaultDirectory?: string | null
} | null> {
  if (!sshConnectionId) return null
  try {
    const row = await getSshConnection(sshConnectionId)
    if (!row) return null
    return {
      name: row.name,
      host: row.host,
      defaultDirectory: row.default_directory
    }
  } catch {
    return null
  }
}

async function loadCodeGraphExtraTools(
  settings: SessionRunSettings
): Promise<SessionToolDefinition[]> {
  if (!settings.codegraphEnabled || !settings.codegraphFullToolSurface) return []
  const worker = getNativeWorker()
  if (!worker.isRunning) return []
  try {
    const listed = (await worker.request('codegraph/tools-list', {}, 30_000)) as {
      tools?: Array<{
        name?: string
        description?: string
        inputSchema?: Record<string, unknown>
      }>
    }
    const tools = Array.isArray(listed?.tools) ? listed.tools : []
    return tools
      .map((tool) => toCodeGraphSessionTool(tool))
      .filter(
        (tool): tool is SessionToolDefinition => tool != null && tool.name !== 'codegraph_explore'
      )
  } catch {
    return []
  }
}

async function listHostedSessionTools(projectId: string | null): Promise<SessionToolDefinition[]> {
  const settings = readSessionRunSettings()
  const [skills, codegraphExtras, appPlugins, mcp, extensions, channels] = await Promise.all([
    loadHostedSkills(),
    loadCodeGraphExtraTools(settings),
    readHostedAppPluginFlags(projectId),
    loadHostedMcpTools(projectId),
    loadHostedExtensionTools(projectId),
    loadHostedChannelContext(projectId)
  ])
  return listSessionTools({
    webSearchEnabled: settings.webSearchEnabled,
    teamToolsEnabled: settings.teamToolsEnabled,
    codegraphEnabled: settings.codegraphEnabled,
    includePowerShell: process.platform === 'win32',
    browserEnabled: appPlugins.browserEnabled,
    desktopControlEnabled: appPlugins.desktopControlEnabled,
    imageGenerateEnabled: appPlugins.imageGenerateEnabled,
    pluginToolsEnabled: channels.pluginToolsEnabled,
    extraTools: [buildSkillToolDefinition(skills), ...codegraphExtras, ...mcp.tools, ...extensions]
  })
}

let service: AgentSessionService | null = null

export function getAgentSessionService(): AgentSessionService {
  if (!service) {
    service = new AgentSessionService({
      isRunning: () => getNativeWorker().isRunning,
      request: (method, params, timeoutMs) => getNativeWorker().request(method, params, timeoutMs),
      assemble: (intent) =>
        assembleSessionContext(intent, {
          getSession: async (sessionId) => {
            const row = await getSession(sessionId)
            if (!row) return null
            return {
              id: row.id,
              mode: row.mode,
              workingFolder: row.working_folder,
              sshConnectionId: row.ssh_connection_id,
              projectId: row.project_id,
              providerId: row.provider_id,
              modelId: row.model_id
            } satisfies SessionRecord
          },
          getMessages: async (sessionId) => {
            const rows = await getMessages(sessionId)
            return rows.map((row) => ({
              id: row.id,
              role: row.role,
              content: row.content,
              createdAt: row.created_at
            }))
          },
          resolveProvider: resolveProviderFromStore,
          readPermissionPolicy: () => readPermissionPolicySnapshot() ?? null,
          listTools: ({ projectId }) => listHostedSessionTools(projectId),
          readRunSettings: () => readSessionRunSettings(),
          resolveSystemPrompt: async ({
            sessionId,
            mode,
            workingFolder,
            sshConnectionId,
            toolNames,
            projectId
          }) => {
            const settings = readPersistedSettingsState()
            const runSettings = readSessionRunSettings(settings)
            const [skills, sshConnection, memoryContext, promptSections, activeTeam] =
              await Promise.all([
                loadHostedSkills(),
                loadSshPromptConnection(sshConnectionId),
                loadHostedMemoryContext({
                  workingFolder,
                  sshConnectionId,
                  memoryUseMemories: runSettings.memoryUseMemories,
                  memorySummaryBudgetTokens: runSettings.memorySummaryBudgetTokens
                }),
                loadHostedPromptContextSections(projectId),
                loadHostedActiveTeam(sessionId)
              ])
            return buildHostedSessionSystemPrompt({
              mode,
              workingFolder,
              sshConnectionId,
              toolNames,
              language: typeof settings.language === 'string' ? settings.language : 'en',
              userRules: joinPromptRuleSections(
                typeof settings.systemPrompt === 'string' ? settings.systemPrompt : '',
                [promptSections.channelSection, promptSections.mcpSection]
              ),
              skills,
              sshConnection,
              memoryContext,
              activeTeam
            })
          },
          resolveSubAgentProvider: () => {
            const config = getFastProviderConfig(
              loadPersistedProvidersState(),
              readPersistedSettingsState()
            )
            return config ? { ...config } : null
          }
        })
    })
  }
  return service
}

export async function getHostedSessionToolCatalog(args: {
  sessionId: string
  mode: string
}): Promise<ReturnType<typeof toRuntimeToolCatalogEntries>> {
  const row = args.sessionId ? await getSession(args.sessionId) : null
  return toRuntimeToolCatalogEntries(await listHostedSessionTools(row?.project_id ?? null))
}
