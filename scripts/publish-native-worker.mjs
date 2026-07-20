import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const projectPath = join(
  repoRoot,
  'sidecars',
  'OpenCowork.Native.Worker',
  'OpenCowork.Native.Worker.csproj'
)
const codeGraphProjectPath = join(
  repoRoot,
  'sidecars',
  'OpenCowork.CodeGraph.Worker',
  'OpenCowork.CodeGraph.Worker.csproj'
)
const outputDir = join(repoRoot, 'resources', 'native-worker')
const tempOutputDir = mkdtempSync(join(tmpdir(), 'open-cowork-native-worker-'))
const codeGraphTempOutputDir = mkdtempSync(join(tmpdir(), 'open-cowork-codegraph-worker-'))
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

mkdirSync(tempOutputDir, { recursive: true })
mkdirSync(codeGraphTempOutputDir, { recursive: true })

const rid = process.env.OPEN_COWORK_NATIVE_WORKER_RID || currentRid()

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function publishWorker(project, destination) {
  return spawnSync(
    'dotnet',
    [
      'publish',
      project,
      '-c',
      'Release',
      '-r',
      rid,
      '--source',
      nugetSource,
      '-o',
      destination,
      '/p:PublishAot=true',
      '/p:StripSymbols=true'
    ],
    {
      cwd: repoRoot,
      stdio: 'inherit'
    }
  )
}

const result = publishWorker(projectPath, tempOutputDir)

if (result.status !== 0) {
  rmSync(tempOutputDir, { recursive: true, force: true })
  rmSync(codeGraphTempOutputDir, { recursive: true, force: true })
  process.exit(result.status ?? 1)
}

const codeGraphResult = publishWorker(codeGraphProjectPath, codeGraphTempOutputDir)
if (codeGraphResult.status !== 0) {
  rmSync(tempOutputDir, { recursive: true, force: true })
  rmSync(codeGraphTempOutputDir, { recursive: true, force: true })
  process.exit(codeGraphResult.status ?? 1)
}

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })
cpSync(tempOutputDir, outputDir, { recursive: true })
const codeGraphOutputDir = join(outputDir, 'codegraph-worker')
mkdirSync(codeGraphOutputDir, { recursive: true })
cpSync(codeGraphTempOutputDir, codeGraphOutputDir, { recursive: true })

// The .dSYM bundle is crash-symbolication debug info (StripSymbols moves DWARF
// there) — never loaded at runtime, and resources/** ships into the installer, so
// leaving it here bloats the package by the dSYM's full size. Keep it only when
// archiving symbols for a release (OPEN_COWORK_KEEP_DSYM=1).
if (process.env.OPEN_COWORK_KEEP_DSYM !== '1') {
  for (const entry of [
    'OpenCowork.Native.Worker.dSYM',
    'OpenCowork.Native.Worker.dbg',
    'OpenCowork.Native.Worker.pdb'
  ]) {
    rmSync(join(outputDir, entry), { recursive: true, force: true })
  }
  for (const entry of [
    'OpenCowork.CodeGraph.Worker.dSYM',
    'OpenCowork.CodeGraph.Worker.dbg',
    'OpenCowork.CodeGraph.Worker.pdb'
  ]) {
    rmSync(join(codeGraphOutputDir, entry), { recursive: true, force: true })
  }
}

// Bundle the supported RID-specific CodeGraph grammars beside the worker. The
// TreeSitter.DotNet PackageReference above makes the package available in a clean
// CI cache; an explicit source directory can be supplied for a custom grammar set.
const grammarsSrc =
  process.env.OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR?.trim() ||
  join(
    (await import('node:os')).homedir(),
    '.nuget/packages/treesitter.dotnet/1.3.0/runtimes',
    rid,
    'native'
  )
const grammarsOut = join(codeGraphOutputDir, 'grammars')

// Use names without the Unix-only `lib` prefix so the same filter works for
// .dylib/.so and Windows .dll files.
const BUNDLED_GRAMMARS = new Set([
  'tree-sitter',
  'tree-sitter-typescript',
  'tree-sitter-tsx',
  'tree-sitter-javascript',
  'tree-sitter-python',
  'tree-sitter-go',
  'tree-sitter-java',
  'tree-sitter-c-sharp',
  'tree-sitter-rust',
  'tree-sitter-c',
  'tree-sitter-cpp',
  'tree-sitter-php',
  'tree-sitter-ruby',
  'tree-sitter-scala',
  'tree-sitter-bash',
  'tree-sitter-haskell',
  'tree-sitter-julia',
  'tree-sitter-razor'
])

try {
  mkdirSync(grammarsOut, { recursive: true })
  const copied = new Set()
  for (const file of readdirSync(grammarsSrc)) {
    const name = file.replace(/\.(dylib|so|dll)$/i, '').replace(/^lib/, '')
    if (!BUNDLED_GRAMMARS.has(name)) continue
    cpSync(join(grammarsSrc, file), join(grammarsOut, file))
    copied.add(name)
  }

  const missing = [...BUNDLED_GRAMMARS].filter((name) => !copied.has(name))
  if (missing.length > 0) {
    throw new Error(`missing required ${rid} grammars: ${missing.join(', ')}`)
  }
  console.log(`[publish-native-worker] bundled ${copied.size} ${rid} grammars -> ${grammarsOut}`)
} catch (error) {
  rmSync(tempOutputDir, { recursive: true, force: true })
  rmSync(codeGraphTempOutputDir, { recursive: true, force: true })
  console.error(
    `[publish-native-worker] failed to bundle grammars from ${grammarsSrc}:`,
    error?.message ?? error
  )
  process.exit(1)
}
rmSync(tempOutputDir, { recursive: true, force: true })
rmSync(codeGraphTempOutputDir, { recursive: true, force: true })
