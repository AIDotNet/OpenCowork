import {
  FolderOpen,
  Globe,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Plus,
  Terminal
} from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useUIStore, type RightPanelTabInstance } from '@renderer/stores/ui-store'
import { WorkbenchTabButton } from '@renderer/components/workbench/WorkbenchTabButton'
import { useTerminalStore } from '@renderer/stores/terminal-store'
import { useChatStore } from '@renderer/stores/chat-store'

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
  const isExpanded = useUIStore((s) => s.rightPanelExpandedForReading)
  const toggleExpanded = useUIStore((s) => s.toggleRightPanelExpandedForReading)
  const ensureProjectTerminal = useUIStore((s) => s.ensureProjectTerminalRightPanelTab)
  const activeProjectId = useChatStore((s) => s.activeProjectId)

  const handleCreateTerminal = async (): Promise<void> => {
    const newTabId = await useTerminalStore
      .getState()
      .createTab(undefined, undefined, undefined, activeProjectId ?? undefined)
    if (newTabId) {
      ensureProjectTerminal({
        terminalSource: 'local',
        localTabId: newTabId,
        title: 'Terminal',
        projectId: activeProjectId
      })
    }
  }

  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/50 bg-background/95 px-1.5 backdrop-blur">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar py-0.5">
        {animationsEnabled ? (
          <AnimatePresence initial={false}>
            {tabs.map((tab) => (
              <WorkbenchTabButton
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                animated
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
                closeLabel={t('action.close', { ns: 'common', defaultValue: 'Close' })}
              />
            ))}
          </AnimatePresence>
        ) : (
          tabs.map((tab) => (
            <WorkbenchTabButton
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              animated={false}
              onSelectTab={onSelectTab}
              onCloseTab={onCloseTab}
              closeLabel={t('action.close', { ns: 'common', defaultValue: 'Close' })}
            />
          ))
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 pl-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              title={t('preview.newTab', { defaultValue: 'New Tab' })}
            >
              <Plus className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 text-xs">
            <DropdownMenuItem onSelect={onOpenFiles} className="gap-2">
              <FolderOpen className="size-3.5 text-sky-400" />
              <span>{t('preview.openFile', { defaultValue: 'Open file...' })}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleCreateTerminal} className="gap-2">
              <Terminal className="size-3.5 text-emerald-400" />
              <span>{t('terminalDock.newTerminal', { defaultValue: 'New Terminal' })}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!browserEnabled} onSelect={onAddBrowser} className="gap-2">
              <Globe className="size-3.5 text-blue-400" />
              <span>{t('rightPanel.browser', { defaultValue: 'New Browser Tab' })}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon"
          className="size-6 rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          onClick={toggleExpanded}
          title={
            isExpanded
              ? t('rightPanelAction.collapsePanel', { defaultValue: 'Collapse panel width' })
              : t('rightPanelAction.expandPanel', { defaultValue: 'Expand panel width' })
          }
        >
          {isExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="size-6 rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          onClick={onClosePanel}
          title={t('rightPanelAction.closePanel', { defaultValue: 'Close panel' })}
        >
          <PanelRightClose className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
