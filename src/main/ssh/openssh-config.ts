import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Minimal OpenSSH client config (~/.ssh/config) reader. Supports the subset
// the app consumes: Host blocks with HostName/User/Port/IdentityFile/
// ProxyJump, wildcard patterns and negation, first-obtained-value-wins
// semantics. Include and Match directives are not followed.

export interface OpenSshHostConfig {
  host: string
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
  proxyJump?: string
}

interface HostBlock {
  patterns: string[]
  options: Map<string, string>
}

export function getDefaultOpenSshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'config')
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseBlocks(content: string): HostBlock[] {
  const blocks: HostBlock[] = []
  let current: HostBlock | null = null
  let inMatchBlock = false

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const separator = line.match(/^([^\s=]+)\s*[=\s]\s*(.*)$/)
    if (!separator) continue
    const keyword = separator[1].toLowerCase()
    const value = separator[2].trim()

    if (keyword === 'host') {
      current = { patterns: value.split(/\s+/).map(unquote).filter(Boolean), options: new Map() }
      inMatchBlock = false
      blocks.push(current)
      continue
    }
    if (keyword === 'match') {
      current = null
      inMatchBlock = true
      continue
    }
    if (inMatchBlock || !current) continue
    if (!current.options.has(keyword)) {
      current.options.set(keyword, unquote(value))
    }
  }

  return blocks
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function hostMatches(patterns: string[], alias: string): boolean {
  let matched = false
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (patternToRegex(pattern.slice(1)).test(alias)) return false
    } else if (patternToRegex(pattern).test(alias)) {
      matched = true
    }
  }
  return matched
}

function isUniversalBlock(patterns: string[]): boolean {
  return patterns.every((pattern) => pattern === '*')
}

function expandTilde(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

async function readConfigFile(configPath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(configPath, 'utf-8')
  } catch {
    return null
  }
}

function buildHostConfig(alias: string, options: Map<string, string>): OpenSshHostConfig {
  const config: OpenSshHostConfig = { host: alias }
  const hostName = options.get('hostname')
  if (hostName) config.hostName = hostName
  const user = options.get('user')
  if (user) config.user = user
  const portRaw = options.get('port')
  if (portRaw) {
    const port = Number.parseInt(portRaw, 10)
    if (Number.isFinite(port) && port > 0) config.port = port
  }
  const identityFile = options.get('identityfile')
  if (identityFile) config.identityFile = expandTilde(identityFile.split(/\s+/)[0])
  const proxyJump = options.get('proxyjump')
  if (proxyJump) config.proxyJump = proxyJump
  return config
}

export async function resolveOpenSshHost(
  alias: string,
  configPath = getDefaultOpenSshConfigPath()
): Promise<OpenSshHostConfig | null> {
  const normalizedAlias = alias.trim()
  if (!normalizedAlias) return null
  const content = await readConfigFile(configPath)
  if (!content) return null

  const options = new Map<string, string>()
  let explicitMatch = false
  for (const block of parseBlocks(content)) {
    if (!hostMatches(block.patterns, normalizedAlias)) continue
    if (!isUniversalBlock(block.patterns)) explicitMatch = true
    for (const [key, value] of block.options) {
      if (!options.has(key)) options.set(key, value)
    }
  }
  if (!explicitMatch) return null
  return buildHostConfig(normalizedAlias, options)
}

// Explicit (non-wildcard, non-negated) aliases declared in the config file,
// each resolved with full first-value-wins semantics. Used by import preview.
export async function listOpenSshHosts(
  configPath = getDefaultOpenSshConfigPath()
): Promise<OpenSshHostConfig[]> {
  const content = await readConfigFile(configPath)
  if (!content) return []

  const aliases: string[] = []
  const seen = new Set<string>()
  for (const block of parseBlocks(content)) {
    for (const pattern of block.patterns) {
      if (pattern.includes('*') || pattern.includes('?') || pattern.startsWith('!')) continue
      if (seen.has(pattern)) continue
      seen.add(pattern)
      aliases.push(pattern)
    }
  }

  const hosts: OpenSshHostConfig[] = []
  for (const alias of aliases) {
    const resolved = await resolveOpenSshHost(alias, configPath)
    if (resolved) hosts.push(resolved)
  }
  return hosts
}
