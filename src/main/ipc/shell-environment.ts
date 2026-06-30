import { accessSync, constants } from 'fs'
import { readShellEnvironmentVariablesText } from './settings-handlers'

const SHELL_ENVIRONMENT_VARIABLE_LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const POSIX_ENVIRONMENT_REFERENCE_RE =
  /\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g
const WINDOWS_ENVIRONMENT_REFERENCE_RE = /%([A-Za-z_][A-Za-z0-9_]*)%/g

export function isExecutableFile(filePath?: string): filePath is string {
  if (!filePath?.trim()) return false
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function normalizeEnvironmentVariableKey(key: string): string {
  return process.platform === 'win32' ? key.toLowerCase() : key
}

function readEnvironmentVariable(env: NodeJS.ProcessEnv, key: string): string {
  const directValue = env[key]
  if (typeof directValue === 'string') return directValue
  if (process.platform !== 'win32') return ''

  const normalizedKey = normalizeEnvironmentVariableKey(key)
  for (const [candidateKey, candidateValue] of Object.entries(env)) {
    if (normalizeEnvironmentVariableKey(candidateKey) !== normalizedKey) continue
    return typeof candidateValue === 'string' ? candidateValue : ''
  }

  return ''
}

function writeEnvironmentVariable(env: NodeJS.ProcessEnv, key: string, value: string): void {
  if (process.platform === 'win32') {
    const normalizedKey = normalizeEnvironmentVariableKey(key)
    for (const candidateKey of Object.keys(env)) {
      if (candidateKey === key) continue
      if (normalizeEnvironmentVariableKey(candidateKey) !== normalizedKey) continue
      delete env[candidateKey]
    }
  }

  env[key] = value
}

function expandEnvironmentVariableReferences(value: string, env: NodeJS.ProcessEnv): string {
  return value
    .replace(WINDOWS_ENVIRONMENT_REFERENCE_RE, (_match, key: string) => {
      return readEnvironmentVariable(env, key)
    })
    .replace(POSIX_ENVIRONMENT_REFERENCE_RE, (_match, shortKey: string, bracedKey: string) => {
      return readEnvironmentVariable(env, shortKey || bracedKey)
    })
}

export function buildShellEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const configuredText = readShellEnvironmentVariablesText()
  let hasConfiguredTerm = false

  if (configuredText.trim()) {
    const lines = configuredText.split(/\r?\n/)

    lines.forEach((rawLine, index) => {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) return

      const match = line.match(SHELL_ENVIRONMENT_VARIABLE_LINE_RE)
      if (!match) {
        console.warn(
          `[ShellEnv] Ignoring invalid shell environment variable config at line ${index + 1}`
        )
        return
      }

      const [, key, rawValue] = match
      const expandedValue = expandEnvironmentVariableReferences(rawValue, env)
      writeEnvironmentVariable(env, key, expandedValue)
      if (normalizeEnvironmentVariableKey(key) === normalizeEnvironmentVariableKey('TERM')) {
        hasConfiguredTerm = true
      }
    })
  }

  if (!hasConfiguredTerm) {
    writeEnvironmentVariable(env, 'TERM', 'xterm-256color')
  }

  return env
}
