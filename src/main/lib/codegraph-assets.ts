import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import grammarManifest from '../../shared/codegraph-grammars.json'
import { isNativeWorkerRunning, resolveNativeWorkerPath } from './native-worker'

// ---------------------------------------------------------------------------
// CodeGraph grammar assets (bundled, with a download cache for future updates).
//
// Packaged builds ship their RID-specific tree-sitter libraries beside the nested
// CodeGraph worker. A downloaded set may override those libraries later without
// requiring an app release. In development, the NuGet cache remains a fallback.
//
// The worker loads its grammars from OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR (wired in
// createCodeGraphWorkerEnv); this module resolves that directory and owns the
// optional update cache in ~/.open-cowork/codegraph/grammars/<setVersion>/<rid>/.
// ---------------------------------------------------------------------------

// Bump when the grammar ABI / pinned libtree-sitter version changes (invalidates cache).
const GRAMMAR_SET_VERSION = '1'

const TREE_SITTER_LIB_RE = /^(?:lib)?(tree-sitter(?:-[a-z0-9-]+)?)\.(?:dylib|so|dll)$/i
const TREE_SITTER_CORE_LIBRARY = grammarManifest.runtime.library.toLowerCase()
const TREE_SITTER_NUGET_PACKAGE = grammarManifest.source.package.toLowerCase()
const TREE_SITTER_NUGET_VERSION = grammarManifest.source.version
const GRAMMAR_LANGUAGES = new Map(
  grammarManifest.grammars.map((grammar) => [
    grammar.library.toLowerCase(),
    grammar.languages.map((language) => language.id)
  ])
)

export type CodeGraphAssetDiagnostic =
  | 'ready'
  | 'worker-missing'
  | 'grammar-directory-missing'
  | 'core-library-missing'
  | 'language-grammars-missing'
  | 'incomplete-grammar-set'
  | 'invalid-grammar-files'

export interface CodeGraphAssetStatus {
  isDev: boolean
  workerReady: boolean
  workerRunning: boolean
  grammarsReady: boolean
  ready: boolean
  grammarsDir: string | null
  /** Native language grammar libraries, excluding the libtree-sitter runtime. */
  grammarCount: number
  /** Explicit replacement for the ambiguous legacy `ready` field. */
  runtimeReady: boolean
  coreLibraryReady: boolean
  availableGrammars: string[]
  missingGrammars: string[]
  availableLanguages: string[]
  missingLanguages: string[]
  unrecognizedGrammars: string[]
  invalidGrammarFiles: string[]
  grammarSource: 'override' | 'downloaded' | 'bundled' | 'dev' | 'none'
  diagnostic: CodeGraphAssetDiagnostic
  needsDownload: boolean
}

export interface CodeGraphDownloadProgress {
  phase: 'download' | 'verify' | 'extract' | 'done'
  received?: number
  total?: number
  message?: string
}

function isDevBuild(): boolean {
  return !app.isPackaged
}

function currentRid(): string {
  const p = process.platform
  const a = process.arch
  if (p === 'darwin') return a === 'arm64' ? 'osx-arm64' : 'osx-x64'
  if (p === 'win32') return a === 'arm64' ? 'win-arm64' : 'win-x64'
  if (p === 'linux') return a === 'arm64' ? 'linux-arm64' : 'linux-x64'
  return `${p}-${a}`
}

function homeDir(): string {
  return process.env.OPEN_COWORK_HOME?.trim() || path.join(os.homedir(), '.open-cowork')
}

// The download cache: ~/.open-cowork/codegraph/grammars/<setVersion>/<rid>/
export function getCodeGraphCacheGrammarsDir(): string {
  return path.join(homeDir(), 'codegraph', 'grammars', GRAMMAR_SET_VERSION, currentRid())
}

// A dev-only fallback: the TreeSitter.DotNet NuGet native dir has the bootstrap
// grammars (TS/JS/Python/Go/Java/C#/Rust/C/C++/PHP/Ruby/Scala/Bash/Haskell/Julia/Razor).
function getDevNugetGrammarsDir(): string | null {
  const dir = path.join(
    os.homedir(),
    '.nuget',
    'packages',
    TREE_SITTER_NUGET_PACKAGE,
    TREE_SITTER_NUGET_VERSION,
    'runtimes',
    currentRid(),
    'native'
  )
  return dirHasGrammars(dir) ? dir : null
}

// `resources/**` is unpacked by electron-builder, so resolving relative to the
// selected executable works in both the source tree and a packaged app.
function getBundledGrammarCandidates(): string[] {
  const workerPath = resolveNativeWorkerPath()
  if (!workerPath) return []
  const workerDir = path.dirname(workerPath)
  return [
    path.join(workerDir, 'codegraph-worker', 'grammars'),
    // Compatibility with packages produced before CodeGraph assets moved under
    // native-worker/codegraph-worker.
    path.join(workerDir, 'grammars')
  ]
}

