#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command, Option } from 'commander'
import { render } from 'ink'
import { CliApp } from './app.js'
import { OpenCoworkWorkerRuntime } from './runtime/open-cowork-worker-runtime.js'
import { TerminalScreen } from './terminal/terminal-screen.js'
import type { PermissionMode, TuiMode } from './types.js'
import { offerUpdate, updateCli } from './update.js'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

function loadPackageMetadata(): { version: string } {
  const candidates = [
    join(currentDirectory, '../../package.json'),
    join(currentDirectory, '../package.json')
  ]
  for (const candidate of candidates) {
    try {
      const metadata = JSON.parse(readFileSync(candidate, 'utf-8')) as {
        bin?: { opencowork?: string }
        name?: string
        version?: string
      }
      if (metadata.name === 'open-cowork' && metadata.bin?.opencowork && metadata.version) {
        return { version: metadata.version }
      }
      if (metadata.name === '@aidotnet/opencowork' && metadata.version) {
        return { version: metadata.version }
      }
    } catch {
      // Try the next package boundary. This also keeps the standalone cli package usable.
    }
  }
  return { version: '0.0.0' }
}

const pkg = loadPackageMetadata()

interface CliOptions {
  doctor: boolean
  model?: string
  permissionMode: PermissionMode
  provider?: string
  tui: TuiMode
  worker?: string
}

const program = new Command()

program
  .name('cowork')
  .description('OpenCowork — an agentic coding assistant for your terminal')
  .version(pkg.version, '-v, --version')
  .argument('[prompt]', 'Initial prompt to place in the editor')
  .option('--doctor', 'Check the Native Worker transport and shared provider configuration', false)
  .option('--worker <path>', 'Override the OpenCowork.Native.Worker executable path')
  .option('--provider <provider-id>', 'Select a configured OpenCowork provider for this session')
  .option('--model <model-id>', 'Select an enabled model for this session')
  .addOption(
    new Option('--permission-mode <mode>', 'Initial permission mode')
      .choices(['manual', 'acceptEdits', 'plan', 'auto'])
      .default('manual')
  )
  .addOption(
    new Option('--tui <renderer>', 'Terminal renderer')
      .choices(['classic', 'fullscreen'])
      .default('classic')
  )

program
  .command('update')
  .description('Update OpenCowork CLI to the latest version')
  .action(async () => {
    if (await updateCli()) return
    program.error('Update failed. Run: npm install -g @aidotnet/opencowork@latest')
  })

program
  .addHelpText(
    'after',
    `
Interactive shortcuts:
  /          Open commands             ?          Toggle shortcuts
  Shift+Tab  Cycle permission mode     Alt+P      Switch model
  Ctrl+O     Toggle tool details       Ctrl+T     Toggle task list
  Ctrl+C ×2  Exit                      Ctrl+L     Redraw
`
  )
  .action(async (prompt: string | undefined, options: CliOptions) => {
    if (!options.doctor && process.stdin.isTTY && process.stdout.isTTY) {
      await offerUpdate(pkg.version)
    }
    const workerRuntime = new OpenCoworkWorkerRuntime({
      appVersion: pkg.version,
      cwd: process.cwd(),
      effort: 'high',
      model: options.model,
      permissionMode: options.permissionMode,
      providerId: options.provider,
      workerPath: options.worker
    })
    const selectedModel = workerRuntime.getModelCatalog().active
    if (options.provider && selectedModel?.providerId !== options.provider) {
      await workerRuntime.dispose()
      program.error(
        `Provider “${options.provider}” is not enabled, authenticated, or configured with chat models.`
      )
    }
    if (options.model && selectedModel?.modelId !== options.model) {
      await workerRuntime.dispose()
      program.error(
        `Model “${options.model}” is not enabled${options.provider ? ` for provider “${options.provider}”` : ''}.`
      )
    }

    if (options.doctor) {
      try {
        const result = await workerRuntime.doctor()
        process.stdout.write(
          [
            'OpenCowork CLI doctor',
            `  Worker: ${result.executable}`,
            `  PID: ${result.pid}`,
            `  IPC protocol: v${result.protocolVersion}`,
            `  Agent protocol: v${result.agentProtocolVersion}`,
            `  Agent runtime: ${result.runtime} ${result.runtimeVersion}`,
            `  Routes: ${result.routeCount}`,
            `  Configured model: ${result.configuredModel}`,
            '  Status: ready',
            ''
          ].join('\n')
        )
      } finally {
        await workerRuntime.dispose()
      }
      return
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      await workerRuntime.dispose()
      program.error('Interactive mode requires a TTY. Run opencowork --help for options.')
    }

    const screen = new TerminalScreen(options.tui)

    screen.enter()

    try {
      const instance = render(
        <CliApp
          cwd={process.cwd()}
          initialPermissionMode={options.permissionMode}
          initialPrompt={prompt ?? ''}
          runtime={workerRuntime}
          tuiMode={options.tui}
          version={pkg.version}
        />,
        {
          exitOnCtrlC: false,
          patchConsole: false
        }
      )

      await instance.waitUntilExit()
    } finally {
      await workerRuntime.dispose()
      screen.exit()
    }
  })

await program.parseAsync(process.argv)
