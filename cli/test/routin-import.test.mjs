import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'oc-routin-import-'))
process.env.HOME = home
process.env.OPEN_COWORK_DATA_DIR = join(home, '.open-cowork')

const setup = await import(pathToFileURL(join(import.meta.dirname, '../dist/runtime/provider-setup.js')).href)
const credential = await import(
  pathToFileURL(join(import.meta.dirname, '../dist/vendor/routin-credential.js')).href
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

  assert.equal(credential.parseOpenCoworkImportUrl(walletUrl)?.classification.builtinId, 'routin-ai')
  assert.equal(
    credential.parseOpenCoworkImportUrl(planUrl)?.classification.builtinId,
    'routin-ai-plan'
  )
})

test('pasting a plan- key into the Routin wallet preset writes routin-ai-plan', () => {
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
})
