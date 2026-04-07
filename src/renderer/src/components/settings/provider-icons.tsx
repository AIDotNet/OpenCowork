import { Bot, Sparkles } from 'lucide-react'
import { useTheme } from 'next-themes'

const ICON_BASE = 'https://unpkg.com/@lobehub/icons-static-png@1.83.0'

const iconUrlMap: Record<string, string> = {
  'routin-ai': 'https://routin.ai/icons/favicon.ico',
  'routin-ai-plan': 'https://routin.ai/icons/favicon.ico',
  'copilot-oauth': 'https://github.githubassets.com/favicons/favicon.png'
}

const providerIconSlugMap: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  deepseek: 'deepseek',
  openrouter: 'openrouter',
  ollama: 'ollama',
  'azure-openai': 'azureai',
  moonshot: 'moonshot',
  'moonshot-coding': 'moonshot',
  longcat: 'longcat',
  qwen: 'qwen',
  'qwen-coding': 'qwen',
  baidu: 'baidu',
  'baidu-coding': 'baidu',
  'minimax-coding': 'minimax',
  minimax: 'minimax',
  siliconflow: 'siliconcloud',
  'gitee-ai': 'giteeai',
  'codex-oauth': 'openai',
  'copilot-oauth': 'github',
  xiaomi: 'xiaomimimo',
  'bigmodel-coding': 'chatglm',
  bigmodel: 'chatglm'
}

const modelIconSlugMap: Record<string, string> = {
  openai: 'openai',
  claude: 'claude',
  anthropic: 'anthropic',
  gemini: 'gemini',
  deepseek: 'deepseek',
  qwen: 'qwen',
  chatglm: 'chatglm',
  glm: 'chatglm',
  minimax: 'minimax',
  kimi: 'kimi',
  moonshot: 'moonshot',
  grok: 'grok',
  meta: 'meta',
  llama: 'meta',
  mistral: 'mistral',
  baidu: 'baidu',
  ernie: 'baidu',
  hunyuan: 'hunyuan',
  nvidia: 'nvidia',
  nemotron: 'nvidia',
  mimo: 'xiaomimimo',
  xiaomi: 'xiaomimimo',
  stepfun: 'stepfun',
  step: 'stepfun',
  doubao: 'doubao',
  ollama: 'ollama',
  siliconcloud: 'siliconcloud',
  longcat: 'longcat'
}

const colorIconSlugs = new Set([
  'azureai',
  'baidu',
  'chatglm',
  'claude',
  'deepseek',
  'doubao',
  'gemini',
  'google',
  'hunyuan',
  'kimi',
  'meta',
  'minimax',
  'mistral',
  'nvidia',
  'qwen',
  'siliconcloud',
  'stepfun'
])

function StaticIcon({
  src,
  size,
  className
}: {
  src: string
  size: number
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="rounded-sm"
        style={{ width: size, height: size }}
      />
    </span>
  )
}

function useIconVariant(): 'light' | 'dark' {
  const { resolvedTheme } = useTheme()
  return resolvedTheme === 'dark' ? 'dark' : 'light'
}

function getIconUrl(slug: string, variant: 'light' | 'dark'): string {
  const fileName = colorIconSlugs.has(slug) ? `${slug}-color` : slug
  return `${ICON_BASE}/${variant}/${fileName}.png`
}

function detectModelIconKey(modelId: string): string | undefined {
  const id = modelId.toLowerCase()
  if (/\bgpt[-.]/.test(id) || /^o[34]/.test(id) || /\bo[34][-]/.test(id)) return 'openai'
  if (/\bclaude/.test(id)) return 'claude'
  if (/\bgemini/.test(id)) return 'gemini'
  if (/\bdeepseek/.test(id)) return 'deepseek'
  if (/\bqwen/.test(id)) return 'qwen'
  if (/\bglm/.test(id) || /\bzhipu/.test(id)) return 'chatglm'
  if (/\bmimo/.test(id)) return 'mimo'
  if (/\bminimax/.test(id)) return 'minimax'
  if (/\bkimi/.test(id)) return 'kimi'
  if (/\bmoonshot/.test(id)) return 'moonshot'
  if (/\bgrok/.test(id)) return 'grok'
  if (/\bllama/.test(id) || /\bmeta[-/]/.test(id)) return 'meta'
  if (/\bmistral/.test(id) || /\bdevstral/.test(id)) return 'mistral'
  if (/\bernie/.test(id)) return 'ernie'
  if (/\bhunyuan/.test(id)) return 'hunyuan'
  if (/\bnemotron/.test(id) || /\bnvidia/.test(id)) return 'nvidia'
  if (/\bstep[0-9]/.test(id) || /\bstepfun/.test(id)) return 'stepfun'
  if (/\bdoubao/.test(id)) return 'doubao'
  return undefined
}

export function ModelIcon({
  icon,
  modelId,
  providerBuiltinId,
  size = 16,
  className
}: {
  icon?: string
  modelId?: string
  providerBuiltinId?: string
  size?: number
  className?: string
}): React.JSX.Element {
  const variant = useIconVariant()
  const explicitSlug = icon ? modelIconSlugMap[icon] : undefined
  const explicitUrl = explicitSlug ? getIconUrl(explicitSlug, variant) : undefined
  if (explicitUrl) return <StaticIcon src={explicitUrl} size={size} className={className} />
  if (modelId) {
    const detected = detectModelIconKey(modelId)
    const slug = detected ? modelIconSlugMap[detected] : undefined
    const url = slug ? getIconUrl(slug, variant) : undefined
    if (url) return <StaticIcon src={url} size={size} className={className} />
  }
  if (providerBuiltinId)
    return <ProviderIcon builtinId={providerBuiltinId} size={size} className={className} />
  return <Bot size={size} className={className ?? 'text-muted-foreground'} />
}

export function AutoModelIcon({
  size = 16,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return <Sparkles size={size} className={className ?? 'text-amber-500'} />
}

export function ProviderIcon({
  builtinId,
  size = 20,
  className
}: {
  builtinId?: string
  size?: number
  className?: string
}): React.JSX.Element {
  const variant = useIconVariant()
  const customUrl = builtinId ? iconUrlMap[builtinId] : undefined
  if (customUrl) return <StaticIcon src={customUrl} size={size} className={className} />
  const slug = builtinId ? providerIconSlugMap[builtinId] : undefined
  const url = slug ? getIconUrl(slug, variant) : undefined
  if (url) return <StaticIcon src={url} size={size} className={className} />
  return <Bot size={size} className={className ?? 'text-muted-foreground'} />
}
