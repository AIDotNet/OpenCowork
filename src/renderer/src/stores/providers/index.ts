export type { BuiltinProviderPreset } from './types'

import type { ReasoningEffortLevel } from '../../lib/api/types'
import { routinAiPlanPreset, routinAiPreset } from './routin-ai'
import { openaiPreset } from './openai'
import { anthropicPreset } from './anthropic'
import { longcatPreset } from './longcat'
import { googlePreset } from './google'
import { deepseekPreset } from './deepseek'
import { openrouterPreset } from './openrouter'
import { opencodeGoPreset } from './opencode-go'
import { ollamaPreset } from './ollama'
import { azureOpenaiPreset } from './azure-openai'
import { moonshotCodingPreset, moonshotPreset } from './moonshot'
import { qwenCodingPreset, qwenPreset } from './qwen'
import { minimaxCodingPreset, minimaxPreset } from './minimax'
import { baiduCodingPreset, baiduPreset } from './baidu'
import { siliconflowPreset } from './siliconflow'
import { giteeAiPreset } from './gitee-ai'
import { codexOAuthPreset } from './codex-oauth'
import { copilotOAuthPreset } from './copilot-oauth'
import { xiaomiCodingPreset, xiaomiPreset } from './xiaomi'
import { bigmodelCodingPreset, bigmodelPreset } from './bigmodel'
import { volcenginePreset } from './volcengine'
import { xaiPreset } from './x-ai'
import type { BuiltinProviderPreset } from './types'

// Server-tool capabilities are per-model opt-ins that default to false: speaking the
// anthropic/openai-responses protocol is not enough, since relay/aggregator endpoints
// usually don't implement the server-side tools. Only first-party presets listed here
// mark their chat models as supporting them; users can still flip support per model
// in provider settings. Explicit preset values are never overridden.
//
// - Built-in web search: Anthropic `web_search_20250305`, OpenAI Responses `web_search`
//   (official API + ChatGPT-backed Codex). Supported models default to enabled.
// - Responses `image_generation` tool: official OpenAI API only.
// - Responses WebSocket transport: no default here; presets that support it (e.g.
//   Routin AI gpt-5.4+) set `supportsWebsocket` explicitly on their model literals.
const BUILTIN_SEARCH_CAPABLE_PRESETS = new Set(['openai', 'anthropic', 'codex-oauth'])
const IMAGE_GENERATION_CAPABLE_PRESETS = new Set(['openai'])

function applyServerToolCapabilityDefaults(preset: BuiltinProviderPreset): BuiltinProviderPreset {
  let changed = false
  const defaultModels = preset.defaultModels.map((model) => {
    const requestType = model.type ?? preset.type
    if ((model.category ?? 'chat') !== 'chat') return model

    const next = { ...model }
    const searchCapable =
      BUILTIN_SEARCH_CAPABLE_PRESETS.has(preset.builtinId) &&
      (requestType === 'anthropic' || requestType === 'openai-responses')
    if (searchCapable && next.supportsBuiltinSearch === undefined) {
      next.supportsBuiltinSearch = true
      if (next.enableBuiltinSearch === undefined) next.enableBuiltinSearch = true
    }

    const imageGenerationCapable =
      IMAGE_GENERATION_CAPABLE_PRESETS.has(preset.builtinId) && requestType === 'openai-responses'
    if (imageGenerationCapable && next.supportsImageGeneration === undefined) {
      next.supportsImageGeneration = true
    }

    if (
      next.supportsBuiltinSearch === model.supportsBuiltinSearch &&
      next.enableBuiltinSearch === model.enableBuiltinSearch &&
      next.supportsImageGeneration === model.supportsImageGeneration
    ) {
      return model
    }
    changed = true
    return next
  })
  return changed ? { ...preset, defaultModels } : preset
}

// "Ultra" is a universal pseudo reasoning tier layered on top of every model that
// already exposes a reasoning-effort selector. Selecting it does NOT send a real
// "ultra" effort to any provider — the sidecar caps the actual effort at the model's
// highest real level (the entry right below "ultra") and the app only adds a
// multi-agent authorization block to the system prompt (see MULTI_AGENT_MODE_PROMPT).
// We append it here so the whole catalog offers it without editing each preset, and
// skip models that already list it (e.g. gpt-5.6 terra/sol).
const ULTRA_REASONING_LEVEL: ReasoningEffortLevel = 'ultra'

function applyUltraReasoningTierDefault(preset: BuiltinProviderPreset): BuiltinProviderPreset {
  let changed = false
  const defaultModels = preset.defaultModels.map((model) => {
    const levels = model.thinkingConfig?.reasoningEffortLevels
    if (!levels?.length || levels.includes(ULTRA_REASONING_LEVEL)) return model
    changed = true
    return {
      ...model,
      thinkingConfig: {
        ...model.thinkingConfig,
        bodyParams: model.thinkingConfig?.bodyParams ?? {},
        reasoningEffortLevels: [...levels, ULTRA_REASONING_LEVEL]
      }
    }
  })
  return changed ? { ...preset, defaultModels } : preset
}

export const builtinProviderPresets: BuiltinProviderPreset[] = [
  routinAiPreset,
  routinAiPlanPreset,
  openaiPreset,
  anthropicPreset,
  longcatPreset,
  googlePreset,
  deepseekPreset,
  openrouterPreset,
  opencodeGoPreset,
  ollamaPreset,
  azureOpenaiPreset,
  moonshotCodingPreset,
  moonshotPreset,
  qwenCodingPreset,
  qwenPreset,
  baiduCodingPreset,
  baiduPreset,
  minimaxCodingPreset,
  minimaxPreset,
  siliconflowPreset,
  giteeAiPreset,
  codexOAuthPreset,
  copilotOAuthPreset,
  xiaomiCodingPreset,
  xiaomiPreset,
  bigmodelCodingPreset,
  bigmodelPreset,
  volcenginePreset,
  xaiPreset
]
  .map(applyServerToolCapabilityDefaults)
  .map(applyUltraReasoningTierDefault)
