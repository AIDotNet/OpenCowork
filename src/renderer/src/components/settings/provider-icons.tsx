import OpenAI from '@lobehub/icons/es/OpenAI'
import Anthropic from '@lobehub/icons/es/Anthropic'
import Gemini from '@lobehub/icons/es/Gemini'
import DeepSeek from '@lobehub/icons/es/DeepSeek'
import OpenRouter from '@lobehub/icons/es/OpenRouter'
import Ollama from '@lobehub/icons/es/Ollama'
import AzureAI from '@lobehub/icons/es/AzureAI'
import Moonshot from '@lobehub/icons/es/Moonshot'
import Qwen from '@lobehub/icons/es/Qwen'
import SiliconCloud from '@lobehub/icons/es/SiliconCloud'
import GiteeAI from '@lobehub/icons/es/GiteeAI'
import XiaomiMiMo from '@lobehub/icons/es/XiaomiMiMo'
import Claude from '@lobehub/icons/es/Claude/components/Mono'
import ChatGLM from '@lobehub/icons/es/ChatGLM/components/Mono'
import Minimax from '@lobehub/icons/es/Minimax/components/Mono'
import Kimi from '@lobehub/icons/es/Kimi/components/Mono'
import Grok from '@lobehub/icons/es/Grok/components/Mono'
import Meta from '@lobehub/icons/es/Meta/components/Mono'
import Mistral from '@lobehub/icons/es/Mistral/components/Mono'
import Baidu from '@lobehub/icons/es/Baidu/components/Mono'
import Hunyuan from '@lobehub/icons/es/Hunyuan/components/Mono'
import Nvidia from '@lobehub/icons/es/Nvidia/components/Mono'
import Stepfun from '@lobehub/icons/es/Stepfun/components/Mono'
import Doubao from '@lobehub/icons/es/Doubao/components/Mono'
import { Bot } from 'lucide-react'

const iconUrlMap: Record<string, string> = {
  'routin-ai': 'https://routin.ai/icons/favicon.ico',
}

const iconMap: Record<string, React.ComponentType<{ size?: number }>> = {
  openai: OpenAI,
  anthropic: Anthropic,
  google: Gemini,
  deepseek: DeepSeek,
  openrouter: OpenRouter,
  ollama: Ollama,
  'azure-openai': AzureAI,
  moonshot: Moonshot,
  'moonshot-coding': Moonshot,
  qwen: Qwen,
  'qwen-coding': Qwen,
  baidu: Baidu,
  'baidu-coding': Baidu,
  'minimax-coding': Minimax,
  minimax: Minimax,
  siliconflow: SiliconCloud,
  'gitee-ai': GiteeAI,
  'codex-oauth': OpenAI,
  xiaomi: XiaomiMiMo,
  'bigmodel-coding': ChatGLM,
  bigmodel: ChatGLM,
}

// --- Model-level icon map ---

const modelIconMap: Record<string, React.ComponentType<{ size?: number }>> = {
  openai: OpenAI,
  claude: Claude,
  anthropic: Anthropic,
  gemini: Gemini,
  deepseek: DeepSeek,
  qwen: Qwen,
  chatglm: ChatGLM,
  glm: ChatGLM,
  minimax: Minimax,
  kimi: Kimi,
  moonshot: Moonshot,
  grok: Grok,
  meta: Meta,
  llama: Meta,
  mistral: Mistral,
  baidu: Baidu,
  ernie: Baidu,
  hunyuan: Hunyuan,
  nvidia: Nvidia,
  nemotron: Nvidia,
  mimo: XiaomiMiMo,
  xiaomi: XiaomiMiMo,
  stepfun: Stepfun,
  step: Stepfun,
  doubao: Doubao,
  ollama: Ollama,
  siliconcloud: SiliconCloud,
}

/**
 * Auto-detect model icon key from model ID by pattern matching.
 * Handles formats like "openai/gpt-5", "deepseek-chat", "claude-sonnet-4", etc.
 */
