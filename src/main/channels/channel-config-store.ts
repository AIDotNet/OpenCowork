import { getNativeWorker } from '../lib/native-worker'
import type { ChannelInstance } from './channel-types'

const CHANNEL_CONFIG_TIMEOUT_MS = 60_000

type MutationResult = {
  success: boolean
  error?: string
}

export async function readChannelPlugins(): Promise<ChannelInstance[]> {
  try {
    return await getNativeWorker().request<ChannelInstance[]>(
      'channel/config-list',
      {},
      CHANNEL_CONFIG_TIMEOUT_MS
    )
  } catch (err) {
    console.error('[Channels] Config read error:', err)
    return []
  }
}

export async function writeChannelPlugins(plugins: ChannelInstance[]): Promise<void> {
  const result = await getNativeWorker().request<MutationResult>(
    'channel/config-write',
    plugins,
    CHANNEL_CONFIG_TIMEOUT_MS
  )
  if (!result.success) {
    throw new Error(result.error ?? 'Channel config write failed')
  }
}

export async function getChannelPlugin(id: string): Promise<ChannelInstance | null> {
  const result = await getNativeWorker().request<{ plugin?: ChannelInstance | null }>(
    'channel/config-get',
    id,
    CHANNEL_CONFIG_TIMEOUT_MS
  )
  return result.plugin ?? null
}

export async function isChannelPluginToolEnabled(
  pluginId: string,
  toolName: string
): Promise<boolean> {
  const plugin = await getChannelPlugin(pluginId)
  if (!plugin?.tools) return true
  return plugin.tools[toolName] !== false
}
