#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(root, 'src')
const baselinePath = resolve(root, 'scripts/architecture-boundary-baseline.json')
const baselineVersion = 1

const rules = {
  sharedProcessIsolation: 'shared-process-isolation',
  rendererRuntimeMainIsolation: 'renderer-runtime-no-main',
  rendererRuntimeProviderIsolation: 'renderer-runtime-no-provider',
  rendererRuntimeToolIsolation: 'renderer-runtime-no-tool-executor',
  rendererViewAgentBridgeIsolation: 'renderer-view-no-agent-bridge',
  rendererViewToolRegistryIsolation: 'renderer-view-no-tool-registry',
  rendererViewToolHandlerIsolation: 'renderer-view-no-tool-handlers'
}
const knownRules = new Set(Object.values(rules))

const rendererRoot = 'src/renderer/src/'
const agentBridgePath = `${rendererRoot}lib/ipc/agent-bridge.ts`
const toolRegistryPath = `${rendererRoot}lib/agent/tool-registry.ts`
const rendererUiToolSupport = new Set([
  'ask-user-tool.ts',
  'bash-output.ts',
  'browser-native-ui.ts',
  'cron-events.ts',
  'plan-native-ui.ts',
  'tool-input-sanitizer.ts',
  'tool-result-format.ts',
  'tool-types.ts'
])
const toolExecutorFiles = new Set([
  `${rendererRoot}lib/agent/sub-agents/builtin/index.ts`,
  `${rendererRoot}lib/agent/sub-agents/create-tool.ts`,
  `${rendererRoot}lib/agent/sub-agents/resolve-tools.ts`,
  `${rendererRoot}lib/agent/teams/register.ts`,
  `${rendererRoot}lib/app-plugin/index.ts`,
  `${rendererRoot}lib/channel/plugin-tools.ts`,
  `${rendererRoot}lib/chat-mode-tools.ts`,
  `${rendererRoot}lib/extensions/extension-tools.ts`,
  `${rendererRoot}lib/mcp/mcp-tools.ts`,
  toolRegistryPath
])
// Shared modules that only a host process may import. Both speak to the worker
// over Node-only APIs (Buffer, child_process, raw sockets/HTTP), so a renderer
// import would either fail to bundle or hand the UI a transport it must not own.
const mainOnlySourceFiles = new Set([
  'src/shared/native-worker-protocol.ts',
  'src/shared/worker-http-channel.ts'
])
const mainOnlyPackages = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
  '@jitsi/robotjs',
  'better-sqlite3',
  'electron',
  'electron-updater',
  'node-cron',
  'node-pty',
  'ssh2'
])

const writeBaseline = process.argv.includes('--write-baseline')
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--write-baseline')
if (unknownArguments.length > 0) {
  console.error(`[verify:architecture] Unknown argument(s): ${unknownArguments.join(', ')}`)
  process.exit(1)
}

function toRepoPath(absolutePath) {
  const repoRelative = relative(root, absolutePath)
  if (!repoRelative || repoRelative === '..' || repoRelative.startsWith(`..${sep}`)) return null
  if (isAbsolute(repoRelative)) return null
  return repoRelative.split(sep).join('/')
}

function collectTypeScriptFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(absolutePath))
    } else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) {
      files.push(absolutePath)
    }
  }
  return files
}

function moduleCandidates(basePath) {
  const candidates = [basePath]
  const extension = extname(basePath)
  if (extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs') {
    const withoutExtension = basePath.slice(0, -extension.length)
    candidates.push(`${withoutExtension}.ts`, `${withoutExtension}.tsx`, `${withoutExtension}.d.ts`)
  } else if (!extension) {
    candidates.push(`${basePath}.ts`, `${basePath}.tsx`, `${basePath}.d.ts`)
  }
  candidates.push(
    resolve(basePath, 'index.ts'),
    resolve(basePath, 'index.tsx'),
    resolve(basePath, 'index.d.ts')
  )
  return candidates
}

function resolveLocalImport(sourcePath, rawSpecifier) {
  const specifier = rawSpecifier.split(/[?#]/u, 1)[0]
  let basePath = null
  if (specifier === '@renderer') {
    basePath = resolve(root, rendererRoot)
  } else if (specifier.startsWith('@renderer/')) {
    basePath = resolve(root, rendererRoot, specifier.slice('@renderer/'.length))
  } else if (specifier.startsWith('.')) {
    basePath = resolve(dirname(sourcePath), specifier)
  } else if (specifier.startsWith('src/')) {
    basePath = resolve(root, specifier)
  }

  if (!basePath) return null
  for (const candidate of moduleCandidates(basePath)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return toRepoPath(candidate)
    }
  }
  return toRepoPath(basePath)
}

function isStringLiteralLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
}