function getBundledGrammarsDir(): string | null {
  const candidates = getBundledGrammarCandidates()
  return candidates.find((dir) => dirHasGrammars(dir)) ?? null
}

function directoryExists(dir: string | null | undefined): dir is string {
  if (!dir) return false
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function findGrammarDiagnosticDir(): string | null {
  const override = process.env.OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR?.trim()
  const cache = getCodeGraphCacheGrammarsDir()
  const devNugetDir = path.join(
    os.homedir(),
    '.nuget',
    'packages',
    TREE_SITTER_NUGET_PACKAGE,
    TREE_SITTER_NUGET_VERSION,
    'runtimes',
    currentRid(),
    'native'
  )
  const candidates = [
    override,
    cache,
    ...getBundledGrammarCandidates(),
    ...(isDevBuild() ? [devNugetDir] : [])
  ]
  return candidates.find(directoryExists) ?? null
}

function dirHasGrammars(dir: string | null | undefined): boolean {
  return inspectGrammarDir(dir).grammarLibraries.length > 0
}

interface GrammarDirectoryInspection {
  coreLibraryReady: boolean
  grammarLibraries: string[]
  invalidFiles: string[]
}

function inspectGrammarDir(dir: string | null | undefined): GrammarDirectoryInspection {
  const empty: GrammarDirectoryInspection = {
    coreLibraryReady: false,
    grammarLibraries: [],
    invalidFiles: []
  }
  if (!dir) return empty
  try {
    const grammarLibraries = new Set<string>()
    const invalidFiles: string[] = []
    let coreLibraryReady = false
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const match = TREE_SITTER_LIB_RE.exec(entry.name)
      if (!match) continue
      if (!entry.isFile()) {
        invalidFiles.push(entry.name)
        continue
      }
      let size = 0
      try {
        size = fs.statSync(path.join(dir, entry.name)).size
      } catch {
        invalidFiles.push(entry.name)
        continue
      }
      if (size <= 0) {
        invalidFiles.push(entry.name)
        continue
      }
      const library = match[1].toLowerCase()
      if (library === TREE_SITTER_CORE_LIBRARY) {
        coreLibraryReady = true
      } else {
        grammarLibraries.add(library)
      }
    }
    return {
      coreLibraryReady,
      grammarLibraries: [...grammarLibraries].sort(),
      invalidFiles: invalidFiles.sort()
    }
  } catch {
    return empty
  }
}

// The directory the worker should load grammars from. Priority:
//   1. explicit OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR override
//   2. the optional download cache (permits grammar-only updates)
//   3. the RID-specific set bundled beside the nested CodeGraph worker
//   4. (dev only) the TreeSitter.DotNet NuGet native dir
export function resolveCodeGraphGrammarsDir(): string | null {
  const override = process.env.OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR?.trim()
  if (override && dirHasGrammars(override)) return override

  const cache = getCodeGraphCacheGrammarsDir()
  if (dirHasGrammars(cache)) return cache

  const bundled = getBundledGrammarsDir()
  if (bundled) return bundled

  if (isDevBuild()) {
    const dev = getDevNugetGrammarsDir()
    if (dev) return dev
  }
  return null
}

export function getCodeGraphAssetStatus(): CodeGraphAssetStatus {
  const isDev = isDevBuild()
  // Source-merged: CodeGraph ships inside the main worker binary.
  const workerReady = resolveNativeWorkerPath() != null
  // When no usable directory resolves, retain an existing candidate for precise
  // diagnostics (for example, a directory containing only a zero-byte runtime).
  const grammarsDir = resolveCodeGraphGrammarsDir() ?? findGrammarDiagnosticDir()
  const inspection = inspectGrammarDir(grammarsDir)
  const expectedGrammars = [...GRAMMAR_LANGUAGES.keys()].sort()
  const expectedGrammarSet = new Set(expectedGrammars)
  const availableGrammars = inspection.grammarLibraries.filter((grammar) =>
    expectedGrammarSet.has(grammar)
  )
  const unrecognizedGrammars = inspection.grammarLibraries.filter(
    (grammar) => !expectedGrammarSet.has(grammar)
  )
  const availableGrammarSet = new Set(availableGrammars)
  const missingGrammars = expectedGrammars.filter((grammar) => !availableGrammarSet.has(grammar))
  const availableLanguages = availableGrammars
    .flatMap((grammar) => GRAMMAR_LANGUAGES.get(grammar) ?? [])
    .sort()
  const missingLanguages = missingGrammars
    .flatMap((grammar) => GRAMMAR_LANGUAGES.get(grammar) ?? [])
    .sort()
  const grammarCount = availableGrammars.length
  const grammarsReady = inspection.coreLibraryReady && grammarCount > 0
  const runtimeReady = workerReady && grammarsReady
  const override = process.env.OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR?.trim()
  const grammarSource: CodeGraphAssetStatus['grammarSource'] = !grammarsDir
    ? 'none'
    : override === grammarsDir
      ? 'override'
      : getCodeGraphCacheGrammarsDir() === grammarsDir
        ? 'downloaded'
        : getBundledGrammarCandidates().includes(grammarsDir)
          ? 'bundled'
          : 'dev'
  const diagnostic: CodeGraphAssetDiagnostic = !workerReady
    ? 'worker-missing'
    : !grammarsDir
      ? 'grammar-directory-missing'
      : !inspection.coreLibraryReady
        ? 'core-library-missing'
        : grammarCount === 0
          ? 'language-grammars-missing'
          : inspection.invalidFiles.length > 0 || unrecognizedGrammars.length > 0
            ? 'invalid-grammar-files'
            : missingGrammars.length > 0
              ? 'incomplete-grammar-set'
              : 'ready'
  return {
    isDev,
    workerReady,
    workerRunning: isNativeWorkerRunning(),
    grammarsReady,
    // `ready` is retained for existing renderers and external IPC consumers.
    ready: runtimeReady,
    grammarsDir,
    grammarCount,
    runtimeReady,
    coreLibraryReady: inspection.coreLibraryReady,
    availableGrammars,
    missingGrammars,
    availableLanguages,
    missingLanguages,
    unrecognizedGrammars,
    invalidGrammarFiles: inspection.invalidFiles,
    grammarSource,
    diagnostic,
    // A complete packaged build always resolves its bundled grammar directory.
    // Keep this signal for damaged/legacy packages that shipped without one.
    needsDownload: !runtimeReady && !isDev
  }
}

