import { X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
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
    <div className="shrink-0 border-b border-border/50 bg-background px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold tracking-tight text-foreground/90">
          {t(`rightPanel.${activeTabDef.labelKey}`)}
        </span>

        <Button
          variant="ghost"
          size="icon"
          className="size-6 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-destructive"
          onClick={onClose}
          title={t('rightPanelAction.closePanel', { defaultValue: '关闭面板' })}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {visibleTabs.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {visibleTabs.map((tabDef) => {
            const TabIcon = tabDef.icon
            const active = tabDef.value === activeTabDef.value
            return (
              <button
                key={tabDef.value}
                type="button"
                className={
                  active
                    ? 'inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-accent px-2 text-[11px] font-medium text-accent-foreground'
                    : 'inline-flex h-7 items-center gap-1.5 rounded-md border border-transparent px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground'
                }
                onClick={() => onSelectTab(tabDef.value)}
              >
                <TabIcon className="size-3.5" />
                <span>{t(`rightPanel.${tabDef.labelKey}`)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
