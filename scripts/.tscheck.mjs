import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const projectPath = path.resolve(process.argv[2])
const configFile = ts.readConfigFile(projectPath, ts.sys.readFile)
if (configFile.error) {
  console.error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
  process.exit(2)
}

const parsed = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  path.dirname(projectPath),
  { noEmit: true, composite: false, incremental: false }
)

console.log(`files: ${parsed.fileNames.length}`)

const program = ts.createProgram(parsed.fileNames, parsed.options)
const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error)

for (const d of diagnostics.slice(0, 200)) {
  const message = ts.flattenDiagnosticMessageText(d.messageText, '\n  ')
  if (d.file && d.start != null) {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start)
    console.log(`${path.relative(process.cwd(), d.file.fileName)}:${line + 1}:${character + 1} TS${d.code}: ${message}`)
  } else {
    console.log(`TS${d.code}: ${message}`)
  }
}

console.log(`errors: ${diagnostics.length}`)
process.exit(diagnostics.length > 0 ? 1 : 0)
