/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const grammarManifestPath = fileURLToPath(
  new URL('../src/shared/codegraph-grammars.json', import.meta.url)
)

function requireObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value
}

function requireString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string`)
  }
  return value
}

export function loadGrammarManifest(path = grammarManifestPath) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read grammar manifest ${path}: ${error?.message ?? error}`)
  }

  validateGrammarManifest(manifest)
  return manifest
}

export function validateGrammarManifest(value) {
  const manifest = requireObject(value, 'manifest')
  if (manifest.schemaVersion !== 1) {
    throw new Error(`manifest.schemaVersion must be 1, received ${manifest.schemaVersion}`)
  }

  const source = requireObject(manifest.source, 'manifest.source')
  requireString(source.package, 'manifest.source.package')
  requireString(source.version, 'manifest.source.version')

  const runtime = requireObject(manifest.runtime, 'manifest.runtime')
  const runtimeLibrary = validateLibraryName(runtime.library, 'manifest.runtime.library')

  if (!Array.isArray(manifest.grammars) || manifest.grammars.length === 0) {
    throw new Error('manifest.grammars must be a non-empty array')
  }

  const libraries = new Set([runtimeLibrary])
  const languageIds = new Set()
  for (const [grammarIndex, grammarValue] of manifest.grammars.entries()) {
    const path = `manifest.grammars[${grammarIndex}]`
    const grammar = requireObject(grammarValue, path)
    const library = validateLibraryName(grammar.library, `${path}.library`)
    if (libraries.has(library)) {
      throw new Error(`${path}.library duplicates ${library}`)
    }
    libraries.add(library)

    if (!Array.isArray(grammar.languages) || grammar.languages.length === 0) {
      throw new Error(`${path}.languages must be a non-empty array`)
    }
    for (const [languageIndex, languageValue] of grammar.languages.entries()) {
      const languagePath = `${path}.languages[${languageIndex}]`
      const language = requireObject(languageValue, languagePath)
      const id = requireString(language.id, `${languagePath}.id`)
      if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        throw new Error(`${languagePath}.id is not a valid language id: ${id}`)
      }
      if (languageIds.has(id)) {
        throw new Error(`${languagePath}.id duplicates ${id}`)
      }
      languageIds.add(id)

      const entryPoint = requireString(language.entryPoint, `${languagePath}.entryPoint`)
      if (!/^tree_sitter_[a-z0-9_]+$/.test(entryPoint)) {
        throw new Error(`${languagePath}.entryPoint is invalid: ${entryPoint}`)
      }
    }
  }

  return manifest
}

function validateLibraryName(value, path) {
  const library = requireString(value, path)
  if (!/^tree-sitter(?:-[a-z0-9]+)*$/.test(library)) {
    throw new Error(`${path} is not a portable tree-sitter library base name: ${library}`)
  }
  return library
}

export function requiredGrammarLibraries(manifest) {
  return {
    runtime: manifest.runtime.library,
    grammars: manifest.grammars.map((grammar) => grammar.library)
  }
}

export function nativeLibraryFileName(library, rid) {
  if (/^win-(?:x64|arm64)$/.test(rid)) return `${library}.dll`
  if (/^osx-(?:x64|arm64)$/.test(rid)) return `lib${library}.dylib`
  if (/^linux-(?:x64|arm64)$/.test(rid)) return `lib${library}.so`
  throw new Error(`unsupported CodeGraph grammar RID: ${rid}`)
}

export function resolveGrammarFiles(sourceDir, rid, manifest) {
  const { runtime, grammars } = requiredGrammarLibraries(manifest)
  const expected = [runtime, ...grammars].map((library) => ({
    kind: library === runtime ? 'runtime' : 'grammar',
    library,
    file: nativeLibraryFileName(library, rid)
  }))
  const available = new Set(readdirSync(sourceDir))
  const missing = expected.filter(({ file }) => !available.has(file))
  if (missing.length > 0) {
    throw new Error(
      `missing required ${rid} native libraries: ${missing
        .map(({ kind, library, file }) => `${kind} ${library} (${file})`)
        .join(', ')}`
    )
  }
  return expected
}

function symbolToolCandidates(rid, file) {
  if (rid.startsWith('osx-')) {
    return [
      { command: 'nm', args: ['-gU', file] },
      { command: 'llvm-nm', args: ['--extern-only', '--defined-only', file] },
      { command: 'objdump', args: ['--syms', file] }
    ]
  }
  if (rid.startsWith('linux-')) {
    return [
      { command: 'nm', args: ['-D', '--defined-only', file] },
      { command: 'llvm-nm', args: ['--dynamic', '--extern-only', '--defined-only', file] },
      { command: 'objdump', args: ['-T', file] }
    ]
  }
  if (rid.startsWith('win-')) {
    return [
      { command: 'dumpbin', args: ['/nologo', '/exports', file] },
      { command: 'llvm-nm', args: ['--extern-only', '--defined-only', file] },
      { command: 'objdump', args: ['-p', file] }
    ]
  }
  throw new Error(`unsupported CodeGraph grammar RID: ${rid}`)
}

function inspectNativeSymbols(file, rid) {
  const attempts = []
  for (const candidate of symbolToolCandidates(rid, file)) {
    const result = spawnSync(candidate.command, candidate.args, {
      encoding: 'utf8',
      windowsHide: true
    })
    if (result.error?.code === 'ENOENT') {
      attempts.push(`${candidate.command}: not found`)
      continue
    }
    if (result.error) {
      attempts.push(`${candidate.command}: ${result.error.message}`)
      continue
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim()
      attempts.push(`${candidate.command}: ${detail}`)
      continue
    }
    return { tool: candidate.command, output: `${result.stdout}\n${result.stderr}` }
  }

  const tools = symbolToolCandidates(rid, file)
    .map(({ command }) => command)
    .join(', ')
  throw new Error(
    `cannot inspect exports for ${file} (${rid}); install one of: ${tools}. ` +
      `Attempts: ${attempts.join('; ')}`
  )
}

function hasExportedSymbol(output, entryPoint) {
  const escaped = entryPoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9_])_?${escaped}(?:$|[^A-Za-z0-9_])`, 'm').test(output)
}

export function validateGrammarEntryPoints(sourceDir, rid, manifest) {
  const files = resolveGrammarFiles(sourceDir, rid, manifest)
  const filesByLibrary = new Map(files.map((file) => [file.library, file]))
  const inspected = []

  for (const grammar of manifest.grammars) {
    const nativeLibrary = filesByLibrary.get(grammar.library)
    const file = join(sourceDir, nativeLibrary.file)
    const symbols = inspectNativeSymbols(file, rid)
    const entryPoints = [...new Set(grammar.languages.map((language) => language.entryPoint))]
    const missing = entryPoints.filter(
      (entryPoint) => !hasExportedSymbol(symbols.output, entryPoint)
    )
    if (missing.length > 0) {
      throw new Error(
        `grammar ${grammar.library} (${nativeLibrary.file}) does not export ` +
          `${missing.join(', ')}; inspected with ${symbols.tool}`
      )
    }
    inspected.push({
      library: grammar.library,
      file: nativeLibrary.file,
      entryPoints,
      tool: symbols.tool
    })
  }

  return inspected
}
