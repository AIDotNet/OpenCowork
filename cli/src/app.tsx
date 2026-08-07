import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import { ModelPicker } from './components/model-picker.js'
import { PermissionPrompt } from './components/permission-prompt.js'
import { PromptInput } from './components/prompt-input.js'
import { StatusLine } from './components/status-line.js'
import { TaskList } from './components/task-list.js'
import { Transcript } from './components/transcript.js'
import { WelcomeCard } from './components/welcome-card.js'
import { useTerminalSize } from './hooks/use-terminal-size.js'
import { theme } from './theme.js'
import type {
  AgentRuntime,
  Message,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  RuntimeEvent,
  TaskItem,
  TuiMode
} from './types.js'

interface CliAppProps {
  cwd: string
  initialModel: string
  initialPermissionMode: PermissionMode
  initialPrompt: string
  runtime: AgentRuntime
  tuiMode: TuiMode
  version: string
}

const permissionModes: PermissionMode[] = ['manual', 'acceptEdits', 'plan', 'auto']
const effortLevels = ['low', 'medium', 'high']

function nowTimestamp(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date())
}

export function CliApp({
  cwd,
  initialModel,
  initialPermissionMode,
  initialPrompt,
  runtime,
  tuiMode,
  version
}: CliAppProps): React.JSX.Element {
  const { exit } = useApp()
  const { columns, rows } = useTerminalSize()
  const [messages, setMessages] = useState<Message[]>(() => [...(runtime.initialMessages ?? [])])
  const [tasks, setTasks] = useState<TaskItem[]>(() => [...(runtime.initialTasks ?? [])])
  const [model, setModel] = useState(initialModel)
  const [permissionMode, setPermissionMode] = useState(initialPermissionMode)
  const [effortIndex, setEffortIndex] = useState(2)
  const [showHelp, setShowHelp] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [showTasks, setShowTasks] = useState(Boolean(runtime.initialTasks?.length))
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [notice, setNotice] = useState<string>()
  const abortControllerRef = useRef<AbortController>()
  const noticeTimerRef = useRef<NodeJS.Timeout>()
  const messageIdRef = useRef(0)

  const contentWidth = Math.max(36, columns)
  const fullscreen = tuiMode === 'fullscreen'
  const maxVisibleMessages = Math.max(3, Math.floor((rows - 8) / (showDetails ? 4 : 2)))
  const visibleMessages = useMemo(
    () => (fullscreen ? messages.slice(-maxVisibleMessages) : messages),
    [fullscreen, maxVisibleMessages, messages]
  )

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    }
  }, [])

  const showNotice = (message: string): void => {
    setNotice(message)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(undefined), 1_600)
  }

  const appendSystem = (
    text: string,
    tone: Extract<Message, { kind: 'system' }>['tone'] = 'muted'
  ): void => {
    messageIdRef.current += 1
    setMessages((current) => [
      ...current,
      { id: `system-${Date.now()}-${messageIdRef.current}`, kind: 'system', text, tone }
    ])
  }

  const applyRuntimeEvent = (event: RuntimeEvent): void => {
    if (event.type === 'assistant.start') {
      setMessages((current) => [
        ...current,
        {
          id: event.id,
          kind: 'assistant',
          model: event.model,
          streaming: true,
          text: '',
          timestamp: nowTimestamp()
        }
      ])
      return
    }

    if (event.type === 'assistant.delta') {
      setMessages((current) =>
        current.map((message) =>
          message.id === event.id && message.kind === 'assistant'
            ? { ...message, text: message.text + event.text }
            : message
        )
      )
      return
    }

    if (event.type === 'assistant.done') {
      setMessages((current) =>
        current.map((message) =>
          message.id === event.id && message.kind === 'assistant'
            ? { ...message, streaming: false }
            : message
        )
      )
      return
    }

    if (event.type === 'tool.start') {
      setMessages((current) => [
        ...current,
        {
          id: event.id,
          kind: 'tool',
          title: event.title,
          detail: event.detail,
          status: 'running'
        }
      ])
      return
    }

    if (event.type === 'tool.done') {
      setMessages((current) =>
        current.map((message) =>
          message.id === event.id && message.kind === 'tool'
            ? { ...message, status: event.status, summary: event.summary }
            : message
        )
      )
      return
    }

    if (event.type === 'permission.request') {
      setPermissionRequest(event.request)
      return
    }

    if (event.type === 'tasks.update') {
      setTasks(event.tasks)
      return
    }

    if (event.type === 'system') setMessages((current) => [...current, event.message])
  }

  const runPrompt = async (prompt: string): Promise<void> => {
    if (isRunning) {
      showNotice('A turn is already running · Esc to interrupt')
      return
    }

    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, kind: 'user', text: prompt }
    ])
    const controller = new AbortController()
    abortControllerRef.current = controller
    setIsRunning(true)

    try {
      for await (const event of runtime.send(prompt, controller.signal)) {
        if (controller.signal.aborted) break
        applyRuntimeEvent(event)
      }
    } catch (error) {
      appendSystem(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      abortControllerRef.current = undefined
      setIsRunning(false)
    }
  }

  const handleCommand = (submission: string): boolean => {
    const [rawName, ...args] = submission.trim().split(/\s+/u)
    const name = rawName?.toLowerCase()

    if (name === '/clear') {
      abortControllerRef.current?.abort()
      setMessages([])
      setTasks([])
      setShowTasks(false)
      return true
    }
    if (name === '/help') {
      setShowHelp((current) => !current)
      return true
    }
    if (name === '/model') {
      setModelPickerOpen(true)
      return true
    }
    if (name === '/permissions') {
      setPermissionRequest({
        id: `permission-${Date.now()}`,
        tool: 'Bash',
        title: 'npm run typecheck',
        detail: 'Run the TypeScript compiler in the current workspace.',
        risk: 'This is a demo approval. The runtime has not started the command.'
      })
      return true
    }
    if (name === '/tasks') {
      setShowTasks((current) => !current)
      return true
    }
    if (name === '/plan') {
      setPermissionMode('plan')
      showNotice('Plan mode enabled')
      return true
    }
    if (name === '/effort') {
      const requested = args[0]
      const requestedIndex = requested ? effortLevels.indexOf(requested) : -1
      setEffortIndex((current) =>
        requestedIndex >= 0 ? requestedIndex : (current + 1) % effortLevels.length
      )
      return true
    }
    if (name === '/status') {
      appendSystem(
        `${model} · ${effortLevels[effortIndex]} effort · ${permissionMode} permissions · ${tuiMode} renderer`,
        'success'
      )
      return true
    }
    if (name === '/theme') {
      appendSystem('Theme tokens are active: adaptive dark terminal palette.', 'success')
      return true
    }
    if (name === '/tui') {
      const target = args[0]
      appendSystem(
        target && target !== tuiMode
          ? `Restart with --tui ${target} to switch renderers without losing shell state.`
          : `The ${tuiMode} renderer is active.`
      )
      return true
    }
    if (name === '/exit') {
      exit()
      return true
    }

    return false
  }

  const handleSubmit = (submission: string): void => {
    setShowHelp(false)
    if (submission.trimStart().startsWith('/') && handleCommand(submission)) return
    void runPrompt(submission)
  }

  const handlePermissionDecision = (decision: PermissionDecision): void => {
    const request = permissionRequest
    if (!request) return
    setPermissionRequest(null)
    const labels: Record<PermissionDecision, string> = {
      allow_once: 'Allowed once',
      allow_session: 'Allowed for this session',
      deny: 'Denied'
    }
    appendSystem(`${labels[decision]} · ${request.tool}: ${request.title}`, decision === 'deny' ? 'warning' : 'success')
    void runtime.respondToPermission?.(request.id, decision)
  }

  const cyclePermissionMode = (): void => {
    setPermissionMode((current) => {
      const index = permissionModes.indexOf(current)
      return permissionModes[(index + 1) % permissionModes.length] ?? 'manual'
    })
  }

  const inputActive = !permissionRequest && !modelPickerOpen
  const hasTranscript = visibleMessages.length > 0

  return (
    <Box
      flexDirection="column"
      height={fullscreen ? rows : undefined}
      justifyContent={fullscreen ? 'space-between' : 'flex-start'}
      width={contentWidth}
    >
      <Box flexDirection="column" flexGrow={fullscreen ? 1 : 0}>
        {!hasTranscript ? (
          <WelcomeCard cwd={cwd} model={model} version={version} width={contentWidth} />
        ) : (
          <Transcript messages={visibleMessages} showDetails={showDetails} width={contentWidth} />
        )}
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {showTasks && !permissionRequest && !modelPickerOpen ? (
          <TaskList tasks={tasks} width={contentWidth} />
        ) : null}

        {permissionRequest ? (
          <PermissionPrompt
            onDecision={handlePermissionDecision}
            request={permissionRequest}
            width={contentWidth}
          />
        ) : modelPickerOpen ? (
          <ModelPicker
            current={model}
            onCancel={() => setModelPickerOpen(false)}
            onSelect={(nextModel) => {
              setModel(nextModel)
              setModelPickerOpen(false)
              showNotice(`Model switched to ${nextModel}`)
            }}
            width={contentWidth}
          />
        ) : (
          <PromptInput
            active={inputActive}
            initialValue={initialPrompt}
            isRunning={isRunning}
            onAbort={() => {
              abortControllerRef.current?.abort()
              showNotice('Interrupted')
            }}
            onCycleMode={cyclePermissionMode}
            onExit={exit}
            onNotice={showNotice}
            onOpenModel={() => setModelPickerOpen(true)}
            onSubmit={handleSubmit}
            onToggleDetails={() => setShowDetails((current) => !current)}
            onToggleHelp={() => setShowHelp((current) => !current)}
            onToggleTasks={() => setShowTasks((current) => !current)}
            showHelp={showHelp}
            width={contentWidth}
          />
        )}

        <StatusLine
          effort={effortLevels[effortIndex] ?? 'high'}
          mode={permissionMode}
          notice={notice}
          width={contentWidth}
        />
        {fullscreen ? (
          <Text color={theme.dim}> </Text>
        ) : null}
      </Box>
    </Box>
  )
}
