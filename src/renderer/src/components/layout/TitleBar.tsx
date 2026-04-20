import {
  Download,
  HelpCircle,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { cn } from '@renderer/lib/utils'
import { PendingInboxPopover } from './PendingInboxPopover'
import { WindowControls } from './WindowControls'

interface TitleBarUpdateInfo {
  newVersion: string
  downloading: boolean
  downloadProgress: number | null
}

interface TitleBarProps {
  updateInfo: TitleBarUpdateInfo | null
  onOpenUpdateDialog: () => void
}

export function TitleBar({ updateInfo, onOpenUpdateDialog }: TitleBarProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const { t: tCommon } = useTranslation('common')
  const isMac = /Mac/.test(navigator.userAgent)

  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar)
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen)
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel)
  const chatView = useUIStore((s) => s.chatView)
  const settingsPageOpen = useUIStore((s) => s.settingsPageOpen)
  const skillsPageOpen = useUIStore((s) => s.skillsPageOpen)
  const resourcesPageOpen = useUIStore((s) => s.resourcesPageOpen)
  const drawPageOpen = useUIStore((s) => s.drawPageOpen)
  const translatePageOpen = useUIStore((s) => s.translatePageOpen)
  const tasksPageOpen = useUIStore((s) => s.tasksPageOpen)

  const autoApprove = useSettingsStore((s) => s.autoApprove)

  const chatSurfaceActive =
    !settingsPageOpen &&
    !skillsPageOpen &&
    !resourcesPageOpen &&
    !drawPageOpen &&
    !translatePageOpen &&
    !tasksPageOpen
  const showInspectorToggle = chatSurfaceActive && chatView === 'session'

  const handleToggleAutoApprove = async (): Promise<void> => {
    if (!autoApprove) {
      const ok = await confirm({ title: t('autoApproveConfirm') })
      if (!ok) return
    }

    useSettingsStore.getState().updateSettings({ autoApprove: !autoApprove })
    toast.success(t(autoApprove ? 'autoApproveOff' : 'autoApproveOn'))
  }

  return (
    <header
      className={cn(
        'titlebar-drag relative flex h-10 w-full shrink-0 items-center gap-2 overflow-hidden bg-background/80 px-3 backdrop-blur-md',
        isMac ? 'pl-[78px]' : 'pr-[132px]'
      )}
      style={{
        paddingRight: isMac ? undefined : 'calc(132px + 0.75rem)'
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="titlebar-no-drag size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
            onClick={toggleLeftSidebar}
          >
            {leftSidebarOpen ? (
              <PanelLeftClose className="size-4" />
            ) : (
              <PanelLeftOpen className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {t('commandPalette.toggleSidebar', { defaultValue: 'Toggle sidebar' })}
        </TooltipContent>
      </Tooltip>

      <div className="min-w-0 flex-1" />

      <div className="flex min-w-0 shrink items-center justify-end gap-1 overflow-hidden pr-1">
        {updateInfo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="titlebar-no-drag hidden h-7 max-w-[min(16rem,24vw)] shrink overflow-hidden border-amber-500/30 bg-amber-500/10 px-2 text-[10px] text-amber-600 hover:bg-amber-500/15 dark:text-amber-400 xl:inline-flex"
                onClick={onOpenUpdateDialog}
              >
                <span className="shrink-0">
                  {updateInfo.downloading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                </span>
                <span className="truncate">
                  {updateInfo.downloading
                    ? typeof updateInfo.downloadProgress === 'number'
                      ? tCommon('app.update.downloadingShort', {
                          progress: Math.round(updateInfo.downloadProgress)
                        })
                      : tCommon('app.update.downloading')
                    : tCommon('app.update.buttonLabel', { version: updateInfo.newVersion })}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{tCommon('app.update.buttonTooltip')}</TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-pressed={autoApprove}
              aria-label={autoApprove ? t('topbar.autoApproveOn') : t('topbar.autoApproveOff')}
              className={cn(
                'titlebar-no-drag size-7 rounded-md transition-colors',
                autoApprove
                  ? 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )}
              onClick={() => void handleToggleAutoApprove()}
            >
              <ShieldCheck className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {autoApprove ? t('topbar.autoApproveOn') : t('topbar.autoApproveOff')}
          </TooltipContent>
        </Tooltip>

        <PendingInboxPopover />

        {showInspectorToggle && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={rightPanelOpen}
                className={cn(
                  'titlebar-no-drag inline-flex size-7 items-center justify-center rounded-md transition-all',
                  rightPanelOpen
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50'
                )}
                onClick={toggleRightPanel}
              >
                {rightPanelOpen ? (
                  <PanelRightClose className="size-4" />
                ) : (
                  <PanelRightOpen className="size-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {rightPanelOpen
                ? t('topbar.closeInspector', { defaultValue: 'Close inspector' })
                : t('topbar.openInspector', { defaultValue: 'Open inspector' })}
            </TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="titlebar-no-drag inline-flex size-7 items-center justify-center rounded-md transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
              onClick={() => useUIStore.getState().setConversationGuideOpen(true)}
            >
              <HelpCircle className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('topbar.help', { defaultValue: 'Open guide' })}</TooltipContent>
        </Tooltip>
      </div>

      {!isMac && (
        <div className="absolute right-0 top-0 z-10">
          <WindowControls />
        </div>
      )}
    </header>
  )
}
