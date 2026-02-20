// ── Plugin System — Shared Types ──

/** Config field schema for descriptor-driven UI */
export interface ConfigFieldSchema {
  key: string
  label: string
  type: 'text' | 'secret'
  placeholder?: string
  required?: boolean
}

/** Static metadata describing a plugin provider type */
export interface PluginProviderDescriptor {
  type: string
  displayName: string
  description: string
  icon: string
  builtin?: boolean
  configSchema: ConfigFieldSchema[]
}

/** Security permissions for a plugin instance */
export interface PluginPermissions {
  /** Allow reading files outside the plugin working directory under home (~) */
  allowReadHome: boolean
  /** Whitelist of absolute path prefixes the plugin can read (when allowReadHome=false) */
  readablePathPrefixes: string[]
  /** Allow writing files outside the plugin working directory */
  allowWriteOutside: boolean
  /** Allow executing shell commands */
  allowShell: boolean
  /** Allow using sub-agent tools (Task/CodeSearch etc.) */
  allowSubAgents: boolean
}

/** Feature toggles for a plugin instance */
export interface PluginFeatures {
  /** Auto-reply to incoming messages using the Agent */
  autoReply: boolean
  /** Stream responses back to the chat in real-time via CardKit */
  streamingReply: boolean
  /** Auto-start the plugin service when the app launches */
  autoStart: boolean
}

/** Persisted plugin instance configuration */
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

/** Normalized message format returned by all providers */
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

/** Normalized group/chat format */
export interface PluginGroup {
  id: string
  name: string
  memberCount?: number
  raw?: unknown
}

/** Events emitted by plugin services */
export interface PluginEvent {
  type: 'incoming_message' | 'error' | 'status_change'
  pluginId: string
  pluginType: string
  data: unknown
}

/** Incoming message event data */
export interface PluginIncomingMessageData {
  chatId: string
  senderId: string
  senderName: string
  content: string
  messageId: string
  /** Message timestamp in milliseconds */
  timestamp?: number
  /** Base64-encoded image attachments from the incoming message */
  images?: Array<{ base64: string; mediaType: string }>
  /** Original message type from the platform (e.g. text, image, file) */
  msgType?: string
  /** Resolved chat/group name from the platform */
  chatName?: string
  /** Chat type: p2p (private) or group */
  chatType?: 'p2p' | 'group'
}

/** Streaming message handle — allows incremental updates to a sent message */
export interface StreamingHandle {
  /** Update the streaming message content (accumulated, not delta) */
  update(content: string): Promise<void>
  /** Finalize the streaming message */
  finish(finalContent: string): Promise<void>
}

/** Runtime service interface — every messaging plugin must implement this */
export interface MessagingPluginService {
  readonly pluginId: string
  readonly pluginType: string

  // Lifecycle
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean

  // Unified messaging operations
  sendMessage(chatId: string, content: string): Promise<{ messageId: string }>
  replyMessage(messageId: string, content: string): Promise<{ messageId: string }>
  getGroupMessages(chatId: string, count?: number): Promise<PluginMessage[]>
  listGroups(): Promise<PluginGroup[]>

  // Streaming output (optional — override in services that support it)
  supportsStreaming?: boolean
  sendStreamingMessage?(chatId: string, initialContent: string, replyToMessageId?: string): Promise<StreamingHandle>
}

/** Factory function type — registered per provider */
export type ServiceFactory = (
  instance: PluginInstance,
  notify: (event: PluginEvent) => void
) => MessagingPluginService

/** WebSocket message parser — converts raw WS frames to normalized data */
export type WsMessageParser = (raw: string) => PluginIncomingMessageData | null
