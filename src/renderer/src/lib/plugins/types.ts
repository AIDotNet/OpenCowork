// ── Plugin System — Renderer-side Types ──
// Mirrors main process types for use in renderer

export interface ConfigFieldSchema {
  key: string
  label: string
  type: 'text' | 'secret'
  placeholder?: string
  required?: boolean
}

export interface PluginProviderDescriptor {
  type: string
  displayName: string
  description: string
  icon: string
  builtin?: boolean
  configSchema: ConfigFieldSchema[]
}

export interface PluginFeatures {
  autoReply: boolean
  streamingReply: boolean
  autoStart: boolean
}

/** Security permissions for a plugin instance */
export interface PluginPermissions {
  allowReadHome: boolean
  readablePathPrefixes: string[]
  allowWriteOutside: boolean
  allowShell: boolean
  allowSubAgents: boolean
}

export const DEFAULT_PLUGIN_PERMISSIONS: PluginPermissions = {
  allowReadHome: false,
  readablePathPrefixes: [],
  allowWriteOutside: false,
  allowShell: false,
  allowSubAgents: true,
}

export interface PluginInstance {
  id: string
  type: string
  name: string
  enabled: boolean
  builtin?: boolean
  userSystemPrompt: string
  config: Record<string, string>
  createdAt: number
  /** Provider ID for this plugin's auto-reply agent (null = use global active provider) */
  providerId?: string | null
  /** Model override for this plugin's auto-reply agent (null = use global default) */
  model?: string | null
  /** Feature toggles */
  features?: PluginFeatures
  /** Security permissions (defaults applied if missing) */
  permissions?: PluginPermissions
}

export interface PluginMessage {
  id: string
  senderId: string
  senderName: string
  chatId: string
  chatName?: string
  content: string
  timestamp: number
  raw?: unknown
}

export interface PluginGroup {
  id: string
  name: string
  memberCount?: number
  raw?: unknown
}

export interface PluginIncomingEvent {
  type: 'incoming_message' | 'error' | 'status_change'
  pluginId: string
  pluginType: string
  data: unknown
}
