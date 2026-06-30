import { useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import type { ProviderConfig, UnifiedMessage } from '@renderer/lib/api/types'
import { resolveLanguageName, type AppLanguage } from '@renderer/lib/i18n-language'
import { runSidecarTextRequest } from '@renderer/lib/ipc/agent-bridge'

const stripReasoningBlocks = (value: string): string =>
  value.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '').replace(/<\/think>/gi, '')

function buildSystemPrompt(language: AppLanguage): string {
  if (language === 'zh') {
    return `你是资深工程师，根据「已暂存」的 git diff 写提交说明。

硬性要求：
- 先读懂 diff 里的真实改动与意图（行为、API、数据流、边界条件），不要写成「改了哪些文件」的流水账。
- 第一行：祈使句摘要，≤72 字符，不用句号；说明「做了什么」以及关键动机或影响（若一行写不下，正文再展开）。
- 可选正文：空一行后写设计取舍、破坏性变更、迁移注意、关联 issue 等；拒绝空话（如「优化」「完善代码」而无实质信息）。
- 禁止 Markdown 标题、列表套娃、代码围栏；输出纯文本，可直接用于 git commit。
- 使用简体中文。`
  }
  const targetLanguage = resolveLanguageName(language)

  return `You are a senior engineer writing a Git commit message from the **staged** diff.

Rules:
- Infer real intent from hunks (behavior, APIs, data flow, edge cases). Do NOT produce a file-by-file changelog or vague filler.
- Subject line: imperative, ≤72 characters, no trailing period; state what changed and why it matters (if tight, elaborate in body).
- Optional body: after one blank line, motivation, design tradeoffs, breaking changes, migration notes. No hollow phrases like "update code".
- No markdown headings, fences, or numbered essays — plain text suitable for \`git commit\`.
- Use ${targetLanguage}.`
}

/**
 * 根据暂存区 stat + patch 生成提交说明（走当前「快速模型」或主模型配置）。
 */
export async function generateCommitMessageFromStagedDiff(
  statText: string,
  patchText: string,
  language: AppLanguage,
  branchHint?: string,
  signal?: AbortSignal
): Promise<string | null> {
  const settings = useSettingsStore.getState()
  const providerStore = useProviderStore.getState()
  const fastConfig = providerStore.getFastProviderConfig()
  const activeExtras = providerStore.getActiveModelConfig()

  const config: ProviderConfig | null = fastConfig
    ? {
        ...fastConfig,
        maxTokens: 512,
        temperature: 0.25,
        systemPrompt: buildSystemPrompt(language),
        responseSummary: activeExtras?.responseSummary,
        enablePromptCache: activeExtras?.enablePromptCache,
        enableSystemPromptCache: activeExtras?.enableSystemPromptCache
      }
    : settings.apiKey && settings.model
      ? {
          type: settings.provider,
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl || undefined,
          model: settings.model,
          maxTokens: 512,
          temperature: 0.25,
          systemPrompt: buildSystemPrompt(language),
          responseSummary: activeExtras?.responseSummary,
          enablePromptCache: activeExtras?.enablePromptCache,
          enableSystemPromptCache: activeExtras?.enableSystemPromptCache
        }
      : null

  if (!config || (config.requiresApiKey !== false && !config.apiKey)) return null

  const branchLine = branchHint?.trim()
    ? language === 'zh'
      ? `当前分支（参考）：${branchHint}\n\n`
      : `Current branch (context): ${branchHint}\n\n`
    : ''

  const userBlock = `${branchLine}## git diff --cached --stat\n${statText}\n\n## git diff --cached (unified)\n${patchText}`

  const messages: UnifiedMessage[] = [
    {
      id: 'commit-msg-req',
      role: 'user',
      content: userBlock,
      createdAt: Date.now()
    }
  ]

  try {
    const abortController = new AbortController()
    const onAbort = (): void => abortController.abort()
    signal?.addEventListener('abort', onAbort, { once: true })

    const timeout = window.setTimeout(() => abortController.abort(), 60_000)
    const text = await runSidecarTextRequest({
      provider: config,
      messages,
      signal: abortController.signal
    })
    window.clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)

    let cleaned = stripReasoningBlocks(text).trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned
        .replace(/^```[\w]*\n?/, '')
        .replace(/\n```\s*$/m, '')
        .trim()
    }

    if (!cleaned) return null
    return cleaned
  } catch {
    return null
  }
}
