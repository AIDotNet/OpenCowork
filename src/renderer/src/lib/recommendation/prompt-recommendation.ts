import { nanoid } from 'nanoid'
import {
  getProjectMemoryCandidatePaths,
  resolveTextFileWithFallbackPaths
} from '@renderer/lib/agent/memory-files'
import {
  imageAttachmentToContentBlock,
  type ImageAttachment
} from '@renderer/lib/image-attachments'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { createProvider } from '@renderer/lib/api/provider'
import type { ContentBlock, ProviderConfig, UnifiedMessage } from '@renderer/lib/api/types'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { modelSupportsVision, useProviderStore } from '@renderer/stores/provider-store'
import type { AppMode } from '@renderer/stores/ui-store'

const RECOMMENDATION_TIMEOUT_MS = 15000
const RECENT_CONVERSATION_LIMIT = 4
const MAX_RECOMMENDATION_LENGTH = 200

export type PromptRecommendationStatus = 'success' | 'disabled' | 'empty' | 'error'

export interface PromptRecommendationContext {
  mode: AppMode
  draftText: string
  recentMessages: UnifiedMessage[]
  selectedSkill: string | null
  images: ImageAttachment[]
  fallbackLanguage: 'zh' | 'en'
  sessionId?: string | null
}

export interface PromptRecommendationResponse {
  status: PromptRecommendationStatus
  text?: string
}

interface ResolvedRecommendationConfig {
  config: ProviderConfig
  supportsVision: boolean
}

