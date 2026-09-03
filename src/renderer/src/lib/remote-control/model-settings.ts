import i18n from '@renderer/locales'
import {
  useProviderStore,
  modelSupportsBuiltinSearch,
  modelSupportsGptLongContext,
  modelSupportsResponsesWebsocket,
  modelSupportsResponsesImageGeneration,
  isGptLongContextEnabled,
  resolveModelThinkingConfig,
  supportsPriorityServiceTier,
  readAnthropicThinkingBudget,
  clampThinkingBudget,
  buildAnthropicThinkingConfigWithBudget,
  MIN_ANTHROPIC_THINKING_BUDGET,
  DEFAULT_ANTHROPIC_THINKING_BUDGET
} from '@renderer/stores/provider-store'
import {
  useSettingsStore,
  getReasoningEffortKey,
  resolveReasoningEffortForModel
} from '@renderer/stores/settings-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { isResponsesImageGenerationEnabled } from '@renderer/lib/api/responses-image-generation'
import { resolveSessionModelSelection } from '@renderer/lib/session-model-resolution'
import type { AIModelConfig, AIProvider, ReasoningEffortLevel } from '@renderer/lib/api/types'
import type {
  RemoteModelControl,
  RemoteModelSettingSection,
  RemoteModelSettingsResponse
} from '../../../../shared/remote-control'

/**
 * The composer's model-settings popover (`ModelSwitcher.tsx`), projected for the phone.
 *
 * The phone gets resolved controls, not raw fields: which knobs a model exposes and
 * what they are worth is decided here by the same helpers the popover uses, so the
 * two clients cannot drift and a new knob needs no phone release. Control ids are
 * the contract — they are matched in `applyModelSetting` and must not be renamed
 * without shipping both sides.
 */

const CONTROL_IDS = {
  thinkingEnabled: 'thinking.enabled',
  thinkingEffort: 'thinking.effort',
  thinkingBudget: 'thinking.budget',
  builtinSearch: 'model.builtinSearch',
  longContext: 'model.longContext',
  cacheTtl: 'model.cacheTtl',
  fastMode: 'capability.fastMode',
  websocket: 'capability.websocket',
  imageGeneration: 'capability.imageGeneration'
} as const

function t(key: string, ns: 'layout' | 'chat' | 'settings'): string {
  return i18n.t(key, { ns })
}

interface ResolvedSelection {
  provider: AIProvider
  model: AIModelConfig
}

/** The provider/model this request is about — the session's binding, else the global one. */
function resolveSelection(sessionId: string): ResolvedSelection | null {
  const providerStore = useProviderStore.getState()
  const chat = useChatStore.getState()
  const selection = resolveSessionModelSelection({
    session: sessionId ? chat.sessions.find((item) => item.id === sessionId) : null,
    providers: providerStore.providers,
    activeProviderId: providerStore.activeProviderId,
    activeModelId: providerStore.activeModelId
  })
  const provider = providerStore.providers.find((item) => item.id === selection.providerId)
  const model = provider?.models.find((item) => item.id === selection.modelId)
  return provider && model ? { provider, model } : null
}

