/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const DEV_PORT = 5173

async function clearViteCache(projectDir) {
  const viteCacheDir = path.join(projectDir, 'node_modules', '.vite')
  await rm(viteCacheDir, { recursive: true, force: true })
}

function currentRid() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'osx-arm64' : 'osx-x64'
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'win-arm64' : 'win-x64'
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  throw new Error(`Unsupported native worker platform: ${process.platform}/${process.arch}`)
}

function latestSourceMtime(directory) {
  let latest = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'bin' || entry.name === 'obj') continue
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      latest = Math.max(latest, latestSourceMtime(entryPath))
    } else if (entry.name.endsWith('.cs') || entry.name.endsWith('.csproj')) {
      latest = Math.max(latest, statSync(entryPath).mtimeMs)
    }
  }
  return latest
}

function hasPublishedAotWorker(outputDir, executableName) {
  const sqliteName =
    process.platform === 'win32'
      ? 'e_sqlite3.dll'
      : process.platform === 'darwin'
        ? 'libe_sqlite3.dylib'
        : 'libe_sqlite3.so'
  return (
    existsSync(path.join(outputDir, executableName)) && existsSync(path.join(outputDir, sqliteName))
  )
}

function latestInputMtime(inputPaths) {
  return Math.max(
    ...inputPaths.map((inputPath) => {
      const stats = statSync(inputPath)
      return stats.isDirectory() ? latestSourceMtime(inputPath) : stats.mtimeMs
    })
  )
}

function publishAotWorker({
  projectDir,
  label,
  projectPath,
  outputDir,
  executableName,
  inputPaths
}) {
  const outputExecutable = path.join(outputDir, executableName)
  const newestInputMtime = latestInputMtime(inputPaths)

  if (
    hasPublishedAotWorker(outputDir, executableName) &&
    statSync(outputExecutable).mtimeMs >= newestInputMtime
  ) {
    console.log(`[predev] ${label} AOT worker is up to date`)
    return
  }

  const tempOutputDir = mkdtempSync(
    path.join(os.tmpdir(), `open-cowork-${label.toLowerCase()}-dev-`)
  )
  const args = [
    'publish',
    projectPath,
    '-c',
    'Release',
    '-r',
    currentRid(),
    '-o',
    tempOutputDir,
    '--nologo',
    '/p:PublishAot=true',
    '/p:StripSymbols=true'
  ]
  const nugetSource = process.env.OPEN_COWORK_NUGET_SOURCE?.trim()
  if (nugetSource) args.push('--source', nugetSource)

  console.log(`[predev] publishing ${label} AOT worker (${currentRid()})…`)
  const result = spawnSync('dotnet', args, { cwd: projectDir, stdio: 'inherit' })

  if (result.error) {
    rmSync(tempOutputDir, { recursive: true, force: true })
    if (result.error.code === 'ENOENT') {
      throw new Error(
        `dotnet was not found on PATH. Install the .NET SDK and ${label} AOT prerequisites.`
      )
    }
    throw result.error
  }

  if (result.status !== 0) {
    rmSync(tempOutputDir, { recursive: true, force: true })
    throw new Error(`${label} AOT publish failed (dotnet exited with ${result.status}).`)
  }

  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })
  cpSync(tempOutputDir, outputDir, { recursive: true })

  // Debug-symbol bundles are dev/crash-archive artifacts; resources/** ships into
  // the installer, so never leave them in the output (78+ MB of DWARF).
  if (process.env.OPEN_COWORK_KEEP_DSYM !== '1') {
    for (const entry of readdirSync(outputDir)) {
      if (entry.endsWith('.dSYM') || entry.endsWith('.dbg') || entry.endsWith('.pdb')) {
        rmSync(path.join(outputDir, entry), { recursive: true, force: true })
      }
    }
  }
  rmSync(tempOutputDir, { recursive: true, force: true })
}

// Development runs the same AOT shape as packaged builds. Publishing is cached
// by source mtime so unchanged `npm run dev` starts do not pay the AOT cost.
function publishNativeWorker(projectDir) {
  const projectPath = path.join(
    projectDir,
    'sidecars',
    'OpenCowork.Native.Worker',
    'OpenCowork.Native.Worker.csproj'
  )
  publishAotWorker({
    projectDir,
    label: 'Native',
    projectPath,
    outputDir: path.join(projectDir, 'resources', 'native-worker'),
    executableName:
      process.platform === 'win32' ? 'OpenCowork.Native.Worker.exe' : 'OpenCowork.Native.Worker',
    inputPaths: [
      path.dirname(projectPath),
      // CodeGraph is source-merged into this worker: Core changes must rebuild it.
      path.join(projectDir, 'sidecars', 'OpenCowork.CodeGraph.Core'),
      path.join(projectDir, 'global.json')
    ]
  })

  publishCodeGraphWorker(projectDir)
}

function publishCodeGraphWorker(projectDir) {
  const projectPath = path.join(
    projectDir,
    'sidecars',
    'OpenCowork.CodeGraph.Worker',
    'OpenCowork.CodeGraph.Worker.csproj'
  )
  publishAotWorker({
    projectDir,
    label: 'CodeGraph',
    projectPath,
    outputDir: path.join(projectDir, 'resources', 'native-worker', 'codegraph-worker'),
    executableName:
      process.platform === 'win32'
        ? 'OpenCowork.CodeGraph.Worker.exe'
        : 'OpenCowork.CodeGraph.Worker',
    inputPaths: [
      path.dirname(projectPath),
      path.join(projectDir, 'sidecars', 'OpenCowork.CodeGraph.Core'),
      path.join(projectDir, 'sidecars', 'OpenCowork.Worker.Runtime'),
      path.join(projectDir, 'global.json')
    ]
  })
}

async function ensurePortAvailable(port) {
  const hosts = ['127.0.0.1', '::1']

  for (const host of hosts) {
    await new Promise((resolve, reject) => {
      const server = net.createServer()

      server.once('error', (error) => {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL')
        ) {
          resolve()
          return
        }

        server.close()
        reject(error)
      })

      server.once('listening', () => {
        server.close((closeError) => {
          if (closeError) {
            reject(closeError)
            return
          }
          resolve()
        })
      })

      server.listen(port, host)
    })
  }
}

async function main() {
  const projectDir = process.cwd()
  if (process.argv.includes('--native-only')) {
    publishNativeWorker(projectDir)
    return
  }
  if (process.argv.includes('--codegraph-only')) {
    publishCodeGraphWorker(projectDir)
    return
  }

  await clearViteCache(projectDir)

  try {
    await ensurePortAvailable(DEV_PORT)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
      console.error(
        `Port ${DEV_PORT} is already in use. Stop the existing dev server before running ` +
          '`npm run dev` so the app does not keep talking to stale renderer assets.'
      )
      process.exitCode = 1
      return
    }

    throw error
  }

  publishNativeWorker(projectDir)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
