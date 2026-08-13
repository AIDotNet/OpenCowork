import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import {
  parseOpenCoworkImportUrl,
  type RoutinCredentialClassification
} from '../../shared/routin-credential'
import { readPersistedProviderStore, writePersistedProviderStore } from './ai-provider-store'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function defaultModelFor(classification: RoutinCredentialClassification): JsonRecord {
  if (classification.builtinId === 'routin-ai-plan') {
    return {
      id: 'gpt-5.5',
      name: 'GPT 5.5',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 128_000,
      supportsFunctionCall: true,
      supportsVision: true,
      supportsThinking: true
    }
  }
  return {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    enabled: true,
    contextLength: 1_000_000,
    maxOutputTokens: 384_000,
    supportsFunctionCall: true,
    supportsThinking: true,
    thinkingConfig: {
      bodyParams: { thinking: { type: 'enabled' } },
      disabledBodyParams: { thinking: { type: 'disabled' } },
      reasoningEffortLevels: ['low', 'high', 'max'],
      defaultReasoningEffort: 'high'
    }
  }
}

function broadcastProviderImported(payload: {
  builtinId: string
  providerId: string
  modelId: string
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('ai-provider:imported', payload)
  }
}

/**
 * Apply a Routin device-login deep link into the shared ~/.open-cowork/ai-provider store.
 * Returns null when the URL is not an OpenCowork import link.
 */
export function applyOpenCoworkImportUrl(rawUrl: string): {
  builtinId: string
  modelId: string
  providerId: string
  providerName: string
} | null {
  const parsed = parseOpenCoworkImportUrl(rawUrl)
  if (!parsed) return null

  const { apiKey, classification } = parsed
  const persisted = readPersistedProviderStore() ?? { state: {}, version: 0 }
  const state = isRecord(persisted.state) ? { ...persisted.state } : {}
  const providers = Array.isArray(state.providers)
    ? state.providers.filter(isRecord).map((provider) => ({ ...provider }))
    : []

  const existingIndex = providers.findIndex(
    (provider) => stringValue(provider.builtinId) === classification.builtinId
  )
  const model = defaultModelFor(classification)
  const modelId = stringValue(model.id)
  let providerId = ''

  if (existingIndex >= 0) {
    const existing = providers[existingIndex]
    providerId = stringValue(existing.id) || randomUUID()
    const models = Array.isArray(existing.models) ? existing.models.filter(isRecord) : []
    const hasModel = models.some((candidate) => stringValue(candidate.id) === modelId)
    providers[existingIndex] = {
      ...existing,
      id: providerId,
      name: stringValue(existing.name) || classification.name,
      type: stringValue(existing.type) || 'openai-chat',
      apiKey,
      baseUrl: classification.baseUrl,
      enabled: true,
      builtinId: classification.builtinId,
      requiresApiKey: true,
      authMode: 'apiKey',
      defaultModel: modelId,
      models: hasModel ? models : [...models, model]
    }
  } else {
    providerId = randomUUID()
    providers.push({
      id: providerId,
      name: classification.name,
      type: 'openai-chat',
      apiKey,
      baseUrl: classification.baseUrl,
      enabled: true,
      models: [model],
      builtinId: classification.builtinId,
      presetVersion: 0,
      createdAt: Date.now(),
      requiresApiKey: true,
      authMode: 'apiKey',
      defaultModel: modelId
    })
  }

  writePersistedProviderStore({
    state: {
      ...state,
      providers,
      activeProviderId: providerId,
      activeModelId: modelId
    },
    version: typeof persisted.version === 'number' ? persisted.version : 0
  })

  const result = {
    builtinId: classification.builtinId,
    modelId,
    providerId,
    providerName: classification.name
  }
  broadcastProviderImported(result)
  return result
}

export function findOpenCoworkImportUrl(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    if (candidate.startsWith('opencowork:')) return candidate
  }
  return null
}
