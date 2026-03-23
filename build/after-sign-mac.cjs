const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function runCodesign(args) {
  execFileSync('codesign', args, { stdio: 'inherit' })
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)

  if (!fs.existsSync(appPath)) {
    throw new Error(`Expected macOS app bundle not found: ${appPath}`)
  }

  // Normalize the whole bundle to one ad-hoc signature before packaging.
  // If a real certificate is configured, electron-builder will sign again later.
  runCodesign(['--force', '--deep', '--sign', '-', '--timestamp=none', appPath])
  runCodesign(['--verify', '--deep', '--strict', '--verbose=2', appPath])
}
