import { useSettingsStore } from '@renderer/stores/settings-store'
import { createProvider } from './provider'
import type { ProviderConfig, UnifiedMessage } from './types'

/**
 * Use the fast model to generate a short session title from the user's first message.
 * Runs in the background — does not block the main chat flow.
 * Returns a short title string (≤30 chars) or null on failure.
 */
export async function generateSessionTitle(userMessage: string): Promise<string | null> {
  const settings = useSettingsStore.getState()
  if (!settings.apiKey || !settings.fastModel) return null

  const config: ProviderConfig = {
    type: settings.provider,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl || undefined,
    model: settings.fastModel,
    maxTokens: 60,
    temperature: 0.3,
    systemPrompt:
      'You are a title generator. Given a user message, produce a concise title (max 30 characters) that summarizes the intent. Reply with ONLY the title, no quotes, no punctuation at the end, no explanation.',
  }

  const messages: UnifiedMessage[] = [
    {
      id: 'title-req',
      role: 'user',
      content: userMessage.slice(0, 500),
      createdAt: Date.now(),
    },
  ]

  try {
    const provider = createProvider(config)
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), 15000)

    let title = ''
    for await (const event of provider.sendMessage(messages, [], config, abortController.signal)) {
      if (event.type === 'text_delta' && event.text) {
        title += event.text
      }
    }
    clearTimeout(timeout)

    title = title.trim().replace(/^["']|["']$/g, '').trim()
    if (!title) return null
    if (title.length > 40) title = title.slice(0, 40) + '...'
    return title
  } catch {
    return null
  }
}