export function detectModelIconKey(modelId: string): string | undefined {
  const id = modelId.toLowerCase()
  // GPT / OpenAI o-series
  if (/\bgpt[-.]/.test(id) || /^o[34]/.test(id) || /\bo[34][-]/.test(id)) return 'openai'
  // Claude
  if (/\bclaude/.test(id)) return 'claude'
  // Gemini
  if (/\bgemini/.test(id)) return 'gemini'
  // DeepSeek
  if (/\bdeepseek/.test(id)) return 'deepseek'
  // Qwen
  if (/\bqwen/.test(id)) return 'qwen'
  // GLM / ChatGLM / Zhipu
  if (/\bglm/.test(id) || /\bzhipu/.test(id)) return 'chatglm'
  // MiMo (Xiaomi)
  if (/\bmimo/.test(id)) return 'mimo'
  // MiniMax
  if (/\bminimax/.test(id)) return 'minimax'
  // Kimi
  if (/\bkimi/.test(id)) return 'kimi'
  // Moonshot
  if (/\bmoonshot/.test(id)) return 'moonshot'
  // Grok (xAI)
  if (/\bgrok/.test(id)) return 'grok'
  // Llama (Meta)
  if (/\bllama/.test(id) || /\bmeta[-/]/.test(id)) return 'meta'
  // Mistral / Devstral
  if (/\bmistral/.test(id) || /\bdevstral/.test(id)) return 'mistral'
  // ERNIE (Baidu)
  if (/\bernie/.test(id)) return 'ernie'
  // Hunyuan (Tencent)
  if (/\bhunyuan/.test(id)) return 'hunyuan'
  // Nemotron (Nvidia)
  if (/\bnemotron/.test(id) || /\bnvidia/.test(id)) return 'nvidia'
  // Step (Stepfun)
  if (/\bstep[0-9]/.test(id) || /\bstepfun/.test(id)) return 'stepfun'
  // Doubao (ByteDance)
  if (/\bdoubao/.test(id)) return 'doubao'
  return undefined
}

// --- ModelIcon component ---

export function ModelIcon({
  icon,
  modelId,
  providerBuiltinId,
  size = 16,
  className,
}: {
  icon?: string
  modelId?: string
  providerBuiltinId?: string
  size?: number
  className?: string
}): React.JSX.Element {
  // 1) Explicit icon key
  const explicitComp = icon ? modelIconMap[icon] : undefined
  if (explicitComp) {
    const Comp = explicitComp
    return (
      <span className={className} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        <Comp size={size} />
      </span>
    )
  }
  // 2) Auto-detect from model ID
  if (modelId) {
    const detected = detectModelIconKey(modelId)
    const detectedComp = detected ? modelIconMap[detected] : undefined
    if (detectedComp) {
      const Comp = detectedComp
      return (
        <span className={className} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <Comp size={size} />
        </span>
      )
    }
  }
  // 3) Fallback to provider icon
  if (providerBuiltinId) {
    return <ProviderIcon builtinId={providerBuiltinId} size={size} className={className} />
  }
  return <Bot size={size} className={className ?? 'text-muted-foreground'} />
}

export function ProviderIcon({
  builtinId,
  size = 20,
  className,
}: {
  builtinId?: string
  size?: number
  className?: string
}): React.JSX.Element {
  const iconUrl = builtinId ? iconUrlMap[builtinId] : undefined
  if (iconUrl) {
    return (
      <span className={className} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        <img src={iconUrl} alt="" width={size} height={size} className="rounded-sm" style={{ width: size, height: size }} />
      </span>
    )
  }
  const IconComp = builtinId ? iconMap[builtinId] : undefined
  if (IconComp) {
    return (
      <span className={className} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        <IconComp size={size} />
      </span>
    )
  }
  return <Bot size={size} className={className ?? 'text-muted-foreground'} />
}