function thinkingSection({ provider, model }: ResolvedSelection): RemoteModelSettingSection | null {
  if (!model.supportsThinking) return null
  const settings = useSettingsStore.getState()
  const thinkingConfig = resolveModelThinkingConfig(model, provider.builtinId)
  const levels = thinkingConfig?.reasoningEffortLevels
  const controls: RemoteModelControl[] = [
    {
      id: CONTROL_IDS.thinkingEnabled,
      kind: 'toggle',
      label: t('topbar.deepThinking', 'layout'),
      value: settings.thinkingEnabled
    }
  ]

  if (levels && levels.length > 0) {
    controls.push({
      id: CONTROL_IDS.thinkingEffort,
      kind: 'choice',
      label: t('topbar.reasoningEffort', 'layout'),
      // The desktop labels the slider's two ends rather than each stop; the phone
      // renders discrete segments, so the ends become the hint.
      description: `${t('topbar.faster', 'layout')} → ${t('topbar.smarter', 'layout')}`,
      value: resolveReasoningEffortForModel({
        reasoningEffort: settings.reasoningEffort,
        reasoningEffortByModel: settings.reasoningEffortByModel,
        providerId: provider.id,
        modelId: model.id,
        thinkingConfig
      }),
      options: levels.map((level) => ({ value: level, label: String(level).toUpperCase() }))
    })
  }

  if ((model.type ?? provider.type) === 'anthropic' && model.thinkingConfig) {
    const budget = clampThinkingBudget(
      readAnthropicThinkingBudget(model) ?? DEFAULT_ANTHROPIC_THINKING_BUDGET,
      model.maxOutputTokens
    )
    controls.push({
      id: CONTROL_IDS.thinkingBudget,
      kind: 'slider',
      label: t('provider.thinkingBudget', 'settings'),
      description: 'budget_tokens',
      value: budget,
      min: MIN_ANTHROPIC_THINKING_BUDGET,
      max: Math.max(
        MIN_ANTHROPIC_THINKING_BUDGET,
        Math.floor((model.maxOutputTokens ?? 64_000) - 1)
      ),
      step: 1,
      valueLabel: budget.toLocaleString()
    })
  }

  return { id: 'thinking', title: t('topbar.deepThinking', 'layout'), controls }
}

function modelConfigSection({
  provider,
  model
}: ResolvedSelection): RemoteModelSettingSection | null {
  const controls: RemoteModelControl[] = []

  if (modelSupportsBuiltinSearch(model, provider.type)) {
    const enabled = model.enableBuiltinSearch === true
    controls.push({
      id: CONTROL_IDS.builtinSearch,
      kind: 'toggle',
      label: t('topbar.builtinSearch', 'layout'),
      description: t(enabled ? 'topbar.builtinSearchOn' : 'topbar.builtinSearchOff', 'layout'),
      value: enabled
    })
  }

  if (modelSupportsGptLongContext(model)) {
    const enabled = isGptLongContextEnabled(model)
    controls.push({
      id: CONTROL_IDS.longContext,
      kind: 'toggle',
      label: t('topbar.longContext', 'layout'),
      description: t(enabled ? 'topbar.longContextOn' : 'topbar.longContextOff', 'layout'),
      value: enabled
    })
  }

  if ((model.type ?? provider.type) === 'anthropic') {
    controls.push({
      id: CONTROL_IDS.cacheTtl,
      kind: 'choice',
      label: t('provider.cacheTtl', 'settings'),
      description: t('provider.cacheTtlHint', 'settings'),
      value: model.cacheTtl ?? '5m',
      options: [
        { value: '5m', label: '5m' },
        { value: '1h', label: '1h' }
      ]
    })
  }

  return controls.length > 0
    ? { id: 'modelConfig', title: t('provider.modelConfig', 'settings'), controls }
    : null
}

function capabilitySection({
  provider,
  model
}: ResolvedSelection): RemoteModelSettingSection | null {
  const controls: RemoteModelControl[] = []

  if (supportsPriorityServiceTier(model)) {
    controls.push({
      id: CONTROL_IDS.fastMode,
      kind: 'toggle',
      label: t('topbar.fastMode', 'layout'),
      description: t('provider.supportsFastModeDesc', 'settings'),
      value: useSettingsStore.getState().fastModeEnabled
    })
  }

  if (modelSupportsResponsesWebsocket(model, provider.type)) {
    controls.push({
      id: CONTROL_IDS.websocket,
      kind: 'toggle',
      label: t('topbar.websocketProtocol', 'layout'),
      description: t('provider.supportsWebsocketDesc', 'settings'),
      value: (model.websocketMode ?? provider.websocketMode ?? 'disabled') !== 'disabled'
    })
  }

  if (modelSupportsResponsesImageGeneration(model, provider.type)) {
    controls.push({
      id: CONTROL_IDS.imageGeneration,
      kind: 'toggle',
      label: t('topbar.imageGeneration', 'layout'),
      description: t('provider.supportsImageGenerationDesc', 'settings'),
      value: isResponsesImageGenerationEnabled(model.responsesImageGeneration)
    })
  }

  return controls.length > 0
    ? { id: 'capabilities', title: t('topbar.capabilities', 'layout'), controls }
    : null
}

