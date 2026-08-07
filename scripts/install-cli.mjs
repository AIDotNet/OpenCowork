/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import https from 'node:https'
import http from 'node:http'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const cliRoot = join(packageRoot, 'cli')
const workerRoot = join(cliRoot, 'native-worker')
const rid = currentRid()
const executableName =
  process.platform === 'win32' ? 'OpenCowork.Native.Worker.exe' : 'OpenCowork.Native.Worker'
const codeGraphExecutableName =
  process.platform === 'win32' ? 'OpenCowork.CodeGraph.Worker.exe' : 'OpenCowork.CodeGraph.Worker'
const version = process.env.OPEN_COWORK_NATIVE_WORKER_VERSION?.trim() || packageJson.version
const releaseBaseUrl = (
  process.env.OPEN_COWORK_NATIVE_WORKER_BASE_URL?.trim() ||
  'https://github.com/AIDotNet/OpenCowork/releases/download'
).replace(/\/+$/u, '')
const archiveName = `OpenCowork-native-worker-${rid}.tgz`
const archiveUrl =
  process.env.OPEN_COWORK_NATIVE_WORKER_URL?.trim() ||
  `${releaseBaseUrl}/v${version}/${archiveName}`
const checksumUrl =
  process.env.OPEN_COWORK_NATIVE_WORKER_SHA256_URL?.trim() || `${archiveUrl}.sha256`
const skipDownload = process.env.OPEN_COWORK_SKIP_NATIVE_DOWNLOAD === '1'
const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.npm_config_color !== 'false' &&
  Boolean(process.stdout.isTTY || process.stderr.isTTY)
const ansi = {
  bold: (value) => style('\u001b[1m', value),
  cyan: (value) => style('\u001b[38;5;81m', value),
  dim: (value) => style('\u001b[2m', value),
  green: (value) => style('\u001b[38;5;114m', value),
  orange: (value) => style('\u001b[38;5;215m', value),
  red: (value) => style('\u001b[38;5;204m', value),
  white: (value) => style('\u001b[38;5;255m', value)
}

function style(code, value) {
  return useColor ? `${code}${value}\u001b[0m` : value
}

function currentRid() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'osx-arm64' : 'osx-x64'
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'win-arm64' : 'win-x64'
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`)
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}

function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)}s`
}

function isInstalled() {
  const workerPath = join(workerRoot, executableName)
  const codeGraphPath = join(workerRoot, 'codegraph-worker', codeGraphExecutableName)
  const versionPath = join(workerRoot, '.version')
  return (
    existsSync(workerPath) &&
    existsSync(codeGraphPath) &&
    existsSync(versionPath) &&
    readFileSync(versionPath, 'utf8').trim() === `${version}\n${rid}`
  )
}

function printHeader() {
  console.log('')
  console.log(ansi.cyan('  ╭────────────────────────────────────────────────────╮'))
  console.log(
    ansi.cyan('  │') +
      ansi.bold(ansi.white('        ✦  OpenCowork CLI  ')) +
      ansi.dim(`v${version}`) +
      ansi.cyan('                 │')
  )
  console.log(
    ansi.cyan('  │') +
      ansi.dim('        Your agentic terminal, ready to work.') +
      ansi.cyan('       │')
  )
  console.log(ansi.cyan('  ╰────────────────────────────────────────────────────╯'))
  console.log('')
}

function step(icon, label, detail = '') {
  const suffix = detail ? ` ${ansi.dim(detail)}` : ''
  console.log(`  ${ansi.green(icon)} ${ansi.white(label)}${suffix}`)
}

function progress(bytes, total, startedAt) {
  const elapsed = Math.max(1, Date.now() - startedAt)
  const speed = bytes / (elapsed / 1000)
  const ratio = total > 0 ? Math.min(1, bytes / total) : 0
  const width = 24
  const filled = Math.round(ratio * width)
  const bar = `${'━'.repeat(filled)}${'─'.repeat(width - filled)}`
  const percent =
    total > 0
      ? `${Math.round(ratio * 100)
          .toString()
          .padStart(3)}%`
      : '  --'
  const line = `  ${ansi.cyan('↓')} ${ansi.cyan(bar)} ${percent}  ${formatBytes(bytes)}  ${formatBytes(speed)}/s`
  if (process.stdout.isTTY) process.stdout.write(`\r${line}`)
  else if (bytes === 0 || total <= 0 || bytes >= total) console.log(line)
}

function request(url, redirectCount = 0) {
  return new Promise((resolveRequest, rejectRequest) => {
    if (redirectCount > 5) {
      rejectRequest(new Error('Too many redirects while downloading the Native Worker'))
      return
    }
    const transport = url.startsWith('https:') ? https : http
    const requestHandle = transport.get(
      url,
      { headers: { 'User-Agent': 'OpenCowork-CLI-Installer' } },
      (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          resolveRequest(
            request(new URL(response.headers.location, url).toString(), redirectCount + 1)
          )
          return
        }
        if (status < 200 || status >= 300) {
          response.resume()
          rejectRequest(new Error(`HTTP ${status} while requesting ${url}`))
          return
        }
        resolveRequest(response)
      }
    )
    requestHandle.setTimeout(30_000, () => requestHandle.destroy(new Error('Request timed out')))
    requestHandle.once('error', rejectRequest)
  })
}

