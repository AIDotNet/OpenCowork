import type {
  AgentRuntime,
  Message,
  RuntimeEvent,
  TaskItem
} from '../types.js'

async function pause(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false

  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve(true)
    }, milliseconds)

    const handleAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }

    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

export class ShellRuntime implements AgentRuntime {
  async *send(_prompt: string, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    const id = `assistant-${Date.now()}`
    yield { type: 'assistant.start', id, model: 'UI shell' }

    const chunks = [
      'The terminal rendering shell is ready. ',
      'Its AgentRuntime boundary is intentionally provider-agnostic; ',
      'connect the OpenCowork native runtime to stream real turns and tools.'
    ]

    for (const text of chunks) {
      if (!(await pause(90, signal))) return
      yield { type: 'assistant.delta', id, text }
    }

    yield { type: 'assistant.done', id }
    yield { type: 'turn.done' }
  }

  async dispose(): Promise<void> {}
}

const demoMessages: Message[] = [
  {
    id: 'demo-user',
    kind: 'user',
    text: 'Inspect the CLI and recreate the terminal experience.'
  },
  {
    id: 'demo-assistant',
    kind: 'assistant',
    text: 'I’ll inspect the current package, map the rendering states, and build the UI shell.'
  },
  {
    id: 'demo-tool-read',
    kind: 'tool',
    title: 'Read(cli/package.json)',
    detail: 'Loaded package metadata and TypeScript configuration.',
    status: 'success',
    summary: 'Read 34 lines'
  },
  {
    id: 'demo-tool-build',
    kind: 'tool',
    title: 'Bash(npm run typecheck)',
    detail: '> tsc --noEmit -p tsconfig.json\n\nFound 0 errors.',
    status: 'success',
    summary: 'Completed in 1.8s'
  },
  {
    id: 'demo-final',
    kind: 'assistant',
    text: 'The renderer now has responsive welcome, transcript, command, task, and permission states.'
  }
]

const demoTasks: TaskItem[] = [
  { id: 'research', label: 'Inspect the reference terminal behavior', status: 'completed' },
  { id: 'renderer', label: 'Build the responsive renderer shell', status: 'in_progress' },
  { id: 'runtime', label: 'Connect the native agent runtime', status: 'pending' }
]

export class DemoRuntime implements AgentRuntime {
  readonly initialMessages = demoMessages
  readonly initialTasks = demoTasks

  async *send(prompt: string, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    const toolId = `tool-${Date.now()}`
    const assistantId = `assistant-${Date.now()}`

    yield {
      type: 'tool.start',
      id: toolId,
      title: `Search(${JSON.stringify(prompt.slice(0, 42))})`,
      detail: 'Scanning the demo runtime…'
    }

    if (!(await pause(350, signal))) return

    yield {
      type: 'tool.done',
      id: toolId,
      status: 'success',
      summary: '3 matches'
    }
    yield { type: 'assistant.start', id: assistantId, model: 'Demo' }

    for (const text of [
      'This response is streamed through the same event contract ',
      'that the native OpenCowork agent runtime will use. ',
      'Press Ctrl+O to expand tool details or /permissions to inspect approval UI.'
    ]) {
      if (!(await pause(120, signal))) return
      yield { type: 'assistant.delta', id: assistantId, text }
    }

    yield { type: 'assistant.done', id: assistantId }
    yield { type: 'turn.done' }
  }

  async dispose(): Promise<void> {}
}
