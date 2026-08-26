import { t } from '../i18n.js'
import { appendAssistantSegment, finalizeAssistantSegments } from '../lib/assistant-content.js'
import { mergeSubAgentDisplay } from '../lib/sub-agent-display.js'
import type {
  AskUserRequest,
  Message,
  PermissionRequest,
  PlanSnapshot,
  TaskItem,
  TurnStatusSnapshot,
  UiEvent
} from '../types.js'
import type { CliState } from './cli-state.js'

type StateUpdate<T> = T | ((current: T) => T)

export type CliAction =
  | { type: 'runtime'; event: UiEvent }
  | { type: 'message/append'; message: Message }
  | { type: 'message/update-list'; update(next: Message[]): Message[] }
  | { type: 'message/replace'; messages: StateUpdate<Message[]> }
  | {
      type: 'message/update'
      id: string
      kind: Message['kind']
      update(message: Message): Message
    }
  | { type: 'tasks/replace'; tasks: StateUpdate<TaskItem[]>; show?: boolean }
  | { type: 'tasks/visibility'; visible: StateUpdate<boolean> }
  | { type: 'plan/replace'; plan: StateUpdate<PlanSnapshot | null> }
  | { type: 'permission/replace'; request: StateUpdate<PermissionRequest | null> }
  | { type: 'ask-user/replace'; request: StateUpdate<AskUserRequest | null> }
  | { type: 'activity/replace'; activity: StateUpdate<string | undefined> }
  | { type: 'running/replace'; value: StateUpdate<boolean> }
  | { type: 'turn-status/replace'; status: StateUpdate<TurnStatusSnapshot | null> }
  | { type: 'view/reset'; clearTasks: boolean }
  | { type: 'view/restore'; messages: Message[] }

let systemMessageSequence = 0

function nextSystemMessageId(): string {
  systemMessageSequence += 1
  return `system-${Date.now()}-${systemMessageSequence}`
}

function updateMessageById(
  messages: Message[],
  id: string,
  kind: Message['kind'],
  update: (message: Message) => Message
): Message[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && message.id === id && message.kind === kind) {
      const next = messages.slice()
      next[index] = update(message)
      return next
    }
  }
  return messages
}

function appendSystem(
  state: CliState,
  text: string,
  tone: Extract<Message, { kind: 'system' }>['tone'] = 'muted'
): CliState {
  const previous = state.messages.at(-1)
  if (previous && previous.kind === 'system' && previous.text === text && previous.tone === tone) {
    return state
  }
  return {
    ...state,
    messages: [...state.messages, { id: nextSystemMessageId(), kind: 'system', text, tone }]
  }
}

function reducePlanUpdate(
  state: CliState,
  event: Extract<UiEvent, { type: 'plan.update' }>
): CliState {
  const previous = state.plan?.id === event.plan.id ? state.plan : null
  const plan: PlanSnapshot = {
    ...(previous ?? {}),
    ...event.plan,
    ...(event.plan.content === undefined && previous?.content !== undefined
      ? { content: previous.content }
      : {}),
    ...(event.action === 'exit' ? { status: 'awaiting_review' } : {})
  }
  return { ...state, plan }
}

