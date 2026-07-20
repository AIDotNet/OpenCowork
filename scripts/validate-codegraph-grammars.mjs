import { resolve } from 'node:path'
import {
  loadGrammarManifest,
  requiredGrammarLibraries,
  validateGrammarEntryPoints,
  resolveGrammarFiles
} from './codegraph-grammar-manifest.mjs'

try {
  const manifest = loadGrammarManifest()
  const { runtime, grammars } = requiredGrammarLibraries(manifest)
  const sourceDir = process.argv[2]
  const rid = process.argv[3]

  if ((sourceDir && !rid) || (!sourceDir && rid)) {
    throw new Error('usage: node scripts/validate-codegraph-grammars.mjs [source-directory rid]')
  }

  if (sourceDir) {
    const files = resolveGrammarFiles(resolve(sourceDir), rid, manifest)
    const inspected = validateGrammarEntryPoints(resolve(sourceDir), rid, manifest)
    const tools = [...new Set(inspected.map(({ tool }) => tool))].join(', ')
    console.log(
      `[validate-codegraph-grammars] ${rid}: ${files.length} native libraries are present ` +
        `(${runtime} runtime + ${grammars.length} grammars); ` +
        `${inspected.length} grammar exports verified with ${tools}`
    )
  } else {
    console.log(
      `[validate-codegraph-grammars] manifest is valid ` +
        `(${runtime} runtime + ${grammars.length} grammars)`
    )
  }
} catch (error) {
  console.error(`[validate-codegraph-grammars] ${error?.message ?? error}`)
  process.exit(1)
}
