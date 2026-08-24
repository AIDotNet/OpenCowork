import type React from 'react'
import { motion } from 'motion/react'
import { Bot, FileCode, FolderOpen, Globe, Plus, Terminal, X } from 'lucide-react'
import { spring } from '@renderer/components/animate-ui/transitions'
import { cn } from '@renderer/lib/utils'
import type { RightPanelTabInstance } from '@renderer/stores/ui-store'

interface WorkbenchTabButtonProps {
  tab: RightPanelTabInstance
  active: boolean
  animated?: boolean
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  closeLabel?: string
}

function TabIcon({ tab }: { tab: RightPanelTabInstance }): React.JSX.Element {
  if (tab.kind === 'review') return <Plus className="size-3 text-muted-foreground" />
  if (tab.kind === 'files') return <FolderOpen className="size-3.5 text-sky-400" />
  if (tab.kind === 'browser') return <Globe className="size-3.5 text-blue-400" />
  if (tab.kind === 'subagent') return <Bot className="size-3.5 text-purple-400" />
  if (tab.kind === 'terminal') return <Terminal className="size-3.5 text-emerald-400" />
  return <FileCode className="size-3.5 text-amber-400" />
}

export function WorkbenchTabButton({
  tab,
  active,
  animated = true,
  onSelectTab,
  onCloseTab,
  closeLabel = 'Close'
}: WorkbenchTabButtonProps): React.JSX.Element {
  const isChangesReview = tab.kind === 'review' || tab.id === 'review'

  const buttonClass = cn(
    'group relative inline-flex h-7 max-w-48 shrink-0 items-center rounded px-2 text-[11px] font-medium transition-all select-none',
    active
      ? 'bg-muted/80 text-foreground shadow-sm'
      : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
  )

  const content = (
    <>
      {active && (
        <span className="absolute bottom-0 left-1 right-1 h-[2px] rounded-full bg-primary/70" />
      )}
      <span className="relative z-10 flex min-w-0 items-center gap-1.5">
        <TabIcon tab={tab} />
        <span className="min-w-0 truncate">
          {isChangesReview && !tab.title.includes('Changes') ? 'Changes' : tab.title}
        </span>
        {tab.modified ? (
          <span className="size-1.5 shrink-0 rounded-full bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.6)]" />
        ) : null}
        {tab.closable && !tab.pinned && !isChangesReview ? (
          <span
            role="button"
            tabIndex={-1}
            className="ml-0.5 rounded p-0.5 opacity-40 transition-opacity hover:bg-background/80 hover:opacity-100"
            aria-label={closeLabel}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onCloseTab(tab.id)
            }}
          >
            <X className="size-3" />
          </span>
        ) : null}
      </span>
    </>
  )

  if (!animated) {
    return (
      <button
        type="button"
        className={buttonClass}
        title={tab.title}
        onClick={() => onSelectTab(tab.id)}
      >
        {content}
      </button>
    )
  }

  return (
    <motion.button
      type="button"
      layout
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ ...spring.stiff, opacity: { duration: 0.12 } }}
      className={buttonClass}
      title={tab.title}
      onClick={() => onSelectTab(tab.id)}
    >
      {content}
    </motion.button>
  )
}
