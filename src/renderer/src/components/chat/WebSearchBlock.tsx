import * as React from 'react'
import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { countLabel } from '@renderer/lib/chat/execution-labels'
import type { WebSearchBlock as WebSearchBlockData } from '@renderer/lib/api/types'
import { CollapsibleHeightPanel } from './CollapsibleHeightPanel'

/** Best-effort host label for a web search source link (falls back to the raw URL). */
function formatWebSearchHost(url?: string): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Display-only component for a provider-native web search the model ran server-side.
 * Shows a live "searching" state the moment the call starts, then resolves in place to
 * the query (one chip per batched query) plus the consulted sources. The source list can
 * grow tall, so it is collapsed by default behind an expand toggle. Styling follows the
 * shared card + Badge design system (semantic tokens only).
 */
export function WebSearchBlock({ block }: { block: WebSearchBlockData }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const isSearching = block.status === 'searching'
  const sources = (block.sources ?? []).filter((s) => !!s.url)
  // A single call can batch several searches (action.queries[]), joined with newlines
  // upstream — render each as its own chip.
  const queries = (block.query ?? '')
    .split('\n')
    .map((q) => q.trim())
    .filter(Boolean)

  return (
    <div className="my-1 max-w-full px-1.5 py-1 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span
          className={cn(
            'shrink-0 text-[12.5px] font-medium',
            isSearching
              ? 'tool-name-live-pulse tool-name-live-pulse--running'
              : 'text-foreground/75'
          )}
        >
          {isSearching ? 'Searching web' : 'Searched web'}
        </span>
        {queries.map((query, i) => (
          <span
            key={`${query}-${i}`}
            className="max-w-[240px] truncate text-[12.5px] text-muted-foreground/60"
            title={query}
          >
            {query}
          </span>
        ))}
        {sources.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/55 transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <span>{countLabel(sources.length, 'source')}</span>
            {expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        )}
      </div>
      <CollapsibleHeightPanel
        open={expanded && sources.length > 0}
        collapseMotion="scroll-up"
        className="overflow-hidden"
      >
        <div className="ml-2 mt-1.5 flex flex-col gap-1 border-l border-border/45 pl-3 dark:border-white/[0.07]">
          {sources.map((source, i) => (
            <a
              key={`${source.url}-${i}`}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              title={source.title || source.url}
              className="max-w-full truncate text-[12px] text-muted-foreground/70 transition-colors hover:text-foreground"
            >
              {source.title || formatWebSearchHost(source.url)}
            </a>
          ))}
        </div>
      </CollapsibleHeightPanel>
    </div>
  )
}
