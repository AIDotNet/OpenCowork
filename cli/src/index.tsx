#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command, Option } from 'commander'
import { render, useApp } from 'ink'
import { CliApp } from './app.js'
import { ProviderSetupPanel } from './components/provider-setup-panel.js'
import { useTerminalSize } from './hooks/use-terminal-size.js'
import { FixtureAgentRuntime, isFixtureRuntimeRequested } from './runtime/fixture-runtime.js'
import { OpenCoworkWorkerRuntime } from './runtime/open-cowork-worker-runtime.js'
import { loadProviderSetupCatalog, persistProviderSetup } from './runtime/provider-setup.js'
import { TerminalScreen } from './terminal/terminal-screen.js'
import type {
  ModelSelection,
  PermissionMode,
  ProviderSetupCatalog,
  ResumeResult,
  TuiMode
} from './types.js'
import {
  PRINT_EXIT_CONFIG_ERROR,
  readStdinPrompt,
  runPrintMode,
  type PrintOutputFormat
} from './print-mode.js'
import { repairNativeWorker, updateCli } from './update.js'
import { initializeCliI18n, readLanguageArgument, t } from './i18n.js'

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

// Resolve the language before constructing Commander. This keeps both normal help and
// `--language <code> --help` localized on the very first process invocation.
await initializeCliI18n(readLanguageArgument())

interface CliOptions {
  continue?: boolean
  doctor: boolean
  language?: string
  maxTurns?: string
  model?: string
  outputFormat: PrintOutputFormat
  permissionMode: PermissionMode
  print: boolean
  provider?: string
  resume?: string
  timeout?: string
  tui: TuiMode
  worker?: string
}

const program = new Command()

program.configureHelp({
  styleTitle: (title) => {
    const titles: Record<string, string> = {
      'Usage:': t('cli.help.usage', 'Usage:'),
      'Arguments:': t('cli.help.arguments', 'Arguments:'),
      'Options:': t('cli.help.options', 'Options:'),
      'Commands:': t('cli.help.commandSection', 'Commands:'),
      'Global Options:': t('cli.help.globalOptions', 'Global Options:')
    }
    return titles[title] ?? title
  },
  styleDescriptionText: (description) =>
    description
      .replace(/\bchoices:/gu, `${t('cli.help.choices', 'choices')}:`)
      .replace(/\bdefault:/gu, `${t('cli.help.default', 'default')}:`)
})

function ProviderConfigCommand({
  catalog,
  onCancel,
  onConfigured,
  startDeviceLogin = false
}: {
  catalog: ProviderSetupCatalog
  onCancel(): void
  onConfigured(selection: ModelSelection): void
  startDeviceLogin?: boolean
}): React.JSX.Element {
  const { exit } = useApp()
  const { columns, rows } = useTerminalSize()
  return (
    <ProviderSetupPanel
      catalog={catalog}
      maxVisible={Math.max(4, Math.min(12, rows - 12))}
      onboarding={!startDeviceLogin && catalog.configuredCount === 0}
      startDeviceLogin={startDeviceLogin}
      onCancel={() => {
        onCancel()
        exit()
      }}
      onReadyFromStore={async (selection) => {
        onConfigured(selection)
        exit()
      }}
      onSave={async (input) => {
        const selection = persistProviderSetup(input)
        onConfigured(selection)
        exit()
      }}
      width={Math.max(35, columns - 1)}
    />
  )
}

async function runProviderSetupCommand(options?: {
  deviceLogin?: boolean
  /** When true, skip the standalone “provider ready” banner — caller will enter the TUI. */
  quiet?: boolean
}): Promise<ModelSelection | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    program.error(
      t(
        'cli.errors.configTty',
        'Provider setup requires a TTY. Run cowork config in an interactive terminal.'
      )
    )
  }

  const result: { selection?: ModelSelection } = {}
  const instance = render(
    <ProviderConfigCommand
      catalog={loadProviderSetupCatalog()}
      startDeviceLogin={Boolean(options?.deviceLogin)}
      onCancel={() => undefined}
      onConfigured={(configured) => {
        result.selection = configured
      }}
    />,
    { exitOnCtrlC: false, patchConsole: false }
  )
  await instance.waitUntilExit()
  if (result.selection && !options?.quiet) {
    process.stdout.write(
      `${t('cli.output.providerReady', 'Provider ready: {{provider}} / {{model}}', {
        provider: result.selection.providerName,
        model: result.selection.modelName
      })}\n` +
        `${t(
          'cli.output.sharedConfiguration',
          'The same configuration is now available in OpenCowork desktop.'
        )}\n`
    )
  }
  return result.selection
}

