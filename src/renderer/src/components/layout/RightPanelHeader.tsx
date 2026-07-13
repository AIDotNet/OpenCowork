import {
  Bot,
  FileCode,
  FileDiff,
  FolderOpen,
  Globe,
  PanelRightClose,
  Plus,
  Terminal,
  X
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { spring } from '@renderer/components/animate-ui/transitions'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings-store'
import type { RightPanelTabInstance } from '@renderer/stores/ui-store'

interface RightPanelHeaderProps {
  tabs: RightPanelTabInstance[]
  activeTabId: string
  browserEnabled: boolean
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onOpenFiles: () => void
  onAddBrowser: () => void
  onClosePanel: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}

function TabIcon({ tab }: { tab: RightPanelTabInstance }): React.JSX.Element {
  if (tab.kind === 'review') return <FileDiff className="size-3.5" />
  if (tab.kind === 'files') return <FolderOpen className="size-3.5" />
  if (tab.kind === 'browser') return <Globe className="size-3.5" />
  if (tab.kind === 'subagent') return <Bot className="size-3.5" />
  if (tab.kind === 'terminal') return <Terminal className="size-3.5" />
  return <FileCode className="size-3.5" />
}

const TAB_INDICATOR_CLASS =
  'absolute inset-0 rounded-md bg-muted shadow-[inset_0_0_0_1px_hsl(var(--border)/0.55)]'

function TabButton({
  tab,
  active,
  animated,
  onSelectTab,
  onCloseTab,
  t
}: {
  tab: RightPanelTabInstance
  active: boolean
  animated: boolean
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  t: (key: string, options?: Record<string, unknown>) => string
}): React.JSX.Element {
  const className = cn(
    'group relative inline-flex h-7 max-w-44 shrink-0 items-center rounded-md px-2 text-[11px] font-medium transition-colors',
    active ? 'text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
  )

  const content = (
    <>
      {active ? (
        animated ? (
          <motion.div
            layoutId="right-panel-tab-indicator"
            transition={spring.stiff}
            className={TAB_INDICATOR_CLASS}
          />
        ) : (
          <div className={TAB_INDICATOR_CLASS} />
        )
      ) : null}
      <span className="relative z-10 flex min-w-0 items-center gap-1.5">
        <TabIcon tab={tab} />
        <span className="min-w-0 truncate">{tab.title}</span>
        {tab.modified ? <span className="size-1.5 shrink-0 rounded-full bg-amber-500" /> : null}
        {tab.closable ? (
          <span
            role="button"
            tabIndex={-1}
            className="ml-0.5 rounded p-0.5 opacity-55 transition-opacity hover:bg-background/70 hover:opacity-100"
            aria-label={t('action.close', { ns: 'common', defaultValue: 'Close' })}
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
        className={className}
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
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ ...spring.stiff, opacity: { duration: 0.15 } }}
      className={className}
      title={tab.title}
      onClick={() => onSelectTab(tab.id)}
    >
      {content}
    </motion.button>
  )
}

export function RightPanelHeader({
  tabs,
  activeTabId,
  browserEnabled,
  onSelectTab,
  onCloseTab,
  onOpenFiles,
  onAddBrowser,
  onClosePanel,
  t
}: RightPanelHeaderProps): React.JSX.Element {
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/55 bg-background/95 px-2">
      <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto pt-1">
        {animationsEnabled ? (
          <AnimatePresence initial={false}>
            {tabs.map((tab) => (
              <TabButton
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                animated
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
                t={t}
              />
            ))}
          </AnimatePresence>
        ) : (
          tabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              animated={false}
              onSelectTab={onSelectTab}
              onCloseTab={onCloseTab}
              t={t}
            />
          ))
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7 shrink-0 rounded-md">
            <Plus className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={onOpenFiles}>
            <FolderOpen className="size-4" />
            {t('preview.openFile', { defaultValue: 'Open file' })}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!browserEnabled} onSelect={onAddBrowser}>
            <Globe className="size-4" />
            {t('rightPanel.browser', { defaultValue: 'Browser' })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        onClick={onClosePanel}
        title={t('rightPanelAction.closePanel', { defaultValue: 'Close panel' })}
      >
        <PanelRightClose className="size-4" />
      </Button>
    </div>
  )
}
