// SSH IPC contract — single source of truth for the config-domain channel
// names and payload shapes shared between the main process and the renderer.
// Terminal / fs / transfer domains join this file as they are migrated
// (see plan/ssh-rewrite/02-rewrite-design.md, M1/M2).

export type SshAuthType = 'password' | 'privateKey' | 'agent'

export const SSH_CONFIG_CHANNELS = {
  groupList: 'ssh:group:list',
  groupCreate: 'ssh:group:create',
  groupUpdate: 'ssh:group:update',
  groupDelete: 'ssh:group:delete',
  connectionList: 'ssh:connection:list',
  connectionCreate: 'ssh:connection:create',
  connectionUpdate: 'ssh:connection:update',
  connectionDelete: 'ssh:connection:delete',
  connectionTest: 'ssh:connection:test',
  export: 'ssh:export',
  importPreview: 'ssh:import:preview',
  importApply: 'ssh:import:apply',
  configChanged: 'ssh:config:changed'
} as const

// ── Wire rows (snake_case, what the renderer receives today) ──

export interface SshWireGroup {
  id: string
  name: string
  sort_order: number
  created_at: number
  updated_at: number
}

// Secrets never cross this boundary: no password/passphrase fields exist on
// the wire row, only presence flags.
export interface SshWireConnection {
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

// ── Mutation inputs (camelCase, renderer → main) ──

export interface SshConnectionCreateArgs {
  id: string
  groupId?: string
  name: string
  host: string
  port?: number
  username: string
  authType?: SshAuthType
  password?: string
  privateKeyPath?: string
  passphrase?: string
  startupCommand?: string
  defaultDirectory?: string
  proxyJump?: string
  keepAliveInterval?: number
  sortOrder?: number
}

// For secrets: undefined = keep as stored, null = clear, string = replace.
export interface SshConnectionUpdateArgs {
  id: string
  groupId?: string | null
  name?: string
  host?: string
  port?: number
  username?: string
  authType?: SshAuthType
  password?: string | null
  privateKeyPath?: string | null
  passphrase?: string | null
  startupCommand?: string | null
  defaultDirectory?: string | null
  proxyJump?: string | null
  keepAliveInterval?: number
  sortOrder?: number
}

// ── Import / export ──

export type SshImportSource = 'open-cowork' | 'openssh'
export type SshImportAction = 'create' | 'skip' | 'replace' | 'duplicate'

export interface SshImportPreviewConnection {
  importId: string
  source: SshImportSource
  name: string
  host: string
  port: number
  username: string
  authType: SshAuthType
  groupName: string | null
  privateKeyPath: string | null
  proxyJump: string | null
  startupCommand: string | null
  defaultDirectory: string | null
  keepAliveInterval: number | null
  password: string | null
  passphrase: string | null
  hasKnownHost: boolean
  needsPrivateKeyReview: boolean
  warnings: string[]
  conflictConnectionId: string | null
  conflictConnectionName: string | null
  defaultAction: SshImportAction
}

export interface SshImportPreviewResult {
  source: SshImportSource
  filePath: string
  connectionCount: number
  groups: string[]
  warnings: string[]
  connections: SshImportPreviewConnection[]
  error?: string
}

export interface SshImportApplyResult {
  imported: number
  replaced: number
  duplicated: number
  skipped: number
  warnings: string[]
  error?: string
}

// ── Unified error model (adopted per-channel as domains migrate) ──

export type SshErrorCode =
  | 'config_invalid'
  | 'auth_failed'
  | 'connect_failed'
  | 'jump_failed'
  | 'channel_failed'
  | 'not_found'
  | 'canceled'
  | 'internal'

export interface SshErrorPayload {
  code: SshErrorCode
  stage?: 'jump' | 'auth' | 'connect' | 'channel'
  message: string
  retryable: boolean
}
