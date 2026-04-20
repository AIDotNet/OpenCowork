import { X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import type { RightPanelTab } from '@renderer/stores/ui-store'
import type { RightPanelTabDef } from './right-panel-defs'

interface RightPanelHeaderProps {
  activeTabDef: RightPanelTabDef
  visibleTabs: RightPanelTabDef[]
  onSelectTab: (tab: RightPanelTab) => void
  onClose: () => void
  t: (key: string, options?: { defaultValue?: string }) => string
}

export function RightPanelHeader({
  activeTabDef,
  visibleTabs,
  onSelectTab,
  onClose,
  t
}: RightPanelHeaderProps): React.JSX.Element {
  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border/50 bg-background px-1 overflow-x-auto">
      {visibleTabs.map((tabDef) => {
        const TabIcon = tabDef.icon
        const active = tabDef.value === activeTabDef.value
        return (
          <button
            key={tabDef.value}
            type="button"
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
            onClick={() => onSelectTab(tabDef.value)}
          >
            <TabIcon className="size-3.5" />
            <span>{t(`rightPanel.${tabDef.labelKey}`)}</span>
          </button>
        )
      })}

      <Button
        variant="ghost"
        size="icon"
        className="ml-auto size-6 shrink-0 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-destructive"
        onClick={onClose}
        title={t('rightPanelAction.closePanel', { defaultValue: '关闭面板' })}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}