function collectImports(sourcePath) {
  const text = readFileSync(sourcePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    sourcePath,
    text,
    ts.ScriptTarget.ES2022,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const imports = []

  const record = (literal, kind) => {
    if (!literal || !isStringLiteralLike(literal)) return
    const position = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile))
    imports.push({
      kind,
      line: position.line + 1,
      specifier: literal.text,
      target: resolveLocalImport(sourcePath, literal.text)
    })
  }

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier, ts.isImportDeclaration(node) ? 'import' : 'export')
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node.moduleReference.expression, 'import-equals')
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      record(node.argument.literal, 'import-type')
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record(node.arguments[0], 'dynamic-import')
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        record(node.arguments[0], 'require')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return imports
}

function isRendererRuntimeSource(source) {
  if (!source.startsWith(rendererRoot)) return false
  const rendererPath = source.slice(rendererRoot.length)
  const fileName = basename(rendererPath)
  return (
    rendererPath.startsWith('lib/runtime/') ||
    rendererPath.startsWith('stores/runtime/') ||
    /^runtime-client\.tsx?$/u.test(fileName) ||
    /(?:^|-)runtime-projection-store\.tsx?$/u.test(fileName)
  )
}

function isRendererViewSource(source) {
  if (source === `${rendererRoot}App.tsx`) return true
  return (
    source.startsWith(`${rendererRoot}components/`) ||
    source.startsWith(`${rendererRoot}pages/`) ||
    source.startsWith(`${rendererRoot}views/`)
  )
}

function isProviderTarget(target) {
  if (!target) return false
  if (target.startsWith(`${rendererRoot}lib/api/`)) return true
  if (target.startsWith(`${rendererRoot}stores/providers/`)) return true
  if (target === `${rendererRoot}stores/provider-store.ts`) return true
  if (target === `${rendererRoot}lib/auth/provider-auth.ts`) return true
  if (target === `${rendererRoot}lib/ipc/ai-provider-storage.ts`) return true
  return false
}

function isToolExecutorTarget(target) {
  if (!target) return false
  if (toolExecutorFiles.has(target)) return true
  if (target.startsWith(`${rendererRoot}lib/agent/teams/tools/`)) return true

  const toolsPrefix = `${rendererRoot}lib/tools/`
  if (target.startsWith(toolsPrefix)) {
    return !rendererUiToolSupport.has(target.slice(toolsPrefix.length))
  }

  const appPluginPrefix = `${rendererRoot}lib/app-plugin/`
  if (target.startsWith(appPluginPrefix)) {
    const fileName = target.slice(appPluginPrefix.length)
    return fileName !== 'browser-tool-names.ts' && /(?:^|-)tool(?:-|\.)/u.test(fileName)
  }
  return false
}

function isMainOnlyDependency(target, specifier) {
  if (target?.startsWith('src/main/') || target?.startsWith('src/preload/')) return true
  if (target && mainOnlySourceFiles.has(target)) return true
  return mainOnlyPackages.has(specifier)
}

function violationTarget(dependency) {
  return dependency.target ?? `package:${dependency.specifier}`
}

function violationKey(violation) {
  return `${violation.rule}\u0000${violation.source}\u0000${violation.target}`
}

function addViolation(violations, dependency, source, rule, reason) {
  const violation = {
    rule,
    source,
    target: violationTarget(dependency),
    specifier: dependency.specifier,
    line: dependency.line,
    reason
  }
  const key = violationKey(violation)
  const existing = violations.get(key)
  if (!existing || violation.line < existing.line) violations.set(key, violation)
}

