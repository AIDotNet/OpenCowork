import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const lldLinkCandidates = [
  'C:\\Program Files\\LLVM\\bin\\lld-link.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\Llvm\\ARM64\\bin\\lld-link.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\VC\\Tools\\Llvm\\ARM64\\bin\\lld-link.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Tools\\Llvm\\ARM64\\bin\\lld-link.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\VC\\Tools\\Llvm\\ARM64\\bin\\lld-link.exe'
]

function findLldLink() {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['lld-link'], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status === 0) {
    const first = result.stdout.trim().split(/\r?\n/)[0]
    if (first) return first
  }

  return lldLinkCandidates.find((candidate) => existsSync(candidate)) ?? ''
}

// MSVC 14.44 fatals win-arm64 Native AOT with LNK1322. Prefer lld-link, which
// does not implement that Cortex-A53 check. No-op on every other RID.
export function winArm64AotLinkerArgs(rid) {
  if (rid !== 'win-arm64') return []

  const linker = process.env.OPEN_COWORK_WIN_ARM64_LINKER?.trim() || findLldLink()
  if (!linker) {
    console.warn(
      '[native-worker] lld-link not found; win-arm64 Native AOT may fail with MSVC LNK1322 on VS 2022'
    )
    return []
  }

  console.log(`[native-worker] win-arm64 Native AOT will link with ${linker}`)
  return [`/p:OpenCoworkWinArm64Linker=${linker}`]
}