export function buildModelSettings(sessionId: string): RemoteModelSettingsResponse {
  const selection = resolveSelection(sessionId)
  if (!selection) return { model: null, sections: [] }
  const { provider, model } = selection
  return {
    model: {
      providerId: provider.id,
      modelId: model.id,
      name: model.name || model.id,
      providerName: provider.name,
      requestType: model.type ?? provider.type
    },
    sections: [
      thinkingSection(selection),
      modelConfigSection(selection),
      capabilitySection(selection)
    ].filter((section): section is RemoteModelSettingSection => section !== null)
  }
}

function asBoolean(value: unknown): boolean {
  return value === true
}

function updateModel(
  { provider, model }: ResolvedSelection,
  patch: Parameters<ReturnType<typeof useProviderStore.getState>['updateModel']>[2]
): void {
  useProviderStore.getState().updateModel(provider.id, model.id, patch)
}

/**
 * Applies one control and answers with the whole recomputed panel: several knobs
 * pull others with them (a budget change switches thinking on), and re-reading is
 * how the phone learns that without knowing the rule.
 */
export function applyModelSetting(
  sessionId: string,
  controlId: string,
  value: boolean | string | number
): RemoteModelSettingsResponse {
  const selection = resolveSelection(sessionId)
  if (!selection) throw new Error('No model is selected')
  const { provider, model } = selection
  const settings = useSettingsStore.getState()

  switch (controlId) {
    case CONTROL_IDS.thinkingEnabled: {
      const thinkingConfig = resolveModelThinkingConfig(model, provider.builtinId)
      const enabled = asBoolean(value)
      // Turning it on pins the effort the desktop would have used, exactly as the
      // popover's toggle does — otherwise the next run silently falls back.
      settings.updateSettings(
        enabled && thinkingConfig?.reasoningEffortLevels
          ? {
              thinkingEnabled: true,
              reasoningEffort: resolveReasoningEffortForModel({
                reasoningEffort: settings.reasoningEffort,
                reasoningEffortByModel: settings.reasoningEffortByModel,
                providerId: provider.id,
                modelId: model.id,
                thinkingConfig
              })
            }
          : { thinkingEnabled: enabled }
      )
      break
    }
    case CONTROL_IDS.thinkingEffort: {
      const level = String(value) as ReasoningEffortLevel
      const effortKey = getReasoningEffortKey(provider.id, model.id)
      settings.updateSettings({
        reasoningEffort: level,
        reasoningEffortByModel: effortKey
          ? { ...settings.reasoningEffortByModel, [effortKey]: level }
          : settings.reasoningEffortByModel,
        thinkingEnabled: true
      })
      break
    }
    case CONTROL_IDS.thinkingBudget: {
      const budget = clampThinkingBudget(Number(value), model.maxOutputTokens)
      updateModel(selection, {
        supportsThinking: true,
        thinkingConfig: buildAnthropicThinkingConfigWithBudget(model.thinkingConfig, budget)
      })
      settings.updateSettings({ thinkingEnabled: true })
      break
    }
    case CONTROL_IDS.builtinSearch:
      updateModel(selection, { enableBuiltinSearch: asBoolean(value) })
      break
    case CONTROL_IDS.longContext:
      updateModel(selection, { enableLongContext: asBoolean(value) })
      break
    case CONTROL_IDS.cacheTtl: {
      const ttl = value === '1h' ? '1h' : '5m'
      updateModel(selection, { cacheTtl: ttl })
      break
    }
    case CONTROL_IDS.fastMode:
      settings.updateSettings({ fastModeEnabled: asBoolean(value) })
      break
    case CONTROL_IDS.websocket:
      updateModel(selection, { websocketMode: asBoolean(value) ? 'auto' : 'disabled' })
      break
    case CONTROL_IDS.imageGeneration:
      updateModel(selection, {
        responsesImageGeneration: {
          ...(model.responsesImageGeneration ?? {}),
          enabled: asBoolean(value)
        }
      })
      break
    default:
      throw new Error(`Unknown model setting: ${controlId}`)
  }

  return buildModelSettings(sessionId)
}