function flattenContentText(content: UnifiedMessage['content']): string {
  if (typeof content === 'string') {
    return content.trim()
  }

  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function clipText(value: string, maxLength = 1200): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, maxLength)}…`
}

function collectRecentConversation(
  messages: UnifiedMessage[]
): Array<{ role: 'user' | 'assistant'; text: string }> {
  return messages
    .filter(
      (message): message is UnifiedMessage & { role: 'user' | 'assistant' } =>
        message.role === 'user' || message.role === 'assistant'
    )
    .map((message) => ({
      role: message.role,
      text: clipText(flattenContentText(message.content))
    }))
    .filter((message) => message.text)
    .slice(-RECENT_CONVERSATION_LIMIT)
}

function stripThinkBlocks(value: string): string {
  return value.replace(/<\s*think\b[^>]*>[\s\S]*?(?:<\s*\/\s*think\s*>|$)/gi, '')
}

function sanitizeRecommendationText(value: string): string {
  const cleaned = stripThinkBlocks(value)
    .replace(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()

  if (!cleaned) return ''
  return cleaned.length > MAX_RECOMMENDATION_LENGTH
    ? `${cleaned.slice(0, MAX_RECOMMENDATION_LENGTH)}…`
    : cleaned
}

function resolveRecommendationConfig(mode: AppMode): ResolvedRecommendationConfig | null {
  const { promptRecommendationModels } = useSettingsStore.getState()
  const binding = promptRecommendationModels[mode]
  const providerStore = useProviderStore.getState()

  if (binding === 'disabled') return null

  if (!binding) {
    const config = providerStore.getFastProviderConfig()
    if (!config) return null
    if (config.requiresApiKey !== false && !config.apiKey) return null

    const provider = providerStore.providers.find((item) => item.id === config.providerId)
    const model = provider?.models.find((item) => item.id === config.model)

    return {
      config,
      supportsVision: !!(provider && model && modelSupportsVision(model, provider.type))
    }
  }

  const provider = providerStore.providers.find((item) => item.id === binding.providerId)
  if (!provider || !provider.enabled) return null

  const model = provider.models.find((item) => item.id === binding.modelId)
  if (!model || !model.enabled) return null

  const config = providerStore.getProviderConfigById(binding.providerId, binding.modelId)
  if (!config) return null
  if (config.requiresApiKey !== false && !config.apiKey) return null

  return {
    config,
    supportsVision: modelSupportsVision(model, provider.type)
  }
}

function buildSystemPrompt(language: 'zh' | 'en', hasDraft: boolean): string {
  const fallbackLanguage = language === 'zh' ? '中文' : 'English'
  return [
    'You generate exactly one recommended user question for an input composer.',
    'Return plain text only.',
    'Do not output markdown, numbering, bullets, explanations, JSON, quotes, or code fences.',
    `Keep the response within ${MAX_RECOMMENDATION_LENGTH} characters.`,
    hasDraft
      ? 'If a current draft exists, your suggestion MUST start with the draft text exactly as-is, character for character.'
      : 'If the draft is empty, produce a complete high-quality next question.',
    `Use the same language as the current draft when it exists. Otherwise use ${fallbackLanguage}.`,
    'Respect the current mode: chat = general follow-up, clarify = ask sharper requirement questions, cowork = propose next collaborative action, code = propose next implementation/debugging question.',
    'If a skill is selected, align the suggestion with that skill.',
    'If images are attached and visible to you, incorporate them into the suggestion naturally.',
    'Output exactly one suggestion and nothing else.'
  ].join('\n')
}

function buildUserPrompt(context: PromptRecommendationContext, agentsContent?: string): string {
  const recentConversation = collectRecentConversation(context.recentMessages)
  const recentConversationText = recentConversation.length
    ? recentConversation
        .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
        .join('\n\n')
    : '[No recent conversation]'

  const agentsText = agentsContent?.trim() ? agentsContent.trim() : '[No AGENTS.md available]'
  const selectedSkillText = context.selectedSkill?.trim() || '[None]'
  const draftText = context.draftText.length > 0 ? context.draftText : '[Empty input]'
  const imageText =
    context.images.length > 0
      ? `${context.images.length} attached image(s) should be considered when available.`
      : '[No images attached]'

  return [
    `Mode: ${context.mode}`,
    `Selected skill: ${selectedSkillText}`,
    `Current draft:\n${draftText}`,
    `Recent conversation (latest last):\n${recentConversationText}`,
    `Project memory (AGENTS.md):\n${agentsText}`,
    `Image context: ${imageText}`,
    'Task: Return the single best next user question for this input box.'
  ].join('\n\n')
}

function buildRequestContent(
  promptText: string,
  images: ImageAttachment[],
  supportsVision: boolean
): string | ContentBlock[] {
  if (!supportsVision || images.length === 0) {
    return promptText
  }

  return [{ type: 'text', text: promptText }, ...images.map(imageAttachmentToContentBlock)]
}

async function loadAgentsFile(): Promise<string | undefined> {
  const { activeSessionId, sessions, projects } = useChatStore.getState()
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const activeProject = projects.find((project) => project.id === activeSession?.projectId)
  const workingFolder = activeSession?.workingFolder ?? activeProject?.workingFolder
  const sshConnectionId = activeSession?.sshConnectionId ?? activeProject?.sshConnectionId

  if (!workingFolder?.trim() || sshConnectionId) {
    return undefined
  }

  const { preferredPath, fallbackPath } = getProjectMemoryCandidatePaths(workingFolder, 'AGENTS.md')
  const resolved = await resolveTextFileWithFallbackPaths({
    readFile: async (path) => {
      try {
        const result = await ipcClient.invoke('fs:read-file', { path })
        if (typeof result === 'string') {
          return { content: result }
        }
        return {
          error:
            result && typeof result === 'object' && 'error' in result
              ? String((result as { error?: unknown }).error ?? 'Failed to read file')
              : 'Failed to read file'
        }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error)
        }
      }
    },
    preferredPath,
    fallbackPath
  })

  return resolved.error || resolved.missingFile || !resolved.content?.trim()
    ? undefined
    : resolved.content
}

export async function requestPromptRecommendation(
  context: PromptRecommendationContext,
  signal?: AbortSignal
): Promise<PromptRecommendationResponse> {
  const resolved = resolveRecommendationConfig(context.mode)
  if (!resolved) {
    return { status: 'disabled' }
  }

  const { config, supportsVision } = resolved
  const agentsContent = await loadAgentsFile()
  const promptText = buildUserPrompt(context, agentsContent)
  const requestContent = buildRequestContent(promptText, context.images, supportsVision)

  const requestMessages: UnifiedMessage[] = [
    {
      id: nanoid(),
      role: 'user',
      content: requestContent,
      createdAt: Date.now()
    }
  ]

  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort)
  const timeout = window.setTimeout(() => controller.abort(), RECOMMENDATION_TIMEOUT_MS)

  try {
    const provider = createProvider({
      ...config,
      maxTokens: 256,
      temperature: 0.2,
      systemPrompt: buildSystemPrompt(context.fallbackLanguage, context.draftText.length > 0),
      sessionId: context.sessionId ?? undefined
    })

    let accumulated = ''
    for await (const event of provider.sendMessage(
      requestMessages,
      [],
      {
        ...config,
        maxTokens: 256,
        temperature: 0.2,
        systemPrompt: buildSystemPrompt(context.fallbackLanguage, context.draftText.length > 0),
        sessionId: context.sessionId ?? undefined
      },
      controller.signal
    )) {
      if (event.type === 'text_delta' && event.text) {
        accumulated += event.text
      }
    }

    const text = sanitizeRecommendationText(accumulated)
    if (!text) {
      return { status: 'empty' }
    }

    return { status: 'success', text }
  } catch (error) {
    if (controller.signal.aborted || signal?.aborted) {
      return { status: 'error' }
    }
    console.warn('[PromptRecommendation] request failed', error)
    return { status: 'error' }
  } finally {
    window.clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

export function getRecentConversationFingerprint(messages: UnifiedMessage[]): string {
  return collectRecentConversation(messages)
    .map((message) => `${message.role}:${message.text}`)
    .join('\n---\n')
}
