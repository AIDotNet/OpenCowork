import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

test('CLI vendor list includes generated runtime contracts', () => {
  const source = readFileSync(join(import.meta.dirname, '../scripts/sync-shared.mjs'), 'utf8')
  assert.match(source, /src\/shared\/runtime-contracts\/generated\/contracts\.ts/)
  assert.match(source, /src\/shared\/worker-contracts\/generated\/contracts\.ts/)
})
