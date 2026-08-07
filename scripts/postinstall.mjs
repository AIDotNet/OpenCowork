/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { chmod, readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'

function isGlobalInstall() {
  const value = process.env.npm_config_global || process.env.NPM_CONFIG_GLOBAL
  return value === 'true' || value === '1'
}

/**
 * @param {string} projectDir
 * @returns {Promise<string>}
 */
async function readInstalledElectronVersion(projectDir) {
  const electronPackagePath = path.join(projectDir, 'node_modules', 'electron', 'package.json')
  const packageJson = JSON.parse(await readFile(electronPackagePath, 'utf8'))
  return packageJson.version
}

/**
 * npm install does not preserve the executable bit on node-pty's prebuilt spawn-helper,
 * which makes every pty spawn fail on macOS with "posix_spawnp failed".
 * @param {string} projectDir
 * @returns {Promise<void>}
 */
async function ensurePtySpawnHelperExecutable(projectDir) {
  if (process.platform === 'win32') return
  const prebuildsDir = path.join(projectDir, 'node_modules', 'node-pty', 'prebuilds')
  let entries = []
  try {
    entries = await readdir(prebuildsDir)
  } catch {
    return
  }
  for (const entry of entries) {
    const helperPath = path.join(prebuildsDir, entry, 'spawn-helper')
    try {
      await chmod(helperPath, 0o755)
      console.log(`> Restored executable bit on ${path.relative(projectDir, helperPath)}`)
    } catch {
      // this platform directory ships no spawn-helper
    }
  }
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  if (isGlobalInstall()) {
    await import('./install-cli.mjs')
    return
  }

  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { rebuild } = await import('@electron/rebuild')
  const electronVersion = await readInstalledElectronVersion(projectDir)
  // These packages ship prebuilt binaries; forcing node-gyp rebuilds makes CI require compilers.
  const prebuiltNativeModules = ['@jitsi/robotjs']
  const windowsPrebuiltNativeModules = ['node-pty']
  const ignoreModules = [
    ...prebuiltNativeModules,
    ...(process.platform === 'win32' ? windowsPrebuiltNativeModules : [])
  ]

  console.log(`> Rebuilding native dependencies for Electron ${electronVersion}`)

  if (ignoreModules.length > 0) {
    console.log(`> Skipping rebuild for: ${ignoreModules.join(', ')}`)
  }

  const rebuildResult = rebuild({
    buildPath: projectDir,
    electronVersion,
    arch: process.arch,
    platform: process.platform,
    projectRootPath: projectDir,
    mode: 'sequential',
    disablePreGypCopy: true,
    ignoreModules
  })

  rebuildResult.lifecycle.on('module-found', (moduleName) => {
    console.log(`  - preparing ${moduleName}`)
  })

  rebuildResult.lifecycle.on('module-done', (moduleName) => {
    console.log(`  - finished ${moduleName}`)
  })

  rebuildResult.lifecycle.on('module-skip', (moduleName) => {
    console.log(`  - skipped ${moduleName}`)
  })

  await rebuildResult
  await ensurePtySpawnHelperExecutable(projectDir)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
