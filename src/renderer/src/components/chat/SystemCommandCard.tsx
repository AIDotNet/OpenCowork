import * as React from 'react'
import { useTranslation } from 'react-i18next'
import Markdown from 'react-markdown'
import { Command, ChevronDown, ChevronRight } from 'lucide-react'
import type { SystemCommandSnapshot } from '@renderer/lib/commands/system-command'
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from '@renderer/lib/preview/viewers/markdown-components'

interface SystemCommandCardProps {
  command: SystemCommandSnapshot
}

function getCommandPreview(content: string): string {
  const normalized = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')

  return normalized.length > 160 ? `${normalized.slice(0, 160)}…` : normalized
}

export function SystemCommandCard({ command }: SystemCommandCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = React.useState(false)
  const preview = React.useMemo(() => getCommandPreview(command.content), [command.content])

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-violet-500/25 bg-violet-500/5">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-violet-500/5"
      >
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <Command className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-xs font-semibold text-violet-700 dark:text-violet-300">
              /{command.name}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {expanded
                ? t('userMessage.hideCommand', { defaultValue: 'Collapse commands' })
                : t('userMessage.showCommand', { defaultValue: 'Expand commands' })}
            </span>
          </span>
          {!expanded && preview && (
            <span className="mt-1 block line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
              {preview}
            </span>
          )}
        </span>
        {expanded ? (
          <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-violet-500/15 px-3 py-3 text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-background/80 [&_pre]:p-3 [&_p]:my-2">
          <Markdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS}>
            {command.content}
          </Markdown>
        </div>
      )}
    </div>
  )
}
