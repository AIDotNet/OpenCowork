import type { BuiltinProviderPreset } from './types'

export const modelscopePreset: BuiltinProviderPreset = {
  builtinId: 'modelscope',
  version: 1,
  name: '魔搭 ModelScope',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api-inference.modelscope.cn/v1',
  homepage: 'https://modelscope.cn',
  apiKeyUrl: 'https://modelscope.cn/my/myaccesstoken',
  defaultModel: 'Qwen/Qwen3-235B-A22B',
  defaultModels: [
    {
      id: 'Qwen/Qwen3-235B-A22B',
      name: 'Qwen3 235B',
      icon: 'qwen',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'deepseek-ai/DeepSeek-V3.2',
      name: 'DeepSeek V3.2',
      icon: 'deepseek',
      enabled: true,
      contextLength: 164_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'ZhipuAI/GLM-4.5',
      name: 'GLM-4.5',
      icon: 'chatglm',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true
    }
  ]
}
