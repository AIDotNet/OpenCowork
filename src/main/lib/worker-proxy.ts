import { session } from 'electron'
import { readPersistedProviderStore } from './ai-provider-store'

/**
 * Keeps the native worker's outbound proxy in step with the app's.
 *
 * Every provider request is sent from the .NET worker, and .NET builds its default proxy from
 * environment variables alone on macOS and Linux — it never reads the OS proxy settings that
 * Electron's `mode: 'system'` honours. Without this the renderer goes through the user's proxy
 * while provider traffic goes out direct, which on a restricted network looks like the model
 * being flaky (resets, truncated SSE streams) rather than like a proxy problem.
 *
 * Chromium's resolver is the only thing here that can read the OS settings, so the effective
 * proxy is resolved in this process and pushed to the worker over `network/set-proxy`. The
 * resolved value is also written into the child environment, so a worker respawn is configured
 * before it serves its first request.
 */

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy'
] as const

/** Probed when the provider store has no usable base URL yet (first run, or before settings load). */
const FALLBACK_PROBE_URL = 'https://api.openai.com/v1/responses'

/** Bounds startup work; resolveProxy is local but the store can hold many providers. */
const MAX_PROBED_HOSTS = 24

const SET_PROXY_TIMEOUT_MS = 5000

interface ResolvedProxy {
  url: string | null
  bypass: string[]
}

let resolved: ResolvedProxy = { url: null, bypass: [] }
let lastLoggedSignature: string | null = null

function signatureOf(value: ResolvedProxy): string {
  return `${value.url ?? ''}|${value.bypass.join(',')}`
}

function readEnvProxyUrl(): string | null {
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return null
}

function readEnvBypass(): string[] {
  const raw = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').trim()
  if (!raw) return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Chromium reports a PAC-style result: a `;`-separated preference list whose entries are
 * `DIRECT` or `<SCHEME> host:port`. Only the first usable entry matters — the worker has no
 * failover list, and a proxy that is down is a user-visible problem either way.
 */
function parseResolvedProxy(result: string): string | null {
  for (const entry of result.split(';')) {
    const parts = entry.trim().split(/\s+/)
    if (parts.length < 2) continue
    const [kind, authority] = parts
    if (!authority) continue
    const scheme = {
      PROXY: 'http',
      HTTPS: 'https',
      SOCKS: 'socks4',
      SOCKS4: 'socks4',
      SOCKS5: 'socks5'
    }[kind.toUpperCase()]
    if (scheme) return `${scheme}://${authority}`
  }
  return null
}

async function resolveFor(url: string): Promise<string | null> {
  try {
    return parseResolvedProxy(await session.defaultSession.resolveProxy(url))
  } catch (error) {
    console.warn(`[WorkerProxy] resolveProxy failed for ${url}:`, error)
    return null
  }
}

/**
 * Collects the hosts the worker will actually talk to, so the OS proxy rules can be probed for
 * each. Matching on the key name rather than the store's shape keeps this working as the
 * renderer's provider model evolves.
 */
function collectProviderHosts(): string[] {
  const hosts = new Set<string>()
  try {
    const store = readPersistedProviderStore()
    if (!store) return []
    const visit = (value: unknown, key: string): void => {
      if (hosts.size >= MAX_PROBED_HOSTS) return
      if (typeof value === 'string') {
        if (!/base_?url|endpoint/i.test(key)) return
        try {
          const parsed = new URL(value)
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            hosts.add(`${parsed.protocol}//${parsed.host}`)
          }
        } catch {
          // A half-typed base URL in the store is not worth reporting.
        }
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, key)
        return
      }
      if (value && typeof value === 'object') {
        for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey)
      }
    }
    visit(store.state, '')
  } catch (error) {
    console.warn('[WorkerProxy] Failed to read provider base URLs:', error)
  }
  return [...hosts]
}

/**
 * Resolves the OS proxy per provider host. Hosts the system routes directly become the bypass
 * list, which matters for a PAC or an exception list that proxies foreign providers and sends
 * domestic ones direct — forcing everything through one proxy would break the latter.
 */
async function resolveFromSystem(): Promise<ResolvedProxy> {
  const hosts = collectProviderHosts()
  if (hosts.length === 0) {
    return { url: await resolveFor(FALLBACK_PROBE_URL), bypass: [] }
  }

  const probes = await Promise.all(
    hosts.map(async (host) => ({ host, proxy: await resolveFor(host) }))
  )
  const proxied = probes.filter((probe) => probe.proxy !== null)
  if (proxied.length === 0) return { url: null, bypass: [] }

  return {
    url: proxied[0].proxy,
    bypass: probes
      .filter((probe) => probe.proxy === null)
      .map((probe) => new URL(probe.host).hostname)
  }
}

/**
 * Recomputes the effective proxy and pushes it to a running worker.
 *
 * @param configuredUrl The app's explicit proxy setting, or null to fall back to the environment
 * and then to the OS settings. An explicit setting is taken to mean "send everything here",
 * matching how it is applied to Electron's own sessions.
 */
export async function refreshWorkerProxy(configuredUrl: string | null): Promise<void> {
  const explicit = configuredUrl?.trim() || readEnvProxyUrl()
  resolved = explicit ? { url: explicit, bypass: readEnvBypass() } : await resolveFromSystem()

  const signature = signatureOf(resolved)
  if (signature !== lastLoggedSignature) {
    lastLoggedSignature = signature
    console.log(
      resolved.url
        ? `[WorkerProxy] Native worker proxy: ${resolved.url}` +
            (resolved.bypass.length > 0 ? ` (bypass: ${resolved.bypass.join(', ')})` : '')
        : '[WorkerProxy] Native worker connects directly (no proxy resolved)'
    )
  }

  // Imported lazily: native-worker builds its child environment from this module, and a static
  // import back would make that cycle load-order dependent.
  const { getNativeWorker, isNativeWorkerRunning } = await import('./native-worker')
  if (!isNativeWorkerRunning()) return
  try {
    await getNativeWorker().request(
      'network/set-proxy',
      { url: resolved.url ?? '', bypass: resolved.bypass },
      SET_PROXY_TIMEOUT_MS
    )
  } catch (error) {
    console.warn('[WorkerProxy] Failed to push proxy to the native worker:', error)
  }
}

/**
 * Seeds a worker child environment with the resolved proxy, so a respawn is configured before it
 * can serve a request. Anything already present in the environment wins: it was either set by the
 * user's shell or is the value this resolved from in the first place.
 */
export function applyWorkerProxyEnv(env: NodeJS.ProcessEnv): void {
  if (!resolved.url || PROXY_ENV_KEYS.some((key) => env[key]?.trim())) return
  env.HTTPS_PROXY = resolved.url
  env.HTTP_PROXY = resolved.url
  env.ALL_PROXY = resolved.url
  if (resolved.bypass.length > 0 && !env.NO_PROXY?.trim()) {
    env.NO_PROXY = resolved.bypass.join(',')
  }
}