export async function removeCodeGraphGrammars(): Promise<{ success: boolean; error?: string }> {
  try {
    fs.rmSync(getCodeGraphCacheGrammarsDir(), { recursive: true, force: true })
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

interface GrammarManifest {
  setVersion: string
  rid: string
  grammars: Array<{ name: string; url: string; sha256: string; bytes?: number }>
}

// Base URL for the per-RID grammar manifest. Defaults to the app's GitHub releases;
// override with OPEN_COWORK_CODEGRAPH_GRAMMARS_URL (must yield <base>/manifest-<rid>.json).
function grammarsBaseUrl(): string {
  const override = process.env.OPEN_COWORK_CODEGRAPH_GRAMMARS_URL?.trim()
  if (override) return override.replace(/\/$/, '')
  return `https://github.com/AIDotNet/OpenCowork/releases/download/codegraph-grammars-v${GRAMMAR_SET_VERSION}`
}

// Downloads + verifies the per-RID grammar set into the cache dir. The packs are
// produced by the WS-A CI (not yet published) — until then this resolves a clear
// "not published" error rather than crashing. Once the manifest/dylibs exist at the
// release URL, this works unchanged.
export async function downloadCodeGraphGrammars(
  onProgress: (p: CodeGraphDownloadProgress) => void
): Promise<{ success: boolean; error?: string }> {
  const rid = currentRid()
  const base = grammarsBaseUrl()
  const manifestUrl = `${base}/manifest-${rid}.json`
  try {
    onProgress({ phase: 'download', message: 'manifest', received: 0, total: 0 })
    const manifestRes = await fetch(manifestUrl)
    if (!manifestRes.ok) {
      return {
        success: false,
        error:
          manifestRes.status === 404
            ? `CodeGraph grammar packs for ${rid} are not published yet. Build them via the WS-A CI (workstreams/A) or set OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR to a local grammars directory.`
            : `manifest fetch failed (${manifestRes.status})`
      }
    }
    const manifest = (await manifestRes.json()) as GrammarManifest
    if (!Array.isArray(manifest.grammars) || manifest.grammars.length === 0) {
      return { success: false, error: 'grammar manifest is empty' }
    }

    const dir = getCodeGraphCacheGrammarsDir()
    const tmpDir = `${dir}.tmp-${process.pid}`
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.mkdirSync(tmpDir, { recursive: true })

    const total = manifest.grammars.length
    for (let i = 0; i < total; i++) {
      const g = manifest.grammars[i]
      onProgress({ phase: 'download', received: i, total, message: g.name })
      const res = await fetch(g.url)
      if (!res.ok) {
        fs.rmSync(tmpDir, { recursive: true, force: true })
        return { success: false, error: `download failed for ${g.name} (${res.status})` }
      }
      const buf = Buffer.from(await res.arrayBuffer())

      onProgress({ phase: 'verify', received: i, total, message: g.name })
      const hash = crypto.createHash('sha256').update(buf).digest('hex')
      if (g.sha256 && hash.toLowerCase() !== g.sha256.toLowerCase()) {
        fs.rmSync(tmpDir, { recursive: true, force: true })
        return { success: false, error: `SHA-256 mismatch for ${g.name}` }
      }
      fs.writeFileSync(path.join(tmpDir, g.name), buf)
    }

    // Atomic-ish swap into place.
    onProgress({ phase: 'extract', received: total, total, message: 'install' })
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    fs.renameSync(tmpDir, dir)

    onProgress({ phase: 'done', received: total, total })
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
