import { useChatStore } from '@renderer/stores/chat-store'
import { useAppPluginStore } from '@renderer/stores/app-plugin-store'
import { BROWSER_PLUGIN_ID } from './types'

export interface BrowserAccessDecision {
  allowed: boolean
  reason?: string
}

export function normalizeBrowserDomainEntry(value: string): string | null {
  let candidate = value.trim().toLowerCase()
  if (!candidate) return null
  if (candidate.startsWith('*.')) candidate = candidate.slice(2)
  if (candidate.startsWith('.')) candidate = candidate.slice(1)

  try {
    const parsed = new URL(candidate.includes('://') ? candidate : `https://${candidate}`)
    candidate = parsed.hostname
  } catch {
    candidate = candidate.split(/[/?#]/)[0]
  }

  candidate = candidate.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
  if (!candidate) return null

  const colonIndex = candidate.indexOf(':')
  if (colonIndex > -1 && candidate.indexOf(':', colonIndex + 1) === -1) {
    candidate = candidate.slice(0, colonIndex)
  }

  return candidate || null
}

export function parseBrowserDomainList(value: string): string[] {
  const seen = new Set<string>()
  const domains: string[] = []

  for (const item of value.split(/[\n,，;；]+/)) {
    const normalized = normalizeBrowserDomainEntry(item)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    domains.push(normalized)
  }

  return domains
}

function getHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

export function getBrowserAccessDecision(url: string): BrowserAccessDecision {
  let protocol: string | null = null
  try {
    protocol = new URL(url).protocol
  } catch {
    protocol = null
  }

  // Local resources (file://, about:, data:) have no network host — domain
  // allow/block rules don't apply, so let them through.
  if (protocol === 'file:' || protocol === 'about:' || protocol === 'data:') {
    return { allowed: true }
  }

  const hostname = getHostname(url)
  if (!hostname) {
    return { allowed: false, reason: `Invalid browser URL: ${url}` }
  }

  const activeProjectId = useChatStore.getState().activeProjectId
  const plugin = useAppPluginStore.getState().getPlugin(BROWSER_PLUGIN_ID, activeProjectId)
  const allowedDomains = (plugin?.browserAllowedDomains ?? [])
    .map(normalizeBrowserDomainEntry)
    .filter((domain): domain is string => Boolean(domain))
  const blockedDomains = (plugin?.browserBlockedDomains ?? [])
    .map(normalizeBrowserDomainEntry)
    .filter((domain): domain is string => Boolean(domain))
  const blockedMatch = blockedDomains.find((domain) => domainMatches(hostname, domain))

  if (blockedMatch) {
    return {
      allowed: false,
      reason: `Navigation to ${hostname} is blocked by the browser plugin rule "${blockedMatch}".`
    }
  }

  if (allowedDomains.length > 0) {
    const allowedMatch = allowedDomains.some((domain) => domainMatches(hostname, domain))
    if (!allowedMatch) {
      return {
        allowed: false,
        reason: `Navigation to ${hostname} is not in the browser plugin allow list.`
      }
    }
  }

  return { allowed: true }
}