function reduceRuntimeEvent(state: CliState, event: UiEvent): CliState {
  if (event.type === 'turn.done') {
    return { ...state, turnStatus: null }
  }

  if (event.type === 'runtime.activity') {
    return {
      ...state,
      activity:
        event.activity === 'compressing'
          ? t('cli.statuses.compressing', 'Compressing context…')
          : t('cli.statuses.working', 'Working…'),
      turnStatus:
        event.activity === 'working' && state.turnStatus
          ? { ...state.turnStatus, phase: 'requesting' }
          : state.turnStatus
    }
  }

  if (event.type === 'runtime.usage') {
    if (!state.turnStatus) return state
    const current = state.turnStatus
    const estimatedOutputTokens = Math.round(current.activeResponseCharacters / 4)
    const outputTokens =
      event.outputTokens !== undefined && event.outputTokens > 0
        ? event.outputTokens
        : estimatedOutputTokens
    const reportedRequestTokens = event.contextTokens ?? event.inputTokens
    return {
      ...state,
      turnStatus: {
        ...current,
        activeResponseCharacters: 0,
        activeResponseStartedAt: undefined,
        completedOutputTokens: current.completedOutputTokens + outputTokens,
        generationMs:
          current.generationMs +
          (current.activeResponseStartedAt !== undefined
            ? Math.max(0, Date.now() - current.activeResponseStartedAt)
            : 0),
        phase: current.phase === 'requesting' ? 'responding' : current.phase,
        requestTokens:
          reportedRequestTokens !== undefined && reportedRequestTokens > 0
            ? reportedRequestTokens
            : current.requestTokens
      }
    }
  }

  if (event.type === 'runtime.retry') {
    const delay =
      event.delayMs >= 1_000
        ? `${(event.delayMs / 1_000).toFixed(event.delayMs % 1_000 === 0 ? 0 : 1)}s`
        : `${event.delayMs}ms`
    return {
      ...state,
      activity: `${t('cli.runtime.retry', 'Retry')} ${event.attempt}/${event.maxAttempts}${event.statusCode ? ` · HTTP ${event.statusCode}` : ''} · ${t('cli.runtime.retryIn', 'in')} ${delay}${event.reason ? ` · ${event.reason}` : ''}`,
      turnStatus: state.turnStatus ? { ...state.turnStatus, phase: 'requesting' } : null
    }
  }

  if (event.type === 'context-compression.start') {
    return { ...state, activity: t('cli.statuses.compressing', 'Compressing context…') }
  }

  if (event.type === 'context-compression.delta') {
    const preview = event.text.replace(/\s+/g, ' ').trim()
    return preview
      ? {
          ...state,
          activity: `${t('cli.statuses.compressing', 'Compressing context…')} ${preview.slice(-48)}`
        }
      : state
  }

  if (event.type === 'context-compression.done') {
    return appendSystem(
      {
        ...state,
        activity: t('cli.statuses.working', 'Working…')
      },
      event.summarizerFailed
        ? event.error ||
            'Context compression failed; the Native Worker preserved the original history.'
        : `Context compressed · ${event.originalCount} → ${event.newCount} messages${event.messagesSummarized === undefined ? '' : ` · ${event.messagesSummarized} summarized`}`,
      event.summarizerFailed ? 'warning' : 'success'
    )
  }

  if (event.type === 'assistant.start') {
    return {
      ...state,
      activity: t('cli.statuses.working', 'Working…'),
      messages: [
        ...state.messages,
        {
          id: event.id,
          kind: 'assistant',
          model: event.model,
          segments: [],
          streaming: true,
          text: '',
          timestamp: new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }).format(new Date())
        }
      ],
      turnStatus: state.turnStatus ? { ...state.turnStatus, phase: 'responding' } : null
    }
  }

  if (event.type === 'assistant.delta') {
    const timestamp = Date.now()
    return {
      ...state,
      turnStatus: state.turnStatus
        ? {
            ...state.turnStatus,
            activeResponseCharacters: state.turnStatus.activeResponseCharacters + event.text.length,
            activeResponseStartedAt: state.turnStatus.activeResponseStartedAt ?? timestamp,
            firstResponseAt: state.turnStatus.firstResponseAt ?? timestamp,
            phase: 'responding'
          }
        : null,
      messages: updateMessageById(state.messages, event.id, 'assistant', (message) => {
        if (message.kind !== 'assistant') return message
        return {
          ...message,
          segments: appendAssistantSegment(message.segments, 'text', event.text, timestamp),
          text: message.text + event.text
        }
      })
    }
  }

  if (event.type === 'assistant.thinking') {
    const timestamp = Date.now()
    return {
      ...state,
      turnStatus: state.turnStatus
        ? {
            ...state.turnStatus,
            activeResponseCharacters:
              state.turnStatus.activeResponseCharacters + event.thinking.length,
            activeResponseStartedAt: state.turnStatus.activeResponseStartedAt ?? timestamp,
            firstResponseAt: state.turnStatus.firstResponseAt ?? timestamp,
            phase: 'thinking'
          }
        : null,
      messages: updateMessageById(state.messages, event.id, 'assistant', (message) => {
        if (message.kind !== 'assistant') return message
        return {
          ...message,
          segments: appendAssistantSegment(message.segments, 'thinking', event.thinking, timestamp)
        }
      })
    }
  }

  if (event.type === 'assistant.image') {
    return updateStateMessage(state, event.id, 'assistant', (message) => {
      if (message.kind !== 'assistant') return message
      return {
        ...message,
        segments: [...(message.segments ?? []), { kind: 'image', image: event.image }]
      }
    })
  }

  if (event.type === 'assistant.done') {
    const timestamp = Date.now()
    let next = state
    if (!event.preserveResponseCharacters && state.turnStatus) {
      const current = state.turnStatus
      if (current.activeResponseCharacters > 0 || current.activeResponseStartedAt !== undefined) {
        next = {
          ...next,
          turnStatus: {
            ...current,
            activeResponseCharacters: 0,
            activeResponseStartedAt: undefined,
            completedOutputTokens:
              current.completedOutputTokens + Math.round(current.activeResponseCharacters / 4),
            generationMs:
              current.generationMs +
              (current.activeResponseStartedAt !== undefined
                ? Math.max(0, timestamp - current.activeResponseStartedAt)
                : 0)
          }
        }
      }
    }
    return updateStateMessage(next, event.id, 'assistant', (message) => {
      if (message.kind !== 'assistant') return message
      return {
        ...message,
        ...(event.reasoningTokens === undefined ? {} : { reasoningTokens: event.reasoningTokens }),
        segments: finalizeAssistantSegments(
          message.segments,
          event.reasoningTokens ?? message.reasoningTokens,
          timestamp
        ),
        streaming: false
      }
    })
  }

  if (event.type === 'tool.start') {
    return {
      ...state,
      activity: t('cli.statuses.working', 'Working…'),
      messages: [
        ...state.messages,
        {
          id: event.id,
          kind: 'tool',
          title: event.title,
          detail: event.detail,
          status: 'running',
          ...(event.subAgent ? { subAgent: event.subAgent } : {})
        }
      ],
      turnStatus: state.turnStatus ? { ...state.turnStatus, phase: 'tool-use' } : null
    }
  }

  if (event.type === 'tool.done') {
    return updateStateMessage(state, event.id, 'tool', (message) => {
      if (message.kind !== 'tool') return message
      return {
        ...message,
        status: event.status,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
        ...(event.title ? { title: event.title } : {}),
        ...(event.diff ? { diff: event.diff } : {}),
        ...(event.subAgent
          ? { subAgent: mergeSubAgentDisplay(message.subAgent, event.subAgent) }
          : {})
      }
    })
  }

  if (event.type === 'tool.update') {
    return updateStateMessage(state, event.id, 'tool', (message) => {
      if (message.kind !== 'tool') return message
      return {
        ...message,
        ...(event.title ? { title: event.title } : {}),
        ...(event.detail ? { detail: event.detail } : {}),
        ...(event.summary ? { summary: event.summary } : {}),
        ...(event.subAgent
          ? { subAgent: mergeSubAgentDisplay(message.subAgent, event.subAgent) }
          : {})
      }
    })
  }

  if (event.type === 'permission.request') return { ...state, permissionRequest: event.request }
  if (event.type === 'permission.cancel') {
    return state.permissionRequest?.id === event.requestId
      ? { ...state, permissionRequest: null }
      : state
  }
  if (event.type === 'askUser.request') return { ...state, askUserRequest: event.request }
  if (event.type === 'askUser.cancel') {
    return state.askUserRequest?.id === event.requestId ? { ...state, askUserRequest: null } : state
  }
  if (event.type === 'plan.update') return reducePlanUpdate(state, event)
  if (event.type === 'tasks.update') {
    return { ...state, showTasks: event.tasks.length > 0, tasks: event.tasks }
  }
  if (event.type === 'system') {
    const previous = state.messages.at(-1)
    if (
      previous &&
      previous.kind === 'system' &&
      previous.text === event.message.text &&
      previous.tone === event.message.tone
    ) {
      return state
    }
    return { ...state, messages: [...state.messages, event.message] }
  }

  return state
}

