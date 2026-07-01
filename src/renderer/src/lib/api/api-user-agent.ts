import packageJson from '../../../../../package.json'

const APP_NAME = 'OpenCowork'
const packageVersion = typeof packageJson.version === 'string' ? packageJson.version.trim() : ''
const DEFAULT_API_USER_AGENT = packageVersion ? `${APP_NAME}/${packageVersion}` : APP_NAME

function isDefaultApiUserAgentPlaceholder(userAgent: string): boolean {
  return userAgent === APP_NAME || userAgent === `${APP_NAME}/`
}

export function getDefaultApiUserAgent(): string {
  return DEFAULT_API_USER_AGENT
}

export function resolveProviderUserAgent(userAgent?: string): string {
  const trimmed = userAgent?.trim()
  return trimmed && !isDefaultApiUserAgentPlaceholder(trimmed) ? trimmed : getDefaultApiUserAgent()
}
