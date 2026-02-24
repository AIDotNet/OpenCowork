export type { BuiltinProviderPreset } from './types'

import { routinAiPreset } from './routin-ai'
import { openaiPreset } from './openai'
import { anthropicPreset } from './anthropic'
import { googlePreset } from './google'
import { deepseekPreset } from './deepseek'
import { openrouterPreset } from './openrouter'
import { ollamaPreset } from './ollama'
import { azureOpenaiPreset } from './azure-openai'
import { moonshotCodingPreset, moonshotPreset } from './moonshot'
import { qwenCodingPreset, qwenPreset } from './qwen'
import { minimaxCodingPreset, minimaxPreset } from './minimax'
import { baiduCodingPreset, baiduPreset } from './baidu'
import { siliconflowPreset } from './siliconflow'
import { giteeAiPreset } from './gitee-ai'
import { xiaomiPreset } from './xiaomi'
import { bigmodelCodingPreset, bigmodelPreset } from './bigmodel'
import type { BuiltinProviderPreset } from './types'

export const builtinProviderPresets: BuiltinProviderPreset[] = [
  routinAiPreset,
  openaiPreset,
  anthropicPreset,
  googlePreset,
  deepseekPreset,
  openrouterPreset,
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
  xiaomiPreset,
  bigmodelCodingPreset,
  bigmodelPreset,
]