function scanViolations() {
  const violations = new Map()
  for (const sourcePath of collectTypeScriptFiles(sourceRoot)) {
    const source = toRepoPath(sourcePath)
    if (!source) continue

    for (const dependency of collectImports(sourcePath)) {
      const target = dependency.target
      if (
        source.startsWith('src/shared/') &&
        (target?.startsWith('src/main/') ||
          target?.startsWith('src/preload/') ||
          target?.startsWith('src/renderer/'))
      ) {
        addViolation(
          violations,
          dependency,
          source,
          rules.sharedProcessIsolation,
          'shared code may not depend on a process-specific source tree'
        )
      }

      if (isRendererRuntimeSource(source)) {
        if (isMainOnlyDependency(target, dependency.specifier)) {
          addViolation(
            violations,
            dependency,
            source,
            rules.rendererRuntimeMainIsolation,
            'renderer runtime clients and projections may not depend on Main/Preload or Node-only modules'
          )
        } else if (isProviderTarget(target)) {
          addViolation(
            violations,
            dependency,
            source,
            rules.rendererRuntimeProviderIsolation,
            'renderer runtime clients and projections may not depend on provider modules'
          )
        } else if (isToolExecutorTarget(target)) {
          addViolation(
            violations,
            dependency,
            source,
            rules.rendererRuntimeToolIsolation,
            'renderer runtime clients and projections may not depend on tool executors or registries'
          )
        }
      }

      if (!isRendererViewSource(source)) continue
      if (target === agentBridgePath) {
        addViolation(
          violations,
          dependency,
          source,
          rules.rendererViewAgentBridgeIsolation,
          'view code may not depend directly on the legacy agent bridge'
        )
      } else if (target === toolRegistryPath) {
        addViolation(
          violations,
          dependency,
          source,
          rules.rendererViewToolRegistryIsolation,
          'view code may not depend directly on the renderer tool registry'
        )
      } else if (isToolExecutorTarget(target)) {
        addViolation(
          violations,
          dependency,
          source,
          rules.rendererViewToolHandlerIsolation,
          'view code may not depend on non-UI tool handlers or catalogs'
        )
      }
    }
  }
  return [...violations.values()].sort((left, right) =>
    violationKey(left).localeCompare(violationKey(right))
  )
}

function baselineEntry(violation) {
  return {
    rule: violation.rule,
    source: violation.source,
    target: violation.target
  }
}

function writeCurrentBaseline(violations) {
  const baseline = {
    version: baselineVersion,
    generatedBy: 'node scripts/verify-architecture-boundaries.mjs --write-baseline',
    violations: violations.map(baselineEntry)
  }
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
  console.log(
    `[verify:architecture] Wrote ${violations.length} current violation(s) to ${toRepoPath(baselinePath)}.`
  )
}

function readBaseline() {
  if (!existsSync(baselinePath)) {
    throw new Error(`Missing baseline: ${toRepoPath(baselinePath)}`)
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  if (baseline?.version !== baselineVersion || !Array.isArray(baseline.violations)) {
    throw new Error(`Unsupported architecture baseline format in ${toRepoPath(baselinePath)}`)
  }

  const entries = []
  const keys = new Set()
  for (const entry of baseline.violations) {
    if (
      !entry ||
      typeof entry.rule !== 'string' ||
      typeof entry.source !== 'string' ||
      typeof entry.target !== 'string' ||
      !knownRules.has(entry.rule)
    ) {
      throw new Error(`Invalid architecture baseline entry: ${JSON.stringify(entry)}`)
    }
    const normalized = { rule: entry.rule, source: entry.source, target: entry.target }
    const key = violationKey(normalized)
    if (keys.has(key)) throw new Error(`Duplicate architecture baseline entry: ${key}`)
    keys.add(key)
    entries.push(normalized)
  }
  return { entries, keys }
}

function printRuleSummary(violations) {
  const counts = new Map()
  for (const violation of violations) {
    counts.set(violation.rule, (counts.get(violation.rule) ?? 0) + 1)
  }
  for (const rule of [...knownRules].sort()) {
    const count = counts.get(rule) ?? 0
    if (count > 0) console.log(`  - ${rule}: ${count}`)
  }
}

const currentViolations = scanViolations()
if (writeBaseline) {
  writeCurrentBaseline(currentViolations)
  printRuleSummary(currentViolations)
  process.exit(0)
}

let baseline
try {
  baseline = readBaseline()
} catch (error) {
  console.error(`[verify:architecture] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const currentKeys = new Set(currentViolations.map(violationKey))
const newViolations = currentViolations.filter(
  (violation) => !baseline.keys.has(violationKey(violation))
)
const resolvedViolations = baseline.entries.filter((entry) => !currentKeys.has(violationKey(entry)))

if (newViolations.length > 0) {
  console.error(
    `[verify:architecture] Found ${newViolations.length} new architecture boundary violation(s):`
  )
  for (const violation of newViolations) {
    console.error(
      `  - [${violation.rule}] ${violation.source}:${violation.line} -> ${violation.target}`
    )
    console.error(`    import: ${JSON.stringify(violation.specifier)}`)
    console.error(`    ${violation.reason}`)
  }
  console.error(
    '[verify:architecture] Remove the new dependency. Do not update the baseline unless an architecture decision explicitly approves the regression.'
  )
  process.exit(1)
}

console.log(
  `[verify:architecture] Passed: ${currentViolations.length} current violation(s) are baselined; ${resolvedViolations.length} baseline violation(s) have been removed.`
)
printRuleSummary(currentViolations)
