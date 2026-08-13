import type { BuiltinProviderPreset } from './types'

// 定价与上下文来源（2026-07 复核，docs.x.ai/developers/models 已可直接访问）：
//   页面内嵌的模型注册表（ListModelsForTeamResponse）给出权威字段：
//   - grok-4.3、grok-4.20-0309-reasoning、grok-4.20-0309-non-reasoning、
//     grok-4.20-multi-agent-0309、grok-build-0.1 均为 maxPromptLength: 1,000,000（
//     grok-build-0.1 为 256,000），此前 grok-4.20 / grok-4.20-multi-agent 记录的
//     2,000,000 上下文有误，现已按注册表更正为 1,000,000。
//   - "Model Aliases" 一节确认 `<modelname>`（不带日期后缀）会自动别名到最新稳定版本，
//     故 grok-4.20 / grok-4.20-multi-agent 这两个裸 id 目前仍然有效、并未下线；
//     grok-4.20 的别名列表显式包含 grok-4.20-0309-reasoning，即裸 id 对应的是启用推理
//     的版本，因此为其补上 thinkingConfig；同时新增官方文档中独立存在的
//     grok-4.20-non-reasoning（非推理、低延迟变体）。
//   - 五个模型官方均标注「无输出 token 上限」，故不设 maxOutputTokens，由用户的 maxTokens
//     设置决定。
// 推理：xAI 原生 API 通过顶层 reasoning_effort 控制推理强度。grok-4.20-multi-agent 的产品文档
// （/developers/model-capabilities/text/multi-agent）明确说明该变体不支持 client-side
// function calling / custom tools（仅支持内置工具），故继续保留 supportsFunctionCall: false。
// grok / grok-4.6（2026-08-12 发布，docs.x.ai/developers/models/grok-4-6）：500K 上下文，
// $2/$6 每百万 token，缓存 $0.50；reasoning_effort 为 low/medium/high/xhigh（默认 high，不可关闭）。
// 裸 id `grok` 是最新旗舰别名，当前指向 grok-4.6。
// grok-4.5（2026-07-08 发布，docs.x.ai/developers/grok-4-5）：500K 上下文，$2/$6 每百万 token，
// 支持 low/medium/high 三档 reasoning_effort（默认 high）；未找到官方缓存价格，沿用本文件其余
// 型号统一的 $0.2 缓存单价。
// 协议：xAI 已提供 OpenAI Responses API 兼容端点（POST {baseUrl}/responses，SDK 用
// client.responses.create()），故整个 preset 的 type 由 'openai-chat' 改为
// 'openai-responses'；defaultBaseUrl 无需变动。
export const xaiPreset: BuiltinProviderPreset = {
  builtinId: 'xai',
  version: 2,
  name: 'xAI',
  type: 'openai-responses',
  defaultBaseUrl: 'https://api.x.ai/v1',
  homepage: 'https://x.ai',
  apiKeyUrl: 'https://console.x.ai',
  defaultModel: 'grok-4.6',
  defaultModels: [
    {
      id: 'grok',
      name: 'Grok',
      icon: 'grok',
      enabled: true,
      contextLength: 500_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 6,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'grok-4.6',
      name: 'Grok 4.6',
      icon: 'grok',
      enabled: true,
      contextLength: 500_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 6,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'grok-4.5',
      name: 'Grok 4.5',
      icon: 'grok',
      enabled: true,
      contextLength: 500_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 6,
      cacheHitPrice: 0.2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
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
      id: 'grok-4.20-non-reasoning',
      name: 'Grok 4.20 Non-Reasoning',
      icon: 'grok',
      enabled: true,
      contextLength: 1_000_000,
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
      contextLength: 1_000_000,
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
