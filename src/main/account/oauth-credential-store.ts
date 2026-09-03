import { safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AccountOAuthUser } from '../../shared/account-oauth'

// OAuth credential store for the RoutIn desktop account. Tokens never leave the
// main process in plaintext: they are encrypted with Electron safeStorage before
// hitting disk, and the renderer only ever receives the sanitized profile.

const DATA_DIRECTORY_NAME = '.open-cowork'
const ACCOUNT_FILE_NAME = 'account-oauth.json'
const STORAGE_FORMAT_VERSION = 1
const SECRET_SAFE_PREFIX = 'v1:safe:'
const SECRET_PLAIN_PREFIX = 'v1:plain:'

export interface AccountOAuthCredentials {
  accessToken: string
  refreshToken: string | null
  /** Epoch milliseconds when the access token stops being usable. */
  expiresAt: number | null
  scope: string | null
  tokenType: string
  user: AccountOAuthUser
  updatedAt: number
}

interface PersistedAccountFile {
  formatVersion: number
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scope: string | null
  tokenType: string
  user: AccountOAuthUser
  updatedAt: number
}

function getDefaultDataDirectory(): string {
  return path.join(os.homedir(), DATA_DIRECTORY_NAME)
}

function getAccountFilePath(dataDirectory: string): string {
  return path.join(dataDirectory, ACCOUNT_FILE_NAME)
}

function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encodeSecret(plain: string): string {
  if (isEncryptionAvailable()) {
    return SECRET_SAFE_PREFIX + safeStorage.encryptString(plain).toString('base64')
  }
  console.warn('[AccountOAuth] OS secret encryption unavailable, falling back to plain storage')
  return SECRET_PLAIN_PREFIX + Buffer.from(plain, 'utf-8').toString('base64')
}

function decodeSecret(stored: string | null): string | null {
  if (!stored) return null
  if (stored.startsWith(SECRET_SAFE_PREFIX)) {
    try {
      return safeStorage.decryptString(
        Buffer.from(stored.slice(SECRET_SAFE_PREFIX.length), 'base64')
      )
    } catch (error) {
      console.warn('[AccountOAuth] Failed to decrypt stored credential:', error)
      return null
    }
  }
  if (stored.startsWith(SECRET_PLAIN_PREFIX)) {
    return Buffer.from(stored.slice(SECRET_PLAIN_PREFIX.length), 'base64').toString('utf-8')
  }
  return null
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeUser(value: unknown): AccountOAuthUser | null {
  if (!isRecord(value)) return null
  const sub = typeof value.sub === 'string' ? value.sub.trim() : ''
  if (!sub) return null
  const asNullableString = (input: unknown): string | null =>
    typeof input === 'string' && input.trim().length > 0 ? input : null
  return {
    sub,
    name: asNullableString(value.name),
    email: asNullableString(value.email),
    emailVerified: typeof value.emailVerified === 'boolean' ? value.emailVerified : null,
    picture: asNullableString(value.picture),
    preferredUsername: asNullableString(value.preferredUsername)
  }
}

export function saveAccountCredentials(
  credentials: AccountOAuthCredentials,
  dataDirectory = getDefaultDataDirectory()
): void {
  const file: PersistedAccountFile = {
    formatVersion: STORAGE_FORMAT_VERSION,
    accessToken: encodeSecret(credentials.accessToken),
    refreshToken: credentials.refreshToken ? encodeSecret(credentials.refreshToken) : null,
    expiresAt: credentials.expiresAt,
    scope: credentials.scope,
    tokenType: credentials.tokenType,
    user: credentials.user,
    updatedAt: credentials.updatedAt
  }
  writeJsonFile(getAccountFilePath(dataDirectory), file)
}

export function loadAccountCredentials(
  dataDirectory = getDefaultDataDirectory()
): AccountOAuthCredentials | null {
  const filePath = getAccountFilePath(dataDirectory)
  let raw: unknown
  try {
    if (!fs.existsSync(filePath)) return null
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
  } catch (error) {
    console.warn('[AccountOAuth] Failed to read stored account file:', error)
    return null
  }

  if (!isRecord(raw)) return null

  const user = normalizeUser(raw.user)
  const accessToken = decodeSecret(typeof raw.accessToken === 'string' ? raw.accessToken : null)
  if (!user || !accessToken) {
    // Unreadable credentials (rotated OS key, corrupt file) must not silently
    // masquerade as a logged-in session.
    console.warn('[AccountOAuth] Stored account credentials are unusable, ignoring them')
    return null
  }

  return {
    accessToken,
    refreshToken: decodeSecret(typeof raw.refreshToken === 'string' ? raw.refreshToken : null),
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : null,
    scope: typeof raw.scope === 'string' ? raw.scope : null,
    tokenType: typeof raw.tokenType === 'string' ? raw.tokenType : 'Bearer',
    user,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
  }
}

export function clearAccountCredentials(dataDirectory = getDefaultDataDirectory()): void {
  try {
    fs.rmSync(getAccountFilePath(dataDirectory), { force: true })
  } catch (error) {
    console.warn('[AccountOAuth] Failed to remove stored account file:', error)
  }
}
