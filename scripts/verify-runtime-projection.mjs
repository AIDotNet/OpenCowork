#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options
  })
}

function fail(message) {
  throw new Error(`[verify:runtime-projection] ${message}`)
}

const projection = run(process.execPath, [
  '--experimental-strip-types',
  '--import',
  './scripts/lib/register-ts-ext.mjs',
  '--test',
  'scripts/test/runtime-projection.test.ts',
  'scripts/test/apply-runtime-overlay.test.ts',
  'scripts/test/worker-event-consumer.test.ts',
  'scripts/test/ui-capability-router.test.ts',
  'scripts/test/agent-session-service.test.ts',
  'scripts/test/agent-system-prompt.test.ts',
  'scripts/test/session-mode-tools.test.ts',
  'scripts/test/hosted-session-run.test.ts',
  'scripts/test/session-scope.test.ts',
  'scripts/test/compact-request-view.test.ts',
  'scripts/test/compact-watermark.test.ts',
  'scripts/test/system-command.test.ts'
])
if (projection.status !== 0) {
  process.stderr.write(projection.stderr || projection.stdout || '')
  process.exit(projection.status ?? 1)
}

const probePath = resolve(root, 'src/renderer/src/lib/runtime/_architecture_probe.ts')
writeFileSync(probePath, "import { app } from 'electron'\nexport const leakedMainImport = app\n")
try {
  const probed = run(process.execPath, ['scripts/verify-architecture-boundaries.mjs'])
  if (probed.status === 0) {
    fail('architecture probe import of electron should fail renderer-runtime-no-main')
  }
  const output = `${probed.stdout}\n${probed.stderr}`
  assert.match(
    output,
    /renderer-runtime-no-main/u,
    'architecture probe should report renderer-runtime-no-main'
  )
  assert.match(
    output,
    /lib\/runtime\/_architecture_probe\.ts/u,
    'architecture probe should name the runtime source file'
  )
} finally {
  if (existsSync(probePath)) unlinkSync(probePath)
}

const clean = run(process.execPath, ['scripts/verify-architecture-boundaries.mjs'])
if (clean.status !== 0) {
  process.stderr.write(clean.stderr || clean.stdout || '')
  fail('architecture boundaries should pass after removing the probe file')
}

console.log(
  '[verify:runtime-projection] Passed: snapshot/patches parity, overflow snapshot, expired attach, batched reduction, overlay merge, durable ACK-after-projection, UI capability pending map, hosted session reopen-on-evict, assembler tools/capability snapshot, cron hosted-session extras, shared system prompt parity, worker-native catalog families, host MCP/plugin/browser catalog, hosted team coordinator prompt, worker-allocated assistant message id, interactive hosted startRun path, compaction cut/fence/legacy derivation, renderer-runtime ratchet.'
)