function updateStateMessage(
  state: CliState,
  id: string,
  kind: Message['kind'],
  update: (message: Message) => Message
): CliState {
  return { ...state, messages: updateMessageById(state.messages, id, kind, update) }
}

export function reduceCliState(state: CliState, event: UiEvent): CliState {
  return cliReducer(state, { type: 'runtime', event })
}

export function cliReducer(state: CliState, action: CliAction): CliState {
  if (action.type === 'runtime') return reduceRuntimeEvent(state, action.event)
  if (action.type === 'message/append')
    return { ...state, messages: [...state.messages, action.message] }
  if (action.type === 'message/update-list')
    return { ...state, messages: action.update(state.messages) }
  if (action.type === 'message/replace') {
    return {
      ...state,
      messages:
        typeof action.messages === 'function' ? action.messages(state.messages) : action.messages
    }
  }
  if (action.type === 'message/update')
    return updateStateMessage(state, action.id, action.kind, action.update)
  if (action.type === 'tasks/replace') {
    return {
      ...state,
      tasks: typeof action.tasks === 'function' ? action.tasks(state.tasks) : action.tasks,
      showTasks: action.show ?? state.showTasks
    }
  }
  if (action.type === 'tasks/visibility') {
    return {
      ...state,
      showTasks: typeof action.visible === 'function' ? action.visible(state.showTasks) : action.visible
    }
  }
  if (action.type === 'plan/replace') {
    return {
      ...state,
      plan: typeof action.plan === 'function' ? action.plan(state.plan) : action.plan
    }
  }
  if (action.type === 'permission/replace') {
    return {
      ...state,
      permissionRequest:
        typeof action.request === 'function'
          ? action.request(state.permissionRequest)
          : action.request
    }
  }
  if (action.type === 'ask-user/replace') {
    return {
      ...state,
      askUserRequest:
        typeof action.request === 'function' ? action.request(state.askUserRequest) : action.request
    }
  }
  if (action.type === 'activity/replace') {
    return {
      ...state,
      activity:
        typeof action.activity === 'function' ? action.activity(state.activity) : action.activity
    }
  }
  if (action.type === 'running/replace') {
    return {
      ...state,
      isRunning: typeof action.value === 'function' ? action.value(state.isRunning) : action.value
    }
  }
  if (action.type === 'turn-status/replace') {
    return {
      ...state,
      turnStatus:
        typeof action.status === 'function' ? action.status(state.turnStatus) : action.status
    }
  }
  if (action.type === 'view/reset') {
    return {
      ...state,
      activity: undefined,
      askUserRequest: null,
      isRunning: false,
      messages: [],
      permissionRequest: null,
      plan: null,
      showTasks: action.clearTasks ? false : state.showTasks,
      tasks: action.clearTasks ? [] : state.tasks,
      turnStatus: null
    }
  }
  if (action.type === 'view/restore') {
    return {
      ...state,
      activity: undefined,
      askUserRequest: null,
      isRunning: false,
      messages: action.messages,
      permissionRequest: null,
      plan: null,
      showTasks: false,
      tasks: [],
      turnStatus: null
    }
  }
  return state
}
