import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rid = process.env.OPEN_COWORK_NATIVE_WORKER_RID?.trim()
const workerDirectory = join(repoRoot, 'resources', 'native-worker')
const outputDirectory = join(repoRoot, 'cli-release-assets')

if (!rid) {
  console.error('[package-native-worker] OPEN_COWORK_NATIVE_WORKER_RID is required')
  process.exit(1)
}

if (!existsSync(workerDirectory)) {
  console.error(`[package-native-worker] Native Worker output was not found: ${workerDirectory}`)
  console.error('Run `npm run native:publish` before packaging the CLI Worker.')
  process.exit(1)
}

const executable =
  process.platform === 'win32' ? 'OpenCowork.Native.Worker.exe' : 'OpenCowork.Native.Worker'
const codeGraphExecutable =
  process.platform === 'win32' ? 'OpenCowork.CodeGraph.Worker.exe' : 'OpenCowork.CodeGraph.Worker'

for (const requiredPath of [
  join(workerDirectory, executable),
  join(workerDirectory, 'codegraph-worker', codeGraphExecutable)
]) {
  if (!existsSync(requiredPath)) {
    console.error(`[package-native-worker] Required file was not found: ${requiredPath}`)
    process.exit(1)
  }
}

mkdirSync(outputDirectory, { recursive: true })
const archiveName = `OpenCowork-native-worker-${rid}.tgz`
const archivePath = join(outputDirectory, archiveName)
const checksumPath = `${archivePath}.sha256`
rmSync(archivePath, { force: true })
rmSync(checksumPath, { force: true })

const result = spawnSync('tar', ['-czf', archivePath, '-C', workerDirectory, '.'], {
  cwd: repoRoot,
  stdio: 'inherit'
})

if (result.error || result.status !== 0 || !existsSync(archivePath)) {
  console.error(
    `[package-native-worker] Could not create ${archiveName}. ` +
      (result.error?.message ?? `tar exited with ${result.status ?? 'unknown status'}`)
  )
  process.exit(result.status || 1)
}

const checksum = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
const size = statSync(archivePath).size
writeFileSync(checksumPath, `${checksum}  ${archiveName}\n`)
console.log(`[package-native-worker] Created ${archiveName} (${size} bytes)`)
console.log(`[package-native-worker] SHA-256 ${checksum}`)
