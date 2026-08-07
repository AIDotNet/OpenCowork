import type { BuiltinProviderPreset } from './types'

const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

const chatModels = [
  ['grok-4.5', 'Grok 4.5', 'grok', 'openai-chat'],
  ['glm-5.2', 'GLM-5.2', 'glm', 'openai-chat'],
  ['glm-5.1', 'GLM-5.1', 'glm', 'openai-chat'],
  ['kimi-k3', 'Kimi K3', 'kimi', 'openai-chat'],
  ['kimi-k2.7-code', 'Kimi K2.7 Code', 'kimi', 'openai-chat'],
  ['kimi-k2.6', 'Kimi K2.6', 'kimi', 'openai-chat'],
  ['mimo-v2.5', 'MiMo-V2.5', 'mimo', 'openai-chat'],
  ['mimo-v2.5-pro', 'MiMo-V2.5-Pro', 'mimo', 'openai-chat'],
  ['minimax-m3', 'MiniMax M3', 'minimax', 'anthropic'],
  ['minimax-m2.7', 'MiniMax M2.7', 'minimax', 'anthropic'],
  ['minimax-m2.5', 'MiniMax M2.5', 'minimax', 'anthropic'],
  ['qwen3.8-max', 'Qwen3.8 Max', 'qwen', 'anthropic'],
  ['qwen3.7-max', 'Qwen3.7 Max', 'qwen', 'anthropic'],
  ['qwen3.7-plus', 'Qwen3.7 Plus', 'qwen', 'anthropic'],
  ['qwen3.6-plus', 'Qwen3.6 Plus', 'qwen', 'anthropic'],
  ['hy3', 'Hy3', undefined, 'openai-chat'],
  ['deepseek-v4-pro', 'DeepSeek V4 Pro', 'deepseek', 'openai-chat'],
  ['deepseek-v4-flash', 'DeepSeek V4 Flash', 'deepseek', 'openai-chat'],
  ['gpt-5.6-luna', 'GPT 5.6 Luna', 'openai', 'openai-responses']
] as const

export const opencodeGoPreset: BuiltinProviderPreset = {
  builtinId: 'opencode-go',
  version: 2,
  name: 'OpenCode Go',
  type: 'openai-chat',
  defaultBaseUrl: OPENCODE_GO_BASE_URL,
  homepage: 'https://opencode.ai/docs/zh-cn/go/',
  apiKeyUrl: 'https://opencode.ai/auth',
  defaultModel: 'deepseek-v4-flash',
  defaultModels: chatModels.map(([id, name, icon, type]) => ({
    id,
    name,
    ...(icon ? { icon } : {}),
    enabled: true,
    type,
    supportsFunctionCall: true
  }))
}
