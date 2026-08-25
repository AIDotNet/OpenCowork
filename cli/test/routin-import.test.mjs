import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'oc-routin-import-'))
process.env.HOME = home
process.env.OPEN_COWORK_DATA_DIR = join(home, '.open-cowork')

const setup = await import(
  pathToFileURL(join(import.meta.dirname, '../dist/runtime/provider-setup.js')).href
)
const credential = await import(
  pathToFileURL(join(import.meta.dirname, '../dist/vendor/routin-credential.js')).href
)
const protocol = await import(
  pathToFileURL(join(import.meta.dirname, '../dist/vendor/opencowork-import-protocol.js')).href
)

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('parseOpenCoworkImportUrl classifies wallet and plan payloads', () => {
  const encode = (payload) =>
    Buffer.from(JSON.stringify(payload), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

  const walletUrl = `opencowork://import/provider#settings=base64url:${encode({
    providers: [{ builtinId: 'routin-ai', apiKey: 'ak-wallet', kind: 'apiKey' }],
    source: 'routin-device-login'
  })}`
  const planUrl = `opencowork://import/provider#settings=base64url:${encode({
    providers: [{ builtinId: 'routin-ai-plan', apiKey: 'plan-sub', kind: 'subscription' }],
    source: 'routin-device-login'
  })}`

  assert.equal(
    credential.parseOpenCoworkImportUrl(walletUrl)?.classification.builtinId,
    'routin-ai'
  )
  assert.equal(
    credential.parseOpenCoworkImportUrl(planUrl)?.classification.builtinId,
    'routin-ai-plan'
  )
})

test('pasting a plan- key into the Routin wallet preset writes routin-ai-plan', () => {
  const before = setup.snapshotRoutinCredentials()
  const selection = setup.persistProviderSetup({
    optionKey: 'builtin:routin-ai',
    name: 'Routin AI',
    baseUrl: 'https://api.routin.ai/v1',
    modelId: 'deepseek-v4-flash',
    apiKey: 'plan-from-cli-paste'
  })

  assert.match(selection.providerName, /套餐|plan/i)
  assert.equal(selection.modelId, 'gpt-5.5')

  const ready = setup.findReadyRoutinSelection()
  assert.ok(ready)
  assert.equal(ready.providerId, selection.providerId)

  assert.equal(
    setup.findReadyRoutinSelection({
      previous: setup.snapshotRoutinCredentials(),
      requireChange: true
    }),
    null
  )
  assert.ok(
    setup.findReadyRoutinSelection({ previous: before, requireChange: true }),
    'requireChange should accept a new key relative to the pre-login snapshot'
  )
})

test('v1 import document still writes the Routin wallet key and default model', () => {
  const result = setup.applyOpenCoworkImportDocumentToStore(
    protocol.documentFromV1Credential('ak-v1-wallet')
  )
  assert.equal(result.selection.modelId, 'deepseek-v4-flash')
  assert.match(result.selection.providerName, /Routin/)
  assert.equal(result.importedCount, 1)
})

test('v2 builtin overlay updates apiKey and merges models', () => {
  const created = protocol.applyOpenCoworkImportDocument(
    { providers: [] },
    {
      schemaVersion: 2,
      providers: [
        {
          kind: 'builtin',
          key: 'builtin:openai',
          builtinId: 'openai',
          apiKey: 'sk-first',
          models: [{ id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', enabled: true, contextLength: 1000 }]
        }
      ]
    },
    { createId: () => 'openai-1' }
  )
  const merged = protocol.applyOpenCoworkImportDocument(
    created.state,
    {
      schemaVersion: 2,
      providers: [
        {
          kind: 'builtin',
          key: 'builtin:openai',
          builtinId: 'openai',
          apiKey: 'sk-second',
          models: [
            { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol Overlay', contextLength: 400000 },
            { id: 'gpt-custom', name: 'Custom GPT', enabled: true }
          ]
        }
      ]
    },
    { createId: () => 'should-not-run' }
  )
  const provider = merged.state.providers.find((item) => item.builtinId === 'openai')
  assert.equal(merged.applied[0].created, false)
  assert.equal(provider.id, 'openai-1')
  assert.equal(provider.apiKey, 'sk-second')
  assert.equal(provider.models[0].name, 'GPT 5.6 Sol Overlay')
  assert.equal(provider.models[0].contextLength, 400000)
  assert.equal(provider.models[0].enabled, true)
  assert.equal(provider.models[1].id, 'gpt-custom')
})

test('v2 custom channel upserts by importKey and supports model replace', () => {
  const created = setup.applyOpenCoworkImportDocumentToStore({
    schemaVersion: 2,
    providers: [
      {
        kind: 'custom',
        key: 'custom:acme-gateway',
        name: 'Acme Gateway',
        type: 'openai-chat',
        baseUrl: 'https://llm.example.com/v1',
        apiKey: 'sk-acme',
        models: [
          { id: 'keep-me', name: 'Keep', enabled: true },
          { id: 'drop-me', name: 'Drop', enabled: true }
        ]
      }
    ]
  })
  assert.equal(created.selection.providerName, 'Acme Gateway')

  const replaced = protocol.applyOpenCoworkImportDocument(
    {
      providers: [
        {
          id: created.selection.providerId,
          importKey: 'custom:acme-gateway',
          name: 'Acme Gateway',
          type: 'openai-chat',
          baseUrl: 'https://llm.example.com/v1',
          apiKey: 'sk-acme',
          models: [
            { id: 'keep-me', name: 'Keep' },
            { id: 'drop-me', name: 'Drop' }
          ]
        }
      ]
    },
    {
      schemaVersion: 2,
      providers: [
        {
          kind: 'custom',
          key: 'custom:acme-gateway',
          apiKey: 'sk-acme-2',
          modelPolicy: 'replace',
          models: [{ id: 'only-this', name: 'Only', enabled: true }]
        }
      ]
    },
    { createId: () => 'should-not-run' }
  )
  const provider = replaced.state.providers.find((item) => item.importKey === 'custom:acme-gateway')
  assert.equal(provider.apiKey, 'sk-acme-2')
  assert.deepEqual(
    provider.models.map((model) => model.id),
    ['only-this']
  )
  assert.equal(replaced.applied[0].created, false)
})

test('v2 skips oauth builtins and demotes unknown builtinId with type+baseUrl', () => {
  const applied = protocol.applyOpenCoworkImportDocument(
    { providers: [] },
    {
      schemaVersion: 2,
      providers: [
        {
          kind: 'builtin',
          key: 'builtin:codex-oauth',
          builtinId: 'codex-oauth',
          apiKey: 'sk-nope'
        },
        {
          kind: 'builtin',
          key: 'builtin:future-lab',
          builtinId: 'future-lab',
          name: 'Future Lab',
          type: 'openai-chat',
          baseUrl: 'https://future.example.com/v1',
          apiKey: 'sk-future',
          models: [{ id: 'lab-1', name: 'Lab 1', enabled: true }]
        }
      ]
    },
    { createId: () => 'custom-1' }
  )
  assert.equal(applied.skipped.length, 1)
  assert.match(applied.skipped[0].reason, /oauth/)
  assert.equal(applied.applied.length, 1)
  assert.equal(applied.applied[0].importKey, 'custom:future-lab')
  assert.equal(applied.state.providers[0].builtinId, undefined)
  assert.equal(applied.state.providers[0].importKey, 'custom:future-lab')
})

test('callback parser accepts v1 credentials and v2 documents', () => {
  const v1 = protocol.parseOpenCoworkImportCallbackBody({
    state: 'x',
    apiKey: 'ak-cli',
    kind: 'apiKey'
  })
  assert.equal(v1?.kind, 'v1-credential')
  assert.equal(v1.apiKey, 'ak-cli')

  const v2 = protocol.parseOpenCoworkImportCallbackBody({
    state: 'x',
    schemaVersion: 2,
    providers: [{ builtinId: 'deepseek', apiKey: 'sk-ds' }]
  })
  assert.equal(v2?.kind, 'document')
  assert.equal(v2.document.schemaVersion, 2)
  assert.equal(v2.document.providers[0].builtinId, 'deepseek')
})

test('configRef host allowlist and deep-link roundtrip', () => {
  assert.equal(protocol.isAllowedOpenCoworkConfigRefUrl('https://routin.ai/api/import/1'), true)
  assert.equal(protocol.isAllowedOpenCoworkConfigRefUrl('https://api.routin.ai/import/1'), true)
  assert.equal(protocol.isAllowedOpenCoworkConfigRefUrl('https://evil.example/steal'), false)
  assert.equal(protocol.isAllowedOpenCoworkConfigRefUrl('http://routin.ai/import/1'), false)

  const url = protocol.encodeOpenCoworkImportUrl({
    schemaVersion: 2,
    providers: [{ builtinId: 'anthropic', apiKey: 'sk-ant' }]
  })
  const document = protocol.parseOpenCoworkImportUrlDocument(url)
  assert.equal(document?.schemaVersion, 2)
  assert.equal(document.providers[0].builtinId, 'anthropic')
  assert.equal(document.providers[0].apiKey, 'sk-ant')
})

test('device login URL advertises protocol 2', () => {
  const loginUrl = new URL(protocol.buildOpenCoworkDeviceLoginUrl({ client: 'desktop' }))
  assert.equal(loginUrl.searchParams.get('protocol'), '2')
  assert.equal(loginUrl.searchParams.get('client'), 'desktop')
})
