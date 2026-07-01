import { app } from 'electron'

const APP_NAME = 'OpenCowork'
const USER_AGENT_HEADER = 'user-agent'

export function getDefaultApiUserAgent(): string {
  const version = app.getVersion().trim()
  return version ? `${APP_NAME}/${version}` : APP_NAME
}

function isDefaultApiUserAgentPlaceholder(userAgent: string): boolean {
  const trimmed = userAgent.trim()
  return trimmed === APP_NAME || trimmed === `${APP_NAME}/`
}

export function resolveApiUserAgent(userAgent?: string | null): string {
  const trimmed = userAgent?.trim()
  return trimmed && !isDefaultApiUserAgentPlaceholder(trimmed) ? trimmed : getDefaultApiUserAgent()
}

export function hasUserAgentHeader(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(
    ([key, value]) =>
      key.toLowerCase() === USER_AGENT_HEADER &&
      value.trim().length > 0 &&
      !isDefaultApiUserAgentPlaceholder(value)
  )
}

export function applyDefaultApiUserAgent(headers: Record<string, string>): Record<string, string> {
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === USER_AGENT_HEADER)
  if (!existingKey) {
    headers['User-Agent'] = getDefaultApiUserAgent()
  } else {
    headers[existingKey] = resolveApiUserAgent(headers[existingKey])
  }
  return headers
}
