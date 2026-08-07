import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const version = process.env.OPEN_COWORK_NATIVE_WORKER_VERSION?.trim() || packageJson.version
const rid = getCurrentRid()
const executable =
  process.platform === 'win32' ? 'OpenCowork.Native.Worker.exe' : 'OpenCowork.Native.Worker'
const codeGraphExecutable =
  process.platform === 'win32' ? 'OpenCowork.CodeGraph.Worker.exe' : 'OpenCowork.CodeGraph.Worker'
const workerRoot = join(packageRoot, 'native-worker')
const bundledWorkerRoot = join(packageRoot, 'native-workers', rid)
const archiveName = `OpenCowork-native-worker-${rid}.tgz`
const releaseBaseUrl = (
  process.env.OPEN_COWORK_NATIVE_WORKER_BASE_URL?.trim() ||
  'https://github.com/AIDotNet/OpenCowork/releases/download'
).replace(/\/+$/u, '')
const archiveUrl =
  process.env.OPEN_COWORK_NATIVE_WORKER_URL?.trim() ||
  `${releaseBaseUrl}/v${version}/${archiveName}`
const checksumUrl =
  process.env.OPEN_COWORK_NATIVE_WORKER_SHA256_URL?.trim() || `${archiveUrl}.sha256`

function getCurrentRid() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'osx-arm64' : 'osx-x64'
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'win-arm64' : 'win-x64'
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`)
}

function hasWorker(root) {
  return (
    existsSync(join(root, executable)) &&
    existsSync(join(root, 'codegraph-worker', codeGraphExecutable))
  )
}

function isInstalled() {
  const versionPath = join(workerRoot, '.version')
  return (
    hasWorker(workerRoot) &&
    existsSync(versionPath) &&
    readFileSync(versionPath, 'utf8').trim() === `${version}\n${rid}`
  )
}

async function fetchRequired(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'OpenCowork-CLI-Installer' }
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} while requesting ${url}`)
  return response
}

async function verifyChecksum(archivePath) {
  try {
    const checksumText = await (await fetchRequired(checksumUrl)).text()
    const expected = checksumText.match(/\b([a-f0-9]{64})\b/iu)?.[1]?.toLowerCase()
    if (!expected) throw new Error('checksum file did not contain a SHA-256 digest')
    const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
    if (actual !== expected) throw new Error(`expected ${expected}, received ${actual}`)
    console.log('OpenCowork Native Worker checksum verified')
  } catch (error) {
    if (process.env.OPEN_COWORK_REQUIRE_CHECKSUM === '1') throw error
    console.warn(`OpenCowork Native Worker checksum unavailable: ${error.message}`)
  }
}

async function install() {
  if (process.env.OPEN_COWORK_SKIP_NATIVE_DOWNLOAD === '1') return
  if (isInstalled()) {
    printCoworkShortcut()
    return
  }

  if (hasWorker(bundledWorkerRoot)) {
    rmSync(workerRoot, { force: true, recursive: true })
    cpSync(bundledWorkerRoot, workerRoot, { recursive: true })
    setWorkerPermissions()
    writeFileSync(join(workerRoot, '.version'), `${version}\n${rid}\n`, 'utf8')
    console.log(`Installed bundled OpenCowork Native Worker for ${rid}`)
    printCoworkShortcut()
    return
  }

  mkdirSync(workerRoot, { recursive: true })
  const archivePath = join(workerRoot, `.${archiveName}.${process.pid}.download`)
  rmSync(archivePath, { force: true })
  try {
    console.log(`Downloading OpenCowork Native Worker for ${rid}`)
    const archive = await fetchRequired(archiveUrl)
    writeFileSync(archivePath, Buffer.from(await archive.arrayBuffer()), { mode: 0o600 })
    await verifyChecksum(archivePath)

    const extraction = spawnSync('tar', ['-xzf', archivePath, '-C', workerRoot], {
      encoding: 'utf8'
    })
    if (extraction.status !== 0) {
      throw new Error(`could not unpack Native Worker: ${(extraction.stderr || '').trim()}`)
    }

    if (!hasWorker(workerRoot)) {
      throw new Error('downloaded archive did not contain both Native Worker executables')
    }
    setWorkerPermissions()
    writeFileSync(join(workerRoot, '.version'), `${version}\n${rid}\n`, 'utf8')
    printCoworkShortcut()
  } finally {
    rmSync(archivePath, { force: true })
  }
}

function setWorkerPermissions() {
  if (process.platform === 'win32') return
  chmodSync(join(workerRoot, executable), 0o755)
  chmodSync(join(workerRoot, 'codegraph-worker', codeGraphExecutable), 0o755)
}

function printCoworkShortcut() {
  const isGlobalInstall = ['true', '1'].includes(
    process.env.npm_config_global || process.env.NPM_CONFIG_GLOBAL
  )
  if (!isGlobalInstall || !['darwin', 'linux'].includes(process.platform)) return

  console.log('')
  console.log('OpenCowork installed successfully. Start it with: cowork')
  console.log("If cowork is not found, add npm's global bin directory to your PATH:")
  console.log('  export PATH="$(npm bin -g):$PATH"')
}

install().catch((error) => {
  console.error(`Failed to install OpenCowork Native Worker: ${error.message}`)
  process.exitCode = 1
})
