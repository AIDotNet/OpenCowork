import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

const packageName = '@aidotnet/opencowork'

function run(command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.replace(/^v/u, '').split(/[.-]/u)
  const rightParts = right.replace(/^v/u, '').split(/[.-]/u)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? '0'
    const rightPart = rightParts[index] ?? '0'
    const leftNumber = Number(leftPart)
    const rightNumber = Number(rightPart)
    const comparison =
      Number.isNaN(leftNumber) || Number.isNaN(rightNumber)
        ? leftPart.localeCompare(rightPart)
        : leftNumber - rightNumber
    if (comparison !== 0) return comparison
  }
  return 0
}

export async function getLatestVersion(): Promise<string | null> {
  try {
    const result = await run('npm', [
      'view',
      packageName,
      'version',
      '--registry=https://registry.npmjs.org'
    ])
    if (result.code !== 0) return null
    const version = result.output.trim().split(/\s+/u).at(-1)
    return version && /^\d+\.\d+\.\d+/u.test(version) ? version : null
  } catch {
    return null
  }
}

export async function updateCli(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', `${packageName}@latest`], { stdio: 'inherit' })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
}

export async function offerUpdate(currentVersion: string): Promise<void> {
  const latestVersion = await getLatestVersion()
  if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0) return

  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(
      `A new OpenCowork version (${latestVersion}) is available. Update now? [Y/n] `
    )
    if (answer.trim() && !/^y(?:es)?$/iu.test(answer.trim())) return

    console.log('Updating OpenCowork CLI...')
    if (await updateCli()) {
      console.log('Update complete. Restart cowork to use the new version.')
      process.exit(0)
    }
    console.error(`Update failed. Run: npm install -g ${packageName}@latest`)
  } finally {
    prompt.close()
  }
}
