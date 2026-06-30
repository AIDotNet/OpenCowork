import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const projectPath = join(
  repoRoot,
  'sidecars',
  'OpenCowork.Native.Worker',
  'OpenCowork.Native.Worker.csproj'
)
const outputDir = join(repoRoot, 'resources', 'native-worker')
const nugetSource = process.env.OPEN_COWORK_NUGET_SOURCE || 'https://nuget.azure.cn/v3/index.json'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function currentRid() {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'darwin') return arch === 'arm64' ? 'osx-arm64' : 'osx-x64'
  if (platform === 'win32') return arch === 'arm64' ? 'win-arm64' : 'win-x64'
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  throw new Error(`Unsupported native worker platform: ${platform}/${arch}`)
}

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })

const result = spawnSync(
  'dotnet',
  [
    'publish',
    projectPath,
    '-c',
    'Release',
    '-r',
    process.env.OPEN_COWORK_NATIVE_WORKER_RID || currentRid(),
    '--source',
    nugetSource,
    '-o',
    outputDir,
    '/p:PublishAot=true',
    '/p:StripSymbols=true'
  ],
  {
    cwd: repoRoot,
    stdio: 'inherit'
  }
)

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}
