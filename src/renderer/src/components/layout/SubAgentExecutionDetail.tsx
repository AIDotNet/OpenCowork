import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Bot } from 'lucide-react'
import { nanoid } from 'nanoid'
import { TranscriptMessageList } from '@renderer/components/chat/TranscriptMessageList'
import { InputArea } from '@renderer/components/chat/InputArea'
import { useAgentStore, type SubAgentState } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import type { ContentBlock, ToolResultContent, UnifiedMessage } from '@renderer/lib/api/types'
import {
  imageAttachmentToContentBlock,
  type ImageAttachment
} from '@renderer/lib/image-attachments'
import { cn } from '@renderer/lib/utils'
import { parseSubAgentMeta } from '@renderer/lib/agent/sub-agents/create-tool'
import { abortSubAgentRun, appendSubAgentUserMessage } from '@renderer/lib/agent/sub-agents/runner'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import {
  findSubAgentInSelection,
  selectSessionScopedAgentState
} from '@renderer/lib/agent/session-scoped-agent-state'

const EMPTY_SESSION_MESSAGES: UnifiedMessage[] = []

function extractToolResultText(content?: ToolResultContent): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter(
      (block): block is Extract<ToolResultContent[number], { type: 'text' }> =>
        block.type === 'text'
    )
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function getFallbackReportFromToolOutput(content?: ToolResultContent): string {
  const rawOutput = extractToolResultText(content)
  if (!rawOutput.trim()) return ''

  const { text } = parseSubAgentMeta(rawOutput)
  const payloadText = text.trim() || rawOutput.trim()
  const decoded = decodeStructuredToolResult(payloadText)

  if (decoded && !Array.isArray(decoded)) {
    if (typeof decoded.result === 'string' && decoded.result.trim()) {
      return decoded.result.trim()
    }
    if (typeof decoded.error === 'string' && decoded.error.trim()) {
      return decoded.error.trim()
    }
  }

  return payloadText
}

function getFallbackReportFromMessages(
  toolUseId: string | null | undefined,
  messages: UnifiedMessage[]
): string {
  if (!toolUseId) return ''

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (!Array.isArray(message.content)) continue

    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.content[blockIndex]
      if (block.type !== 'tool_result' || block.toolUseId !== toolUseId) continue

      const report = getFallbackReportFromToolOutput(block.content)
      if (report.trim()) return report.trim()
    }
  }

  return ''
}

function findToolUseInput(
  toolUseId: string | null | undefined,
  messages: UnifiedMessage[]
): Record<string, unknown> | null {
  if (!toolUseId) return null

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue

    const block = message.content.find(
      (item): item is Extract<ContentBlock, { type: 'tool_use' }> =>
        item.type === 'tool_use' && item.id === toolUseId
    )
    if (block) return block.input
  }

  return null
}

function getPromptText(input: Record<string, unknown> | null): string {
  if (!input) return ''
  return [input.prompt, input.query, input.task, input.target]
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
}

function buildFallbackTranscript({
  toolUseId,
  description,
  prompt,
  report
}: {
  toolUseId: string | null | undefined
  description: string
  prompt: string
  report: string
}): UnifiedMessage[] {
  const idBase = toolUseId || 'subagent-fallback'
  const now = Date.now()
  const messages: UnifiedMessage[] = []
  const taskText = [description.trim(), prompt.trim()].filter(Boolean).join('\n\n')

  if (taskText) {
    messages.push({
      id: `${idBase}:fallback-user`,
      role: 'user',
      content: taskText,
      createdAt: now - 1
    })
  }

  if (report.trim()) {
    messages.push({
      id: `${idBase}:fallback-assistant`,
      role: 'assistant',
      content: report.trim(),
      createdAt: now
    })
  }

  return messages
}

function buildUserMessageContent(
  text: string,
  images?: ImageAttachment[]
): UnifiedMessage['content'] {
  const trimmed = text.trim()
  const blocks: ContentBlock[] = []

  if (trimmed) {
    blocks.push({ type: 'text', text: trimmed })
  }
  for (const image of images ?? []) {
    blocks.push(imageAttachmentToContentBlock(image))
  }

  if (blocks.length === 1 && blocks[0]?.type === 'text') {
    return blocks[0].text
  }
  return blocks
}

