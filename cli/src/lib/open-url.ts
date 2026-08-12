import { spawn } from 'node:child_process'

function launcher(url: string): { args: string[]; command: string } {
  if (process.platform === 'darwin') return { args: [url], command: 'open' }
  // `start` is a cmd builtin; the empty string is the window title cmd would otherwise
  // consume from a quoted URL.
  if (process.platform === 'win32') return { args: ['/c', 'start', '', url], command: 'cmd' }
  return { args: [url], command: 'xdg-open' }
}

/**
 * Open a web page in the host browser without blocking the terminal UI. Headless shells, remote
 * SSH sessions, and locked-down containers have no launcher, so callers must keep showing the URL
 * and treat `false` as “tell the user to open it manually”. Set `OPENCOWORK_CLI_NO_BROWSER=1` to
 * force that path where a launcher exists but would open the page on the wrong machine.
 */
export function openExternalUrl(url: string): boolean {
  if (process.env.OPENCOWORK_CLI_NO_BROWSER === '1') return false

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const { args, command } = launcher(parsed.href)
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}