async function download(url, destination) {
  const response = await request(url)
  const total = Number(response.headers['content-length'] || 0)
  const startedAt = Date.now()
  let bytes = 0
  const output = createWriteStream(destination, { mode: 0o600 })
  progress(0, total, startedAt)
  try {
    for await (const chunk of response) {
      bytes += chunk.length
      if (!output.write(chunk))
        await new Promise((resolveWrite) => output.once('drain', resolveWrite))
      progress(bytes, total, startedAt)
    }
    await new Promise((resolveEnd, rejectEnd) => {
      output.end(() => resolveEnd())
      output.once('error', rejectEnd)
    })
  } catch (error) {
    output.destroy()
    throw error
  }
  if (process.stdout.isTTY) process.stdout.write('\n')
  return { bytes, elapsed: Date.now() - startedAt }
}

async function downloadText(url) {
  const response = await request(url)
  const chunks = []
  for await (const chunk of response) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function parseChecksum(text, archive) {
  const match = text.match(/\b([a-f0-9]{64})\b/i)
  if (!match) throw new Error(`Checksum file for ${archive} did not contain a SHA-256 digest`)
  return match[1].toLowerCase()
}

function isMissingChecksum(error) {
  return error instanceof Error && /^HTTP 404\b/u.test(error.message)
}

async function main() {
  printHeader()
  step('✓', 'Package detected', `${packageJson.name} ${version}`)
  step('✓', 'Platform selected', rid)

  if (skipDownload) {
    console.log(
      `  ${ansi.orange('!')} ${ansi.orange('Native Worker download skipped')} ${ansi.dim('(OPEN_COWORK_SKIP_NATIVE_DOWNLOAD=1)')}`
    )
    console.log(`  ${ansi.dim('Set OPEN_COWORK_NATIVE_WORKER_PATH when launching opencowork.')}`)
    return
  }

  if (isInstalled()) {
    step('✓', 'Native Worker ready', `${rid} · already installed`)
    printSuccess(false)
    return
  }

  mkdirSync(workerRoot, { recursive: true })
  const temporaryArchive = join(workerRoot, `.${archiveName}.${process.pid}.download`)
  rmSync(temporaryArchive, { force: true })
  try {
    console.log(
      `  ${ansi.cyan('◌')} ${ansi.white('Downloading Native Worker')} ${ansi.dim(`from GitHub Releases · ${archiveName}`)}`
    )
    const result = await download(archiveUrl, temporaryArchive)
    step(
      '✓',
      'Download complete',
      `${formatBytes(result.bytes)} · ${formatDuration(result.elapsed)}`
    )

    let checksumVerified = false
    try {
      const checksum = parseChecksum(await downloadText(checksumUrl), archiveName)
      const actual = createHash('sha256').update(readFileSync(temporaryArchive)).digest('hex')
      if (actual !== checksum) throw new Error(`expected ${checksum}, received ${actual}`)
      checksumVerified = true
      step('✓', 'Integrity verified', `SHA-256 ${actual.slice(0, 12)}…`)
    } catch (error) {
      if (process.env.OPEN_COWORK_REQUIRE_CHECKSUM === '1' || !isMissingChecksum(error)) throw error
      console.log(
        `  ${ansi.orange('!')} ${ansi.orange('Checksum unavailable')} ${ansi.dim(`(${error.message})`)}`
      )
    }

    const extraction = spawnSync('tar', ['-xzf', temporaryArchive, '-C', workerRoot], {
      stdio: 'pipe'
    })
    if (extraction.status !== 0) {
      const details = Buffer.concat([
        extraction.stdout ?? Buffer.alloc(0),
        extraction.stderr ?? Buffer.alloc(0)
      ])
        .toString('utf8')
        .trim()
      throw new Error(`could not unpack the Native Worker${details ? `: ${details}` : ''}`)
    }

    const workerPath = join(workerRoot, executableName)
    const codeGraphPath = join(workerRoot, 'codegraph-worker', codeGraphExecutableName)
    if (!existsSync(workerPath) || !existsSync(codeGraphPath)) {
      throw new Error('the downloaded archive did not contain both Native Worker executables')
    }
    if (process.platform !== 'win32') {
      chmodSync(workerPath, 0o755)
      chmodSync(codeGraphPath, 0o755)
    }
    writeFileSync(join(workerRoot, '.version'), `${version}\n${rid}\n`, 'utf8')
    step('✓', 'Native Worker installed', `${rid}${checksumVerified ? ' · verified' : ''}`)
    printSuccess(true)
  } finally {
    rmSync(temporaryArchive, { force: true })
  }
}

function printSuccess(downloaded) {
  const message = downloaded ? 'Start a session in your project.' : 'Worker cache is up to date.'
  const messageLine = `  opencowork  ${message}`
  const commandLine = '  Try: opencowork --help'

  console.log('')
  console.log(ansi.cyan('  ╭─ OpenCowork is ready ──────────────────────────────╮'))
  printSuccessRow(`  ${ansi.bold(ansi.white('opencowork'))}  ${ansi.dim(message)}`, messageLine)
  printSuccessRow(`  ${ansi.dim('Try:')} ${ansi.white('opencowork --help')}`, commandLine)
  console.log(ansi.cyan('  ╰────────────────────────────────────────────────────╯'))
  console.log('')
}

function printSuccessRow(styledContent, plainContent) {
  const padding = Math.max(1, 52 - plainContent.length)
  console.log(ansi.cyan('  │') + styledContent + ' '.repeat(padding) + ansi.cyan('│'))
}

main().catch((error) => {
  console.log('')
  console.error(ansi.red('  ✕ OpenCowork CLI installation could not finish'))
  console.error(`  ${ansi.dim(error instanceof Error ? error.message : String(error))}`)
  console.error(
    `  ${ansi.dim('Try again, or set OPEN_COWORK_NATIVE_WORKER_URL to a reachable Worker archive.')}`
  )
  console.error(
    `  ${ansi.dim('The CLI remains installed; you can also set OPEN_COWORK_NATIVE_WORKER_PATH at runtime.')}`
  )
  process.exitCode = 1
})