function SubAgentConversationInput({
  agent,
  sessionId,
  workingFolder
}: {
  agent: SubAgentState
  sessionId: string | null
  workingFolder?: string
}): React.JSX.Element {
  const handleSend = React.useCallback(
    (text: string, images?: ImageAttachment[]): void => {
      const content = buildUserMessageContent(text, images)
      if (Array.isArray(content) && content.length === 0) return
      if (typeof content === 'string' && !content.trim()) return

      appendSubAgentUserMessage(agent.toolUseId, {
        id: nanoid(),
        role: 'user',
        content,
        createdAt: Date.now()
      })
    },
    [agent.toolUseId]
  )

  const handleStop = React.useCallback((): void => {
    abortSubAgentRun(agent.toolUseId)
  }, [agent.toolUseId])

  return (
    <InputArea
      sessionId={sessionId}
      onSend={handleSend}
      onStop={handleStop}
      isStreaming={agent.isRunning}
      workingFolder={workingFolder}
      hideWorkingFolderIndicator
      disabled={!agent.isRunning}
      draftKeyOverride={`subagent:${agent.toolUseId}`}
      suppressPendingQueue
      hideGoalSessionBar
      hideModeSwitch
    />
  )
}

export function SubAgentExecutionDetail({
  toolUseId,
  inlineText,
  sessionId,
  embedded = false
}: {
  toolUseId?: string | null
  inlineText?: string
  sessionId?: string | null
  embedded?: boolean
  onClose?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const resolvedSessionId = sessionId ?? activeSessionId
  const sessionMessages = useChatStore((s) =>
    resolvedSessionId ? s.getSessionMessages(resolvedSessionId) : EMPTY_SESSION_MESSAGES
  )
  const sessionContext = useChatStore(
    useShallow((s) => {
      const index = resolvedSessionId ? s.sessionsById[resolvedSessionId] : undefined
      const session = index !== undefined ? s.sessions[index] : undefined
      const project = session?.projectId
        ? s.projects.find((item) => item.id === session.projectId)
        : null
      return {
        workingFolder: session?.workingFolder ?? project?.workingFolder ?? undefined
      }
    })
  )
  const sessionAgentSelection = useAgentStore((s) =>
    selectSessionScopedAgentState(s, resolvedSessionId)
  )
  const executedToolCalls = useAgentStore((s) => s.executedToolCalls)

  const agent = React.useMemo(
    () => findSubAgentInSelection(sessionAgentSelection, toolUseId),
    [sessionAgentSelection, toolUseId]
  )

  const fallbackReportText = React.useMemo(() => {
    const fromMessages = getFallbackReportFromMessages(toolUseId, sessionMessages)
    if (fromMessages) return fromMessages

    return toolUseId
      ? getFallbackReportFromToolOutput(
          executedToolCalls.find((item) => item.id === toolUseId)?.output
        )
      : ''
  }, [toolUseId, sessionMessages, executedToolCalls])

  const fallbackDetailText = (fallbackReportText.trim() || inlineText?.trim() || '').trim()
  const fallbackInput = React.useMemo(
    () => findToolUseInput(toolUseId, sessionMessages),
    [toolUseId, sessionMessages]
  )
  const fallbackDescription = fallbackInput?.description ? String(fallbackInput.description) : ''
  const fallbackPrompt = getPromptText(fallbackInput)
  const fallbackTranscript = React.useMemo(
    () =>
      buildFallbackTranscript({
        toolUseId,
        description: fallbackDescription,
        prompt: fallbackPrompt,
        report: fallbackDetailText
      }),
    [toolUseId, fallbackDescription, fallbackPrompt, fallbackDetailText]
  )

  const transcript = agent?.transcript ?? fallbackTranscript
  const streamingMessageId = agent?.currentAssistantMessageId ?? null

  if (!agent && transcript.length === 0) {
    return (
      <div
        className={cn(
          'flex h-full min-h-0 flex-col items-center justify-center px-6 text-center',
          embedded ? 'bg-transparent' : 'bg-background'
        )}
      >
        <Bot className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          {t('detailPanel.noSubAgentRecords', { defaultValue: 'No sub-agent records' })}
        </p>
      </div>
    )
  }

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col', embedded ? 'bg-transparent' : 'bg-background')}
    >
      <TranscriptMessageList
        messages={transcript}
        streamingMessageId={streamingMessageId}
        className="h-full min-h-0 flex-1"
      />
      {agent ? (
        <SubAgentConversationInput
          agent={agent}
          sessionId={resolvedSessionId}
          workingFolder={sessionContext.workingFolder}
        />
      ) : null}
    </div>
  )
}
