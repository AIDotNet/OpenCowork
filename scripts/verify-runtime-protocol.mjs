#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decode, encode } from '@msgpack/msgpack'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = resolve(root, 'scripts/fixtures/runtime-protocol.json')

function fail(message) {
  throw new Error(`[verify:runtime-protocol] ${message}`)
}

function readRepoFile(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function parseTypeScript(path) {
  return ts.createSourceFile(path, readRepoFile(path), ts.ScriptTarget.ES2022, true)
}

function interfaceFields(source, name) {
  const declaration = source.statements.find(
    (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === name
  )
  if (!declaration || !ts.isInterfaceDeclaration(declaration)) {
    fail(`Missing interface ${name} in ${source.fileName}`)
  }
  return declaration.members
    .filter(ts.isPropertySignature)
    .map((member) => member.name?.getText(source))
    .filter(Boolean)
}

function csharpRecordFields(source, name) {
  const match = source.match(new RegExp(`public sealed record ${name}\\(([^)]*)\\);`, 'u'))
  if (!match) fail(`Missing C# record ${name}`)
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const pieces = part.split(/\s+/u)
      return pieces[pieces.length - 1]
    })
}

function pascalCase(name) {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

const dsl = spawnSync(process.execPath, ['--test', 'scripts/test/contract-dsl.test.mjs'], {
  cwd: root,
  stdio: 'inherit'
})
if (dsl.status !== 0) process.exit(dsl.status ?? 1)

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
assert.equal(fixture.version, 1, 'runtime protocol fixture version')

const generatedTs = parseTypeScript('src/shared/runtime-contracts/generated/contracts.ts')
const generatedCs = readRepoFile(
  'sidecars/OpenCowork.Native.Worker/Generated/AgentRuntimeContracts.g.cs'
)
const generatedIpc = readRepoFile('src/shared/runtime-contracts/generated/ipc.ts')
const model = readRepoFile('src/shared/runtime-contracts/model.ts')

assert.match(model, /RUNTIME_MODEL_SCHEMA_VERSION:\s*1/u)
assert.match(generatedIpc, /export const RUNTIME_PATCH_CHANNEL = 'runtime:patch'/u)
assert.match(generatedIpc, /createOpenCoworkRuntimeAPI/u)
assert.match(generatedIpc, /OpenCoworkRuntimeAPI/u)

for (const channel of [
  'runtime:initialize',
  'runtime:attach',
  'runtime:cancel-run',
  'runtime:resolve-approval',
  'runtime:complete-ui-capability'
]) {
  assert.match(generatedIpc, new RegExp(`'${channel}'`, 'u'), `generated ipc includes ${channel}`)
}

const tsFields = interfaceFields(generatedTs, 'RuntimeEventEnvelope')
const csFields = csharpRecordFields(generatedCs, 'RuntimeEventEnvelope')
assert.deepEqual(
  csFields,
  tsFields.map((name) => pascalCase(name)),
  'RuntimeEventEnvelope field names match between TS and C#'
)

assert.equal(
  fixture.envelope.schemaVersion,
  1,
  'fixture envelope schemaVersion matches RUNTIME_MODEL_SCHEMA_VERSION'
)
for (const field of tsFields) {
  assert.ok(
    Object.prototype.hasOwnProperty.call(fixture.envelope, field),
    `fixture envelope contains ${field}`
  )
}

const roundTripped = decode(encode(fixture.envelope))
assert.deepEqual(roundTripped, fixture.envelope, 'runtime envelope survives MessagePack round-trip')

assert.equal(fixture.envelope.event.type, 'runtime.reset')
assert.equal(fixture.attachResult.mode, 'snapshot')
assert.equal(fixture.attachResult.snapshot.runs[0].runId, fixture.envelope.runId)
assert.equal(fixture.attachResult.errorCode, null)

console.log(
  `[verify:runtime-protocol] Passed: envelope fields ${tsFields.join(', ')}; MessagePack round-trip ok.`
)
