import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageName = '@aidotnet/opencowork'
const UPDATE_CHECK_TIMEOUT_MS = 2_000
const UPDATE_CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1_000

interface UpdateCheckCache {
  checkedAt: number
  latest: string | null
}

function updateCheckCachePath(): string {
  const dataDirectory = process.env.OPEN_COWORK_DATA_DIR?.trim() || join(homedir(), '.open-cowork')
  return join(dataDirectory, 'cli-update-check.json')
}

function readUpdateCheckCache(): UpdateCheckCache | null {
  try {
    const parsed = JSON.parse(readFileSync(updateCheckCachePath(), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Partial<UpdateCheckCache>
    if (typeof record.checkedAt !== 'number') return null
    return {
      checkedAt: record.checkedAt,
      latest: typeof record.latest === 'string' ? record.latest : null
    }
  } catch {
    return null
  }
}

function writeUpdateCheckCache(latest: string | null): void {
  try {
    const path = updateCheckCachePath()
    mkdirSync(join(path, '..'), { recursive: true })
    const temporaryPath = `${path}.${process.pid}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify({ checkedAt: Date.now(), latest })}\n`, 'utf8')
    renameSync(temporaryPath, path)
  } catch {
    // A missing cache only means the next startup re-queries npm; never fail the CLI for it.
  }
}

function run(
  command: string,
  args: string[],
  timeoutMs?: number
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timer: NodeJS.Timeout | null = null
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timer = null
        child.kill('SIGKILL')
        reject(new Error(`${command} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.once('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? 1, output })
    })
  })
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.replace(/^v/u, '').split(/[.-]/u)
  const rightParts = right.replace(/^v/u, '').split(/[.-]/u)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? '0'
    const rightPart = rightParts[index] ?? '0'
    const leftNumber = Number(leftPart)
    const rightNumber = Number(rightPart)
    const comparison =
      Number.isNaN(leftNumber) || Number.isNaN(rightNumber)
        ? leftPart.localeCompare(rightPart)
        : leftNumber - rightNumber
    if (comparison !== 0) return comparison
  }
  return 0
}

export async function getLatestVersion(
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS
): Promise<string | null> {
  try {
    const result = await run(
      'npm',
      ['view', packageName, 'version', '--registry=https://registry.npmjs.org'],
      timeoutMs
    )
    if (result.code !== 0) return null
    const version = result.output.trim().split(/\s+/u).at(-1)
    return version && /^\d+\.\d+\.\d+/u.test(version) ? version : null
  } catch {
    return null
  }
}

export async function updateCli(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', `${packageName}@latest`], { stdio: 'inherit' })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
}

/**
 * Force-reinstalls the Native Worker binaries by re-running the packaged postinstall
 * script with --force. This is the recovery path for a failed postinstall download or
 * an architecture-mismatched binary (cowork update --repair / cowork --doctor hint).
 */
export async function repairNativeWorker(): Promise<boolean> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const installScript = join(packageRoot, 'scripts', 'install-native-worker.mjs')
  if (!existsSync(installScript)) {
    console.error(`Native Worker install script not found at ${installScript}`)
    return false
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [installScript, '--force'], { stdio: 'inherit' })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
}

/**
 * Non-blocking update probe for the interactive UI. Uses a 24h on-disk cache so most
 * startups never spawn npm, bounds the npm query with a hard timeout, and never throws.
 * Returns the newer version string when one exists, otherwise null.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  // Kill switch for deterministic environments (PTY golden tests, air-gapped CI).
  if (process.env.OPENCOWORK_CLI_NO_UPDATE_CHECK === '1') return null
  const cached = readUpdateCheckCache()
  let latest: string | null
  if (cached && Date.now() - cached.checkedAt < UPDATE_CHECK_CACHE_TTL_MS) {
    latest = cached.latest
  } else {
    latest = await getLatestVersion()
    // A timed-out or offline query is cached as unknown so a flaky network cannot make
    // every startup wait the full probe timeout again within the TTL window.
    writeUpdateCheckCache(latest)
  }
  if (!latest || compareVersions(latest, currentVersion) <= 0) return null
  return latest
}
