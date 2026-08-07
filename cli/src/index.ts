#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command, Option } from 'commander'
import React from 'react'
import { render } from 'ink'
import { CliApp } from './app.js'
import { DemoRuntime, ShellRuntime } from './runtime/runtime.js'
import { TerminalScreen } from './terminal/terminal-screen.js'
import type { PermissionMode, TuiMode } from './types.js'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(currentDirectory, '../package.json'), 'utf-8')) as {
  version: string
}

interface CliOptions {
  demo: boolean
  model: string
  permissionMode: PermissionMode
  tui: TuiMode
}

const program = new Command()

program
  .name('opencowork')
  .description('OpenCowork — an agentic coding assistant for your terminal')
  .version(pkg.version, '-v, --version')
  .argument('[prompt]', 'Initial prompt to place in the editor')
  .option('--demo', 'Seed a transcript that exercises every UI message type', false)
  .option('--model <model>', 'Model label shown in the session UI', 'Auto')
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
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      program.error('Interactive mode requires a TTY. Run opencowork --help for options.')
    }

    const screen = new TerminalScreen(options.tui)
    const runtime = options.demo ? new DemoRuntime() : new ShellRuntime()

    screen.enter()

    try {
      const instance = render(
        <CliApp
          cwd={process.cwd()}
          initialModel={options.model}
          initialPermissionMode={options.permissionMode}
          initialPrompt={prompt ?? ''}
          runtime={runtime}
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
      await runtime.dispose()
      screen.exit()
    }
  })

await program.parseAsync(process.argv)
