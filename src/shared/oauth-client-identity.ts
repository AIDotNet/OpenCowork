/** Official client versions we impersonate when forwarding Codex / Copilot OAuth. */
export const CODEX_CLI_VERSION = '0.149.1'
export const CODEX_ORIGINATOR = 'codex_cli_rs'
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const VSCODE_VERSION = '1.134.0'
export const COPILOT_CHAT_VERSION = '0.55.0'
export const COPILOT_INTEGRATION_ID = 'vscode-chat'
export const COPILOT_OAUTH_CLIENT_ID = 'Iv1.b507a08c87ecfe98'

export interface OauthClientPlatformInfo {
  platform?: string
  arch?: string
  release?: string
}

function normalizeArch(arch?: string): string {
  const value = arch?.trim().toLowerCase()
  if (!value) return 'unknown'
  if (value === 'x64' || value === 'x86_64' || value === 'amd64') return 'x86_64'
  if (value === 'arm64' || value === 'aarch64') return 'arm64'
  return value
}

function formatOsLabel(info?: OauthClientPlatformInfo): string | undefined {
  const platform = info?.platform?.trim().toLowerCase()
  const release = info?.release?.trim()
  if (!platform) return undefined
  if (platform === 'darwin' || platform === 'macos' || platform === 'mac os') {
    return release ? `Mac OS ${release}` : 'Mac OS'
  }
  if (platform === 'win32' || platform === 'windows' || platform === 'windows_nt') {
    return release ? `Windows ${release}` : 'Windows'
  }
  if (platform === 'linux') {
    return release ? `Linux ${release}` : 'Linux'
  }
  return release ? `${platform} ${release}` : platform
}

export function isCodexOAuthClientId(clientId?: string): boolean {
  return clientId === CODEX_OAUTH_CLIENT_ID
}

export function isCopilotOAuthClientId(clientId?: string): boolean {
  return clientId === COPILOT_OAUTH_CLIENT_ID
}

export function buildCodexCliUserAgent(info?: OauthClientPlatformInfo): string {
  const os = formatOsLabel(info)
  const arch = normalizeArch(info?.arch)
  const platformPart = os ? ` (${os}; ${arch})` : ''
  return `${CODEX_ORIGINATOR}/${CODEX_CLI_VERSION}${platformPart} vscode/${VSCODE_VERSION}`
}

export function buildCopilotUserAgent(): string {
  return `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`
}

export function buildCopilotClientHeaders(): Record<string, string> {
  return {
    'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
    'editor-version': `vscode/${VSCODE_VERSION}`,
    'editor-plugin-version': `copilot-chat/${COPILOT_CHAT_VERSION}`
  }
}

export function extractCodexClientVersion(userAgent?: string): string {
  return userAgent?.match(/codex_cli_rs\/(\d+(?:\.\d+)*)/i)?.[1] ?? CODEX_CLI_VERSION
}

export function withCodexClientVersion(url: string, userAgent?: string): string {
  if (/[?&]client_version=/i.test(url)) return url
  const version = extractCodexClientVersion(userAgent)
  return `${url}${url.includes('?') ? '&' : '?'}client_version=${encodeURIComponent(version)}`
}

export function resolveOauthForwardUserAgent(
  builtinId: string | undefined,
  stored?: string,
  platform?: OauthClientPlatformInfo
): string | undefined {
  if (builtinId === 'codex-oauth') return buildCodexCliUserAgent(platform)
  if (builtinId === 'copilot-oauth') return buildCopilotUserAgent()
  return stored
}

export function applyOauthClientIdentityHeaders(
  builtinId: string | undefined,
  headers: Record<string, string> | undefined,
  platform?: OauthClientPlatformInfo
): Record<string, string> | undefined {
  if (builtinId === 'codex-oauth') {
    return {
      ...(headers ?? {}),
      'openai-beta': headers?.['openai-beta'] ?? 'responses=experimental',
      originator: CODEX_ORIGINATOR,
      session_id: headers?.session_id ?? '{{sessionId}}',
      conversation_id: headers?.conversation_id ?? '{{sessionId}}',
      'User-Agent': buildCodexCliUserAgent(platform)
    }
  }
  if (builtinId === 'copilot-oauth') {
    return {
      ...(headers ?? {}),
      ...buildCopilotClientHeaders(),
      'User-Agent': buildCopilotUserAgent()
    }
  }
  return headers
}
