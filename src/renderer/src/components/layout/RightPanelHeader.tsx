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
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { cn } from '@renderer/lib/utils'
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
  if (tab.kind === 'browser') return <Globe className="size-3.5" />
  if (tab.kind === 'subagent') return <Bot className="size-3.5" />
  if (tab.kind === 'terminal') return <Terminal className="size-3.5" />
  return <FileCode className="size-3.5" />
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
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/55 bg-background/95 px-2">
      <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto pt-1">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <button
              key={tab.id}
              type="button"
              className={cn(
                'group inline-flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors',
                active
                  ? 'bg-muted text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.55)]'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
              title={tab.title}
              onClick={() => onSelectTab(tab.id)}
            >
              <TabIcon tab={tab} />
              <span className="min-w-0 truncate">{tab.title}</span>
              {tab.modified ? (
                <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
              ) : null}
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
            </button>
          )
        })}
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
