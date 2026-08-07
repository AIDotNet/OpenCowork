import React, { useEffect, useRef, useState } from 'react'
import { Box, Static, Text, useApp } from 'ink'
import { AgentPanel } from './components/agent-panel.js'
import { AskUserPrompt } from './components/ask-user-prompt.js'
import { ModelPicker } from './components/model-picker.js'
import { PlanPanel } from './components/plan-panel.js'
import { PermissionPrompt } from './components/permission-prompt.js'
import { PromptInput } from './components/prompt-input.js'
import { StatusLine } from './components/status-line.js'
import { TaskList } from './components/task-list.js'
import { Transcript } from './components/transcript.js'
import { WelcomeCard } from './components/welcome-card.js'
import { slashCommands } from './commands.js'
import { useTerminalSize } from './hooks/use-terminal-size.js'
import { theme } from './theme.js'
import type {
  AgentRuntime,
  AgentOption,
  AskUserRequest,
  Message,
  ModelCatalog,
  ModelSelection,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PlanApprovalMode,
  PlanSnapshot,
  UiEvent,
  TaskItem,
  TuiMode
} from './types.js'

interface CliAppProps {
  cwd: string
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
  initialPermissionMode,
  initialPrompt,
  runtime,
  tuiMode,
  version
}: CliAppProps): React.JSX.Element {
  const { exit } = useApp()
  const { columns, rows } = useTerminalSize()
  const initialCatalogRef = useRef<ModelCatalog | null>(null)
  initialCatalogRef.current ??= runtime.getModelCatalog()
  const [messages, setMessages] = useState<Message[]>([])
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [agents, setAgents] = useState<AgentOption[]>(() => runtime.getAgentCatalog())
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>(initialCatalogRef.current)
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(
    initialCatalogRef.current.active
  )
  const [permissionMode, setPermissionMode] = useState(initialPermissionMode)
  const [effortIndex, setEffortIndex] = useState(2)
  const [showHelp, setShowHelp] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [agentPanelOpen, setAgentPanelOpen] = useState(false)
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null)
  const [askUserRequest, setAskUserRequest] = useState<AskUserRequest | null>(null)
  const [plan, setPlan] = useState<PlanSnapshot | null>(null)
  const [planActionPending, setPlanActionPending] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [notice, setNotice] = useState<string>()
  const abortControllerRef = useRef<AbortController | undefined>(undefined)
  const noticeTimerRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const messageIdRef = useRef(0)

  const contentWidth = Math.max(36, columns)
  const fullscreen = tuiMode === 'fullscreen'
  const maxVisibleMessages = Math.max(3, Math.floor((rows - 8) / (showDetails ? 4 : 2)))
  const firstMutableMessage = messages.findIndex(
    (message) =>
      (message.kind === 'assistant' && message.streaming) ||
      (message.kind === 'tool' && message.status === 'running')
  )
  const committedMessages = fullscreen
    ? []
    : messages.slice(0, firstMutableMessage < 0 ? messages.length : firstMutableMessage)
  const dynamicMessages = fullscreen
    ? messages.slice(-maxVisibleMessages)
    : messages.slice(firstMutableMessage < 0 ? messages.length : firstMutableMessage)

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

  const openModelPicker = (): void => {
    const catalog = runtime.getModelCatalog()
    const currentAvailable = catalog.groups.some(
      (group) =>
        group.providerId === modelSelection?.providerId &&
        group.models.some((option) => option.modelId === modelSelection.modelId)
    )
    const nextSelection = currentAvailable ? modelSelection : catalog.active
    setModelCatalog(catalog)
    setModelSelection(nextSelection)
    if (nextSelection && !currentAvailable) {
      runtime.configure?.({
        model: nextSelection.modelId,
        providerId: nextSelection.providerId
      })
    }
    setModelPickerOpen(true)
  }

  const openAgentPanel = (): void => {
    setAgents(runtime.getAgentCatalog())
    setAgentPanelOpen(true)
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

  const applyRuntimeEvent = (event: UiEvent): void => {
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

    if (event.type === 'assistant.thinking') {
      setMessages((current) =>
        current.map((message) =>
          message.id === event.id && message.kind === 'assistant'
            ? { ...message, thinking: (message.thinking ?? '') + event.thinking }
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

    if (event.type === 'tool.update') {
      setMessages((current) =>
        current.map((message) =>
          message.id === event.id && message.kind === 'tool'
            ? {
                ...message,
                ...(event.title ? { title: event.title } : {}),
                ...(event.detail ? { detail: event.detail } : {}),
                ...(event.summary ? { summary: event.summary } : {})
              }
            : message
        )
      )
      return
    }

    if (event.type === 'permission.request') {
      setPermissionRequest(event.request)
      return
    }

    if (event.type === 'permission.cancel') {
      setPermissionRequest((current) => (current?.id === event.requestId ? null : current))
      return
    }

    if (event.type === 'askUser.request') {
      setAskUserRequest(event.request)
      return
    }

    if (event.type === 'askUser.cancel') {
      setAskUserRequest((current) => (current?.id === event.requestId ? null : current))
      return
    }

    if (event.type === 'plan.update') {
      setPlan(event.plan)
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

    setMessages((current) => [...current, { id: `user-${Date.now()}`, kind: 'user', text: prompt }])
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

    if (name === '/clear' || name === '/new') {
      abortControllerRef.current?.abort()
      if (!fullscreen) process.stdout.write('\u001B[2J\u001B[3J\u001B[H')
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
      openModelPicker()
      return true
    }
    if (name === '/agents') {
      openAgentPanel()
      return true
    }
    if (name === '/permissions') {
      appendSystem(
        `${permissionMode} permission mode is active. Native Worker approval requests appear here automatically.`
      )
      return true
    }
    if (name === '/tasks') {
      setShowTasks((current) => !current)
      return true
    }
    if (name === '/plan') {
      setPermissionMode('plan')
      runtime.configure?.({ permissionMode: 'plan' })
      showNotice('Plan mode enabled')
      return true
    }
    if (name === '/codegraph') {
      if (!runtime.getCodeGraphStatus) {
        appendSystem('CodeGraph status is unavailable in this runtime.', 'warning')
        return true
      }
      void runtime
        .getCodeGraphStatus()
        .then((status) => {
          const catalog = status.toolNames.length > 0 ? ` · ${status.toolNames.join(', ')}` : ''
          appendSystem(
            `${status.message} · ${status.indexed ? 'indexed' : 'not indexed'}${catalog}`,
            status.enabled ? (status.indexed ? 'success' : 'warning') : 'muted'
          )
        })
        .catch((error) =>
          appendSystem(error instanceof Error ? error.message : String(error), 'error')
        )
      return true
    }
    if (name === '/effort') {
      const requested = args[0]
      const requestedIndex = requested ? effortLevels.indexOf(requested) : -1
      setEffortIndex((current) =>
        requestedIndex >= 0 ? requestedIndex : (current + 1) % effortLevels.length
      )
      const nextIndex =
        requestedIndex >= 0 ? requestedIndex : (effortIndex + 1) % effortLevels.length
      runtime.configure?.({ effort: effortLevels[nextIndex] ?? 'high' })
      return true
    }
    if (name === '/status') {
      const modelStatus = modelSelection
        ? `${modelSelection.providerName} / ${modelSelection.modelName}`
        : 'No configured model'
      appendSystem(
        `${modelStatus} · ${effortLevels[effortIndex]} effort · ${permissionMode} permissions · ${tuiMode} renderer`,
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
    if (submission.trimStart().startsWith('/')) {
      if (handleCommand(submission)) return
      const commandName = submission.trim().split(/\s+/u)[0]?.toLowerCase()
      if (slashCommands.some((command) => command.name === commandName)) {
        appendSystem(
          `${commandName} is present in the UI parity registry but is not wired yet.`,
          'warning'
        )
        return
      }
    }
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
    appendSystem(
      `${labels[decision]} · ${request.tool}: ${request.title}`,
      decision === 'deny' ? 'warning' : 'success'
    )
    void runtime.respondToPermission?.(request.id, decision)
  }

  const handleAskUserSubmit = (
    payload: Parameters<NonNullable<AgentRuntime['respondToAskUser']>>[1]
  ): void => {
    const request = askUserRequest
    if (!request) return
    setAskUserRequest(null)
    appendSystem('Answers submitted to the Native Worker.', 'success')
    void runtime.respondToAskUser?.(request.id, payload)
  }

  const handleAskUserCancel = (): void => {
    setAskUserRequest(null)
    abortControllerRef.current?.abort()
    showNotice('AskUserQuestion cancelled · turn interrupted')
  }

  const handlePlanApprove = (mode: PlanApprovalMode): void => {
    const currentPlan = plan
    if (!currentPlan || !runtime.approvePlan || planActionPending) return
    setPlanActionPending(true)
    void runtime
      .approvePlan(currentPlan, mode)
      .then(() => {
        setPlan({ ...currentPlan, status: 'implementing', updatedAt: Date.now() })
        const nextMode: PermissionMode = mode === 'auto' ? 'auto' : mode
        setPermissionMode(nextMode)
        runtime.configure?.({ permissionMode: nextMode })
        appendSystem('Plan approved · starting implementation in the Native Worker.', 'success')
        void runPrompt('Implement the approved plan.')
      })
      .catch((error) =>
        appendSystem(error instanceof Error ? error.message : String(error), 'error')
      )
      .finally(() => setPlanActionPending(false))
  }

  const handlePlanRevise = (feedback: string): void => {
    const currentPlan = plan
    if (!currentPlan || !runtime.revisePlan || planActionPending) return
    setPlanActionPending(true)
    void runtime
      .revisePlan(currentPlan, feedback)
      .then(() => {
        setPlan({ ...currentPlan, status: 'drafting', content: undefined, updatedAt: Date.now() })
        setPermissionMode('plan')
        runtime.configure?.({ permissionMode: 'plan' })
        appendSystem('Plan revision requested · returning to planning.', 'muted')
        void runPrompt(feedback)
      })
      .catch((error) =>
        appendSystem(error instanceof Error ? error.message : String(error), 'error')
      )
      .finally(() => setPlanActionPending(false))
  }

  const cyclePermissionMode = (): void => {
    setPermissionMode((current) => {
      const index = permissionModes.indexOf(current)
      const next = permissionModes[(index + 1) % permissionModes.length] ?? 'manual'
      runtime.configure?.({ permissionMode: next })
      return next
    })
  }

  const planOverlay = Boolean(
    plan && (plan.status === 'drafting' || plan.status === 'awaiting_review')
  )
  const inputActive =
    !askUserRequest && !planOverlay && !permissionRequest && !modelPickerOpen && !agentPanelOpen
  const hasTranscript = messages.length > 0

  return (
    <>
      {!fullscreen && committedMessages.length > 0 ? (
        <Static items={committedMessages}>
          {(message) => (
            <Transcript
              key={message.id}
              messages={[message]}
              showDetails={showDetails}
              width={contentWidth}
            />
          )}
        </Static>
      ) : null}
      <Box
        flexDirection="column"
        height={fullscreen ? rows : undefined}
        justifyContent={fullscreen ? 'space-between' : 'flex-start'}
        width={contentWidth}
      >
        <Box flexDirection="column" flexGrow={fullscreen ? 1 : 0}>
          {agentPanelOpen ? null : !hasTranscript ? (
            <WelcomeCard
              cwd={cwd}
              model={modelSelection?.modelName ?? 'No model configured'}
              version={version}
              width={contentWidth}
            />
          ) : dynamicMessages.length > 0 ? (
            <Transcript messages={dynamicMessages} showDetails={showDetails} width={contentWidth} />
          ) : null}
        </Box>

        <Box flexDirection="column" flexShrink={0}>
          {showTasks &&
          !askUserRequest &&
          !planOverlay &&
          !permissionRequest &&
          !modelPickerOpen &&
          !agentPanelOpen ? (
            <TaskList tasks={tasks} width={contentWidth} />
          ) : null}

          {askUserRequest ? (
            <AskUserPrompt
              onCancel={handleAskUserCancel}
              onNotice={showNotice}
              onSubmit={handleAskUserSubmit}
              request={askUserRequest}
              width={contentWidth}
            />
          ) : planOverlay && plan ? (
            <PlanPanel
              isRunning={isRunning || planActionPending}
              maxVisibleLines={Math.max(5, Math.min(16, rows - 13))}
              onAbort={() => {
                abortControllerRef.current?.abort()
                showNotice('Interrupted')
              }}
              onApprove={handlePlanApprove}
              onNotice={showNotice}
              onRevise={handlePlanRevise}
              plan={plan}
              width={contentWidth}
            />
          ) : permissionRequest ? (
            <PermissionPrompt
              onDecision={handlePermissionDecision}
              request={permissionRequest}
              width={contentWidth}
            />
          ) : modelPickerOpen ? (
            <ModelPicker
              catalog={modelCatalog}
              current={modelSelection}
              maxVisible={Math.max(4, Math.min(12, rows - 11))}
              onCancel={() => setModelPickerOpen(false)}
              onSelect={(nextModel) => {
                try {
                  if (runtime.selectModel) {
                    runtime.selectModel(nextModel)
                  } else {
                    runtime.configure?.({
                      model: nextModel.modelId,
                      providerId: nextModel.providerId
                    })
                  }
                  setModelSelection(nextModel)
                  setModelPickerOpen(false)
                  showNotice(`Model switched to ${nextModel.providerName} / ${nextModel.modelName}`)
                } catch (error) {
                  appendSystem(
                    `Failed to persist model selection: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                    'error'
                  )
                }
              }}
              width={contentWidth}
            />
          ) : agentPanelOpen ? (
            <AgentPanel
              agents={agents}
              maxVisible={Math.max(3, Math.min(8, rows - 10))}
              onCancel={() => setAgentPanelOpen(false)}
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
              onOpenAgents={openAgentPanel}
              onOpenModel={openModelPicker}
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
            model={modelSelection?.modelName ?? 'No model'}
            mode={permissionMode}
            notice={notice}
            width={contentWidth}
          />
          {fullscreen ? <Text color={theme.dim}> </Text> : null}
        </Box>
      </Box>
    </>
  )
}
