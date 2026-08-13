import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ContractModelError,
  channelToMethodName,
  emitRuntimeTypeScript,
  parseContractModel
} from '../lib/contract-model.mjs'

const header = 'GENERATED test'

test('parses string literal enums, nullable fields, and command maps', () => {
  const model = parseContractModel(
    `
export const constants = { RUNTIME_MODEL_SCHEMA_VERSION: 1 } as const
export type Status = 'running' | 'done'
export interface PingParams { id: string; note: string | null }
export interface PingResult { ok: boolean; status: Status }
export interface RuntimeCommands {
  'runtime:ping': { params: PingParams; result: PingResult }
}
`,
    'enum-map.ts'
  )
  assert.equal(model.constants[0]?.value, 1)
  assert.deepEqual(model.enums[0]?.values, ['running', 'done'])
  assert.equal(model.dtos[0]?.fields[1]?.mapped.nullable, true)
  assert.equal(model.maps[0]?.entries[0]?.key, 'runtime:ping')
  assert.equal(channelToMethodName('runtime:ping'), 'ping')
})

test('parses JsonValue, Record, and discriminated event unions', () => {
  const model = parseContractModel(
    `
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject
export type JsonObject = Record<string, JsonValue>
export interface RuntimeReset { type: 'runtime.reset'; reason: string }
export interface RunChanged { type: 'runtime.run-changed'; details: JsonObject }
export type RuntimeEvent = RuntimeReset | RunChanged
export interface Envelope { event: RuntimeEvent; extra: Record<string, JsonValue> }
export interface RuntimeEvents {
  'runtime.reset': { payload: RuntimeReset }
}
`,
    'json-union.ts'
  )
  assert.ok(model.specialTypes.has('JsonValue'))
  assert.equal(model.unions[0]?.name, 'RuntimeEvent')
  const extra = model.dtos
    .find((dto) => dto.name === 'Envelope')
    ?.fields.find((field) => field.name === 'extra')
  assert.equal(extra?.mapped.kind, 'record')
  const eventField = model.dtos
    .find((dto) => dto.name === 'Envelope')
    ?.fields.find((field) => field.name === 'event')
  assert.equal(eventField?.mapped.kind, 'union')
  const generated = emitRuntimeTypeScript(model, header)
  assert.match(generated, /export function decodeRuntimeEvent\(/)
  assert.match(generated, /case 'runtime.reset':/)
})

test('rejects optional fields', () => {
  assert.throws(
    () => parseContractModel(`export interface Bad { id?: string }`, 'optional.ts'),
    (error) => error instanceof ContractModelError && /optional fields/.test(error.message)
  )
})

test('rejects unsupported unions', () => {
  assert.throws(
    () => parseContractModel(`export interface Bad { value: string | number }`, 'union.ts'),
    ContractModelError
  )
})
