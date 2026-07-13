import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Bot } from 'lucide-react'
import { RuntimeTokenStatistics } from '@renderer/components/chat/InputArea'
import { TranscriptMessageList } from '@renderer/components/chat/TranscriptMessageList'
import { buildRenderableMessageMeta } from '@renderer/components/chat/transcript-utils'
import { useAgentStore, type SubAgentState } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import type {
  ContentBlock,
  MessageRequestModelMeta,
  ToolResultContent,
  UnifiedMessage
} from '@renderer/lib/api/types'
import { cn } from '@renderer/lib/utils'
import { parseSubAgentMeta } from '@renderer/lib/agent/sub-agents/create-tool'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import {
  findSubAgentInSelection,
  selectSessionScopedAgentState
} from '@renderer/lib/agent/session-scoped-agent-state'
import type { ToolCallState } from '@renderer/lib/agent/types'

const EMPTY_SESSION_MESSAGES: UnifiedMessage[] = []

function buildSubAgentDetailSignature(agent: SubAgentState | null): string {
  if (!agent) return 'empty'
  const currentAssistant = agent.currentAssistantMessageId
    ? agent.transcript.find((message) => message.id === agent.currentAssistantMessageId)
    : null
  const lastMessage = agent.transcript[agent.transcript.length - 1]
  return [
    agent.toolUseId,
    agent.sessionId ?? '',
    agent.isRunning ? '1' : '0',
    agent.endReason ?? '',
    String(agent.iteration),
    String(agent.toolCalls.length),
    String(agent.transcript.length),
    agent.currentAssistantMessageId ?? '',
    agent.requestModel?.providerId ?? '',
    agent.requestModel?.providerBuiltinId ?? '',
    agent.requestModel?.modelId ?? '',
    agent.requestModel?.modelName ?? '',
    agent.requestModel?.modelIcon ?? '',
    agent.mcpServerIds?.join(',') ?? '',
    agent.permissionMode ?? '',
    String(currentAssistant?._revision ?? ''),
    lastMessage?.id ?? '',
    String(lastMessage?._revision ?? ''),
    agent.toolCalls
      .map(
        (toolCall) =>
          `${toolCall.id}:${toolCall.name}:${toolCall.status}:${toolCall.completedAt ?? ''}:${
            toolCall.error ?? ''
          }:${getToolResultLength(toolCall.output)}`
      )
      .join('|'),
    String(agent.completedAt ?? ''),
    agent.reportStatus ?? '',
    agent.report
  ].join('::')
}

function getToolResultLength(content?: ToolResultContent): number {
  if (!content) return 0
  if (typeof content === 'string') return content.length
  return content.reduce((total, block) => {
    if (block.type === 'text') return total + block.text.length
    return total + (block.source.data?.length ?? block.source.url?.length ?? 0)
  }, 0)
}

function buildLiveToolCallMap(toolCalls: ToolCallState[]): Map<string, ToolCallState> | null {
  if (toolCalls.length === 0) return null
  const map = new Map<string, ToolCallState>()
  for (const toolCall of toolCalls) {
    map.set(toolCall.id, toolCall)
  }
  return map
}

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

function getLatestTranscriptRequestModel(
  transcript: UnifiedMessage[]
): MessageRequestModelMeta | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const requestModel = transcript[index]?.meta?.requestModel
    if (requestModel) return requestModel
  }
  return null
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
  const agentDetail = useAgentStore(
    useShallow((s) => {
      const sessionAgentSelection = selectSessionScopedAgentState(s, resolvedSessionId)
      const scopedAgent = findSubAgentInSelection(sessionAgentSelection, toolUseId)
      const fallbackAgent =
        toolUseId && !scopedAgent
          ? (s.activeSubAgents[toolUseId] ??
            s.completedSubAgents[toolUseId] ??
            s.subAgentHistory.find((entry) => entry.toolUseId === toolUseId) ??
            null)
          : null
      const agent = scopedAgent ?? fallbackAgent
      return {
        agent,
        signature: scopedAgent
          ? sessionAgentSelection.signature
          : buildSubAgentDetailSignature(fallbackAgent)
      }
    })
  )
  // The message fallbacks are only consulted when there is no live agent
  // record; subscribing to the messages array while an agent streams would
  // re-render and rescan the whole session transcript on every delta flush.
  const hasLiveAgent = Boolean(agentDetail.agent)
  const sessionMessages = useChatStore((s) =>
    !hasLiveAgent && resolvedSessionId
      ? s.getSessionMessages(resolvedSessionId)
      : EMPTY_SESSION_MESSAGES
  )
  const executedToolCalls = useAgentStore((s) => s.executedToolCalls)
  const agent = agentDetail.agent
  const hasRenderableAgentTranscript = agent?.transcript.length
    ? buildRenderableMessageMeta(agent.transcript, agent.currentAssistantMessageId).length > 0
    : false

  const fallbackReportText = React.useMemo(() => {
    const fromAgent = agent?.errorMessage?.trim() || agent?.report.trim() || ''
    if (fromAgent) return fromAgent

    const fromMessages = getFallbackReportFromMessages(toolUseId, sessionMessages)
    if (fromMessages) return fromMessages

    return toolUseId
      ? getFallbackReportFromToolOutput(
          executedToolCalls.find((item) => item.id === toolUseId)?.output
        )
      : ''
  }, [agent?.errorMessage, agent?.report, toolUseId, sessionMessages, executedToolCalls])

  const fallbackDetailText = (fallbackReportText.trim() || inlineText?.trim() || '').trim()
  const fallbackInput = React.useMemo(
    () => findToolUseInput(toolUseId, sessionMessages),
    [toolUseId, sessionMessages]
  )
  const fallbackDescription =
    agent?.description.trim() ||
    (fallbackInput?.description ? String(fallbackInput.description) : '')
  const fallbackPrompt = agent?.prompt.trim() || getPromptText(fallbackInput)
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

  const usesAgentTranscript = Boolean(agent && hasRenderableAgentTranscript)
  const transcript = usesAgentTranscript && agent ? agent.transcript : fallbackTranscript
  const subAgentRequestModel = agent?.requestModel ?? getLatestTranscriptRequestModel(transcript)
  const streamingMessageId = usesAgentTranscript ? (agent?.currentAssistantMessageId ?? null) : null
  const transcriptRevisionKey = usesAgentTranscript
    ? agentDetail.signature
    : [
        'fallback',
        agentDetail.signature,
        ...fallbackTranscript.map((message) => `${message.id}:${message._revision ?? 0}`)
      ].join('|')
  const toolCalls = agent?.toolCalls
  const liveToolCallMap = React.useMemo(
    () => (toolCalls ? buildLiveToolCallMap(toolCalls) : null),
    [toolCalls]
  )
  if (transcript.length === 0) {
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
        revisionKey={transcriptRevisionKey}
        sessionId={resolvedSessionId}
        liveToolCallMap={liveToolCallMap}
        autoScrollToBottom={Boolean(agent?.isRunning)}
      />
      {resolvedSessionId ? (
        <div className="shrink-0 border-t border-border/60 bg-background/95 px-4 py-2 backdrop-blur-sm">
          <RuntimeTokenStatistics
            sessionId={resolvedSessionId}
            messages={transcript}
            streamingMessageId={streamingMessageId}
            usage={agent?.usage}
            requestModel={subAgentRequestModel}
            isStreaming={Boolean(agent?.isRunning)}
            className="overflow-x-auto [scrollbar-width:none]"
          />
        </div>
      ) : null}
    </div>
  )
}
