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

function visualStudioMajorVersion() {
  if (process.platform !== 'win32') return 0

  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const vswhere = `${programFilesX86}\\Microsoft Visual Studio\\Installer\\vswhere.exe`
  if (!existsSync(vswhere)) return 0

  const result = spawnSync(
    vswhere,
    ['-latest', '-prerelease', '-products', '*', '-property', 'installationVersion'],
    { encoding: 'utf8', windowsHide: true }
  )
  if (result.status !== 0) return 0

  const major = Number.parseInt(result.stdout.trim().split('.')[0], 10)
  return Number.isFinite(major) ? major : 0
}

function lldLinkArgs(linker) {
  console.log(`[native-worker] win-arm64 Native AOT will link with ${linker}`)
  return [`/p:OpenCoworkWinArm64Linker=${linker}`]
}

// MSVC 14.44 (VS 2022) fatals win-arm64 Native AOT with LNK1322. VS 2026 (18.x)
// dropped that Cortex-A53 check, so keep its link.exe. Standalone LLVM
// lld-link does not accept ILCompiler's /SOURCELINK and /NOEXP flags.
// Fall back to lld-link only on older VS, or when the caller overrides.
export function winArm64AotLinkerArgs(rid) {
  if (rid !== 'win-arm64') return []

  const explicit = process.env.OPEN_COWORK_WIN_ARM64_LINKER?.trim()
  if (explicit) return lldLinkArgs(explicit)

  const vsMajor = visualStudioMajorVersion()
  if (vsMajor >= 18) {
    console.log(
      `[native-worker] win-arm64 Native AOT will use MSVC link.exe (Visual Studio ${vsMajor} dropped LNK1322)`
    )
    return []
  }

  const linker = findLldLink()
  if (!linker) {
    console.warn(
      '[native-worker] lld-link not found; win-arm64 Native AOT may fail with MSVC LNK1322 on VS 2022'
    )
    return []
  }

  return lldLinkArgs(linker)
}
