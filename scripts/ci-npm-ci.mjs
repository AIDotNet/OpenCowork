/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

const MAX_ATTEMPTS = 3
const ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
const NODE_MODULES_DIR = path.resolve('node_modules')

function runNpmCi(env) {
  return spawnSync('npm', ['ci'], {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32'
  })
}

function removeNodeModules() {
  if (!existsSync(NODE_MODULES_DIR)) return

  try {
    rmSync(NODE_MODULES_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 })
  } catch (error) {
    console.warn(
      `> Failed to remove node_modules (${error.message}); trying a Windows rmdir fallback`
    )
  }

  if (process.platform === 'win32' && existsSync(NODE_MODULES_DIR)) {
    spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', NODE_MODULES_DIR], { stdio: 'inherit' })
  }
}

async function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const env = { ...process.env }
    if (attempt > 1) {
      env.ELECTRON_MIRROR = env.ELECTRON_MIRROR || ELECTRON_MIRROR
      console.log(
        `\n> npm ci failed; retrying (${attempt}/${MAX_ATTEMPTS}) with ELECTRON_MIRROR=${env.ELECTRON_MIRROR}`
      )
      removeNodeModules()
      await sleep(process.platform === 'win32' ? 15_000 : 5_000)
    }

    const result = runNpmCi(env)
    if (result.status === 0) {
      process.exit(0)
    }

    const status = result.status ?? 1
    console.error(`> npm ci exited ${status} (attempt ${attempt}/${MAX_ATTEMPTS})`)
    if (result.error) {
      console.error(result.error)
    }
  }

  process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