async function runInteractiveSession(options: CliOptions, prompt?: string): Promise<void> {
  const maxTurns = options.maxTurns ? Number.parseInt(options.maxTurns, 10) : undefined
  if (options.maxTurns && (!Number.isFinite(maxTurns) || (maxTurns as number) <= 0)) {
    program.error(t('cli.errors.maxTurns', '--max-turns requires a positive integer.'), {
      exitCode: PRINT_EXIT_CONFIG_ERROR
    })
  }
  // PTY golden tests swap in a deterministic scripted runtime; everything else —
  // option validation, screen management, Ink wiring — runs exactly as in production.
  const fixtureRuntime = isFixtureRuntimeRequested() ? new FixtureAgentRuntime() : null
  const workerRuntime = new OpenCoworkWorkerRuntime({
    appVersion: pkg.version,
    cwd: process.cwd(),
    maxTurns,
    model: options.model,
    permissionMode: options.permissionMode,
    providerId: options.provider,
    workerPath: options.worker
  })
  const selectedModel = (fixtureRuntime ?? workerRuntime).getModelCatalog().active
  if (options.provider && selectedModel?.providerId !== options.provider) {
    await workerRuntime.dispose()
    program.error(
      t(
        'cli.errors.provider',
        'Provider “{{provider}}” is not enabled, authenticated, or configured with chat models.',
        { provider: options.provider }
      ),
      { exitCode: PRINT_EXIT_CONFIG_ERROR }
    )
  }
  if (options.model && selectedModel?.modelId !== options.model) {
    await workerRuntime.dispose()
    program.error(
      t('cli.errors.model', 'Model “{{model}}” is not enabled{{providerSuffix}}.', {
        model: options.model,
        providerSuffix: options.provider ? ` for provider “${options.provider}”` : ''
      }),
      { exitCode: PRINT_EXIT_CONFIG_ERROR }
    )
  }

  // Resolve --continue / --resume before any UI or print run so both entry paths
  // start from the restored canonical history. Uses the existing Worker DB routes
  // through resumeSession; no session-host support is required.
  let initialResume: ResumeResult | undefined
  if (!options.doctor && (options.continue || options.resume)) {
    if (options.continue && options.resume) {
      await workerRuntime.dispose()
      program.error(t('cli.errors.continueResume', '--continue and --resume cannot be combined.'), {
        exitCode: PRINT_EXIT_CONFIG_ERROR
      })
    }
    try {
      let sessionId = options.resume?.trim()
      if (!sessionId) {
        const sessions = await workerRuntime.listResumableSessions()
        sessionId = sessions[0]?.id
        if (!sessionId) {
          throw new Error(
            t('cli.errors.noResumableSession', 'No resumable CLI session found for this folder.')
          )
        }
      }
      initialResume = await workerRuntime.resumeSession(sessionId)
    } catch (error) {
      await workerRuntime.dispose()
      program.error(error instanceof Error ? error.message : String(error), {
        exitCode: PRINT_EXIT_CONFIG_ERROR
      })
    }
  }

  if (options.doctor) {
    try {
      const result = await workerRuntime.doctor()
      process.stdout.write(
        [
          t('cli.output.doctorTitle', 'OpenCowork CLI doctor'),
          `  ${t('cli.output.worker', 'Worker: {{value}}', { value: result.executable })}`,
          `  ${t('cli.output.pid', 'PID: {{value}}', { value: result.pid })}`,
          `  ${t('cli.output.ipcProtocol', 'IPC protocol: v{{value}}', { value: result.protocolVersion })}`,
          `  ${t('cli.output.agentProtocol', 'Agent protocol: v{{value}}', { value: result.agentProtocolVersion })}`,
          `  ${t('cli.output.agentRuntime', 'Agent runtime: {{runtime}} {{version}}', {
            runtime: result.runtime,
            version: result.runtimeVersion
          })}`,
          `  ${t('cli.output.routes', 'Routes: {{value}}', { value: result.routeCount })}`,
          `  ${t('cli.output.configuredModel', 'Configured model: {{value}}', {
            value: result.configuredModel
          })}`,
          ...result.checks.map((check) => {
            const symbol = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '✗'
            return `  ${symbol} ${check.label}: ${check.detail}`
          }),
          result.checks.some((check) => check.status === 'error')
            ? `  ${t('cli.output.doctorIssues', 'Status: issues found')}`
            : `  ${t('cli.output.ready', 'Status: ready')}`,
          ''
        ].join('\n')
      )
      if (result.checks.some((check) => check.status === 'error')) process.exitCode = 1
    } finally {
      await workerRuntime.dispose()
    }
    return
  }

  if (options.print) {
    const promptText = prompt?.trim() || (!process.stdin.isTTY ? await readStdinPrompt() : '')
    if (!promptText) {
      await workerRuntime.dispose()
      program.error(
        t(
          'cli.errors.printPrompt',
          'Print mode needs a prompt: cowork -p "prompt" or echo "prompt" | cowork -p'
        ),
        { exitCode: PRINT_EXIT_CONFIG_ERROR }
      )
    }
    if (!selectedModel) {
      await workerRuntime.dispose()
      program.error(t('cli.errors.printModel', 'No model configured. Run: cowork config'), {
        exitCode: PRINT_EXIT_CONFIG_ERROR
      })
    }
    const timeoutSeconds = options.timeout ? Number.parseFloat(options.timeout) : undefined
    if (options.timeout && (!Number.isFinite(timeoutSeconds) || (timeoutSeconds as number) <= 0)) {
      await workerRuntime.dispose()
      program.error(t('cli.errors.timeout', '--timeout requires a positive number of seconds.'), {
        exitCode: PRINT_EXIT_CONFIG_ERROR
      })
    }
    let printExitCode = PRINT_EXIT_CONFIG_ERROR
    try {
      const result = await runPrintMode(workerRuntime, {
        outputFormat: options.outputFormat,
        prompt: promptText,
        timeoutSeconds
      })
      printExitCode = result.exitCode
    } finally {
      await workerRuntime.dispose()
    }
    // Spawned children (MCP servers, the Native Worker) can keep handles open past
    // dispose. A pipeline needs a deterministic exit, so flush stdout and leave.
    await new Promise<void>((resolveFlush) => process.stdout.write('', () => resolveFlush()))
    process.exit(printExitCode)
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    await workerRuntime.dispose()
    program.error(
      t(
        'cli.errors.interactiveTty',
        'Interactive mode requires a TTY. Run opencowork --help for options.'
      )
    )
  }

  const screen = new TerminalScreen(options.tui)

  screen.enter()

  try {
    // Redraws (Ctrl+L, terminal resize) are handled inside CliApp through Ink's stdout
    // writer so the clear and the frame repaint happen atomically — see app.tsx `redraw`.
    const instance = render(
      <CliApp
        cwd={process.cwd()}
        initialPermissionMode={options.permissionMode}
        initialPrompt={prompt ?? ''}
        initialResume={initialResume}
        runtime={fixtureRuntime ?? workerRuntime}
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
}

program
  .name('cowork')
  .helpOption('-h, --help', t('cli.options.help', 'display help for command'))
  .description(
    t('cli.app.description', 'OpenCowork — an agentic coding assistant for your terminal')
  )
  .version(pkg.version, '-v, --version', t('cli.options.version', 'Show version number'))
  .argument('[prompt]', t('cli.options.prompt', 'Initial prompt to place in the editor'))
  .option(
    '-l, --language <language>',
    t('cli.options.language', 'Interface language (auto-detected when omitted)')
  )
  .option(
    '--doctor',
    t('cli.options.doctor', 'Check the agent runtime transport and shared provider configuration'),
    false
  )
  .option(
    '--worker <path>',
    t('cli.options.worker', 'Override the OpenCowork.Native.Worker executable path')
  )
  .option(
    '--provider <provider-id>',
    t('cli.options.provider', 'Select a configured OpenCowork provider for this session')
  )
  .option('--model <model-id>', t('cli.options.model', 'Select an enabled model for this session'))
  .addOption(
    new Option(
      '--permission-mode <mode>',
      t('cli.options.permissionMode', 'Initial permission mode')
    )
      .choices(['manual', 'acceptEdits', 'plan', 'auto'])
      .default('manual')
  )
  .addOption(
    new Option('--tui <renderer>', t('cli.options.tui', 'Terminal renderer'))
      .choices(['classic', 'fullscreen'])
      .default('classic')
  )
  .option(
    '-p, --print',
    t('cli.options.print', 'Run one prompt without the interactive UI and print the result'),
    false
  )
  .addOption(
    new Option(
      '--output-format <format>',
      t('cli.options.outputFormat', 'Print-mode output format')
    )
      .choices(['text', 'json', 'stream-json'])
      .default('text')
  )
  .option(
    '--max-turns <count>',
    t('cli.options.maxTurns', 'Maximum agent loop turns before the run stops')
  )
  .option(
    '--timeout <seconds>',
    t('cli.options.timeout', 'Abort a print-mode run after this many seconds')
  )
  .option(
    '-c, --continue',
    t('cli.options.continue', 'Continue the most recent CLI session in this folder')
  )
  .option(
    '--resume <session-id>',
    t('cli.options.resume', 'Resume a specific stored CLI session by id')
  )

program
  .command('update')
  .description(t('cli.commands.update', 'Update OpenCowork CLI to the latest version'))
  .option(
    '--repair',
    t('cli.options.repair', 'Reinstall the Native Worker binary for this machine'),
    false
  )
  .action(async (options: { repair: boolean }) => {
    if (options.repair) {
      if (await repairNativeWorker()) {
        process.stdout.write(`${t('cli.output.repairDone', 'Native Worker reinstalled.')}\n`)
        return
      }
      program.error(
        t(
          'cli.errors.repair',
          'Native Worker reinstall failed. Check network access, then retry: cowork update --repair'
        )
      )
      return
    }
    if (await updateCli()) return
    program.error(
      t('cli.errors.update', 'Update failed. Run: npm install -g @aidotnet/opencowork@latest')
    )
  })

program
  .command('config')
  .alias('configure')
  .description(t('cli.commands.config', 'Quickly configure an AI provider in the terminal'))
  .action(async () => {
    await runProviderSetupCommand()
  })

program
  .command('login')
  .description(
    t(
      'cli.commands.login',
      'Open Routin device login in the browser, then enter the interactive CLI'
    )
  )
  .action(async () => {
    const selection = await runProviderSetupCommand({ deviceLogin: true, quiet: true })
    if (!selection) return
    // Reuse the same interactive bootstrap as bare `cowork` so login does not dump
    // the user back at the shell after credentials land.
    await runInteractiveSession({
      doctor: false,
      maxTurns: undefined,
      model: selection.modelId,
      outputFormat: 'text',
      permissionMode: 'manual',
      print: false,
      provider: selection.providerId,
      tui: 'classic'
    })
  })

program
  .addHelpText(
    'after',
    `\n${t('cli.help.title', 'Interactive shortcuts:')}
  /          ${t('cli.help.commands', 'Open commands')}             ?          ${t('cli.help.shortcuts', 'Toggle shortcuts')}
  /provider  ${t('cli.help.provider', 'Configure provider')}        /login     ${t('cli.help.login', 'Routin browser login')}
  /model     ${t('cli.help.model', 'Switch model')}             Shift+Tab  ${t('cli.help.modes', 'Cycle modes / Plan')}
  Alt+P      ${t('cli.help.model', 'Switch model')}             Ctrl+O     ${t('cli.help.details', 'Toggle reasoning/details')}
  Ctrl+T     ${t('cli.help.tasks', 'Toggle task list')}         Ctrl+C ×2  ${t('cli.help.exit', 'Exit')}
  Ctrl+L     ${t('cli.help.redraw', 'Redraw')}
`
  )
  .action(async (prompt: string | undefined, options: CliOptions) => {
    await runInteractiveSession(options, prompt)
  })

await program.parseAsync(process.argv)
