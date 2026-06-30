import type { BuiltinProviderPreset } from './types'

// 定价与上下文来源（xAI 官方文档在当前网络不可达，改用可访问源交叉核对）：
//   - grok-4.3 / grok-4.20 / grok-4.20-multi-agent：OpenRouter /api/v1/models + 模型页，
//     并经 litellm model_prices 的 xai/ 直连条目校验（grok-4.3 完全一致）。
//   - grok-build-0.1：OpenRouter /api/v1/models（litellm 暂未收录）。
// 四个模型官方均标注「无输出 token 上限」，故不设 maxOutputTokens，由用户的 maxTokens 设置决定。
// 推理：xAI 原生 API 通过顶层 reasoning_effort 控制推理强度。按 OpenRouter supported_parameters
// 标记，grok-4.3 与 grok-4.20-multi-agent 支持 reasoning（low/high 两档）；grok-4.20 与
// grok-build-0.1 标记为不支持，故不启用 thinkingConfig。
export const xaiPreset: BuiltinProviderPreset = {
  builtinId: 'xai',
  name: 'xAI',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.x.ai/v1',
  homepage: 'https://x.ai',
  apiKeyUrl: 'https://console.x.ai',
  defaultModel: 'grok-4.3',
  defaultModels: [
    {
      id: 'grok-4.3',
      name: 'Grok 4.3',
      icon: 'grok',
      enabled: true,
      contextLength: 1_000_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 2.5,
      cacheHitPrice: 0.2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['low', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'grok-4.20',
      name: 'Grok 4.20',
      icon: 'grok',
      enabled: true,
      contextLength: 2_000_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 2.5,
      cacheHitPrice: 0.2
    },
    {
      id: 'grok-4.20-multi-agent',
      name: 'Grok 4.20 Multi-Agent',
      icon: 'grok',
      enabled: true,
      contextLength: 2_000_000,
      supportsVision: true,
      // 多智能体变体不支持 tools/tool_choice 参数
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 2.5,
      cacheHitPrice: 0.2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['low', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'grok-build-0.1',
      name: 'Grok Build 0.1',
      icon: 'grok',
      enabled: true,
      contextLength: 256_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1,
      outputPrice: 2,
      cacheHitPrice: 0.2
    }
  ]
}
