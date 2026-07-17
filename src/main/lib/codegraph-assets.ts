import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { isNativeWorkerRunning, resolveNativeWorkerPath } from './native-worker'

// ---------------------------------------------------------------------------
// CodeGraph grammar assets (download-on-enable, with a dev-mode bypass).
//
// The CodeGraph C# worker ships WITHOUT its tree-sitter grammar libraries — they
// are downloaded when the user enables the plugin (reference/04 §6). In a dev
// build the grammars are taken from a local dir (the TreeSitter.DotNet NuGet cache
// or OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR) so a developer never has to download.
//
// The worker loads its grammars from OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR (wired in
// createCodeGraphWorkerEnv); this module resolves that directory + owns the
// download into ~/.open-cowork/codegraph/grammars/<setVersion>/<rid>/.
// ---------------------------------------------------------------------------

// Bump when the grammar ABI / pinned libtree-sitter version changes (invalidates cache).
const GRAMMAR_SET_VERSION = '1'

const GRAMMAR_LIB_RE = /^(lib)?tree-sitter.*\.(dylib|so|dll)$/i

export interface CodeGraphAssetStatus {
  isDev: boolean
  workerReady: boolean
  workerRunning: boolean
  grammarsReady: boolean
  ready: boolean
  grammarsDir: string | null
  grammarCount: number
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
    'treesitter.dotnet',
    '1.3.0',
    'runtimes',
    currentRid(),
    'native'
  )
  return dirHasGrammars(dir) ? dir : null
}

function dirHasGrammars(dir: string | null | undefined): boolean {
  return countGrammars(dir) > 0
}

function countGrammars(dir: string | null | undefined): number {
  if (!dir) return 0
  try {
    return fs.readdirSync(dir).filter((f) => GRAMMAR_LIB_RE.test(f)).length
  } catch {
    return 0
  }
}

// The directory the worker should load grammars from. Priority:
//   1. explicit OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR override
//   2. the download cache (if populated)
//   3. (dev only) the TreeSitter.DotNet NuGet native dir
export function resolveCodeGraphGrammarsDir(): string | null {
  const override = process.env.OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR?.trim()
  if (override && dirHasGrammars(override)) return override

  const cache = getCodeGraphCacheGrammarsDir()
  if (dirHasGrammars(cache)) return cache

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
  const grammarsDir = resolveCodeGraphGrammarsDir()
  const grammarCount = countGrammars(grammarsDir)
  const grammarsReady = grammarCount > 0
  return {
    isDev,
    workerReady,
    workerRunning: isNativeWorkerRunning(),
    grammarsReady,
    ready: workerReady && grammarsReady,
    grammarsDir,
    grammarCount,
    // Dev never *needs* a download (it can use the NuGet grammars); a packaged
    // build needs one until the cache is populated.
    needsDownload: !grammarsReady && !isDev
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
