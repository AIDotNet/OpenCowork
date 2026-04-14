import {
  CalendarDays,
  FolderOpen,
  Image,
  MessageSquare,
  Monitor,
  Settings,
  Wand2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useUIStore, type NavItem } from '@renderer/stores/ui-store'
import { cn } from '@renderer/lib/utils'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import packageJson from '../../../../../package.json'

const navItems: { value: NavItem | 'ssh'; icon: React.ReactNode; labelKey: string }[] = [
  { value: 'chat', icon: <MessageSquare className="size-5" />, labelKey: 'navRail.conversations' },
  { value: 'tasks', icon: <CalendarDays className="size-5" />, labelKey: 'navRail.tasks' },
  { value: 'resources', icon: <FolderOpen className="size-5" />, labelKey: 'navRail.resources' },
  { value: 'skills', icon: <Wand2 className="size-5" />, labelKey: 'navRail.skills' },
  { value: 'draw', icon: <Image className="size-5" />, labelKey: 'navRail.draw' },
  { value: 'ssh', icon: <Monitor className="size-5" />, labelKey: 'navRail.ssh' }
]

export function NavRail(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const activeNavItem = useUIStore((s) => s.activeNavItem)
  const setActiveNavItem = useUIStore((s) => s.setActiveNavItem)
  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const skillsPageOpen = useUIStore((s) => s.skillsPageOpen)
  const resourcesPageOpen = useUIStore((s) => s.resourcesPageOpen)
  const drawPageOpen = useUIStore((s) => s.drawPageOpen)
  const translatePageOpen = useUIStore((s) => s.translatePageOpen)
  const tasksPageOpen = useUIStore((s) => s.tasksPageOpen)

  const handleNavClick = (item: NavItem | 'ssh'): void => {
    if (item === 'tasks') {
      useUIStore.getState().openTasksPage()
      return
    }
    if (item === 'skills') {
      useUIStore.getState().openSkillsPage()
      return
    }
    if (item === 'resources') {
      useUIStore.getState().openResourcesPage()
      return
    }
    if (item === 'draw') {
      useUIStore.getState().openDrawPage()
      return
    }
    if (item === 'translate') {
      useUIStore.getState().openTranslatePage()
      return
    }
    if (item === 'ssh') {
      void ipcClient.invoke(IPC.SSH_WINDOW_OPEN)
      return
    }
    // Close skills/settings pages when navigating to chat
    const ui = useUIStore.getState()
    if (ui.settingsPageOpen) ui.closeSettingsPage()
    if (ui.skillsPageOpen) ui.closeSkillsPage()
    if (ui.resourcesPageOpen) ui.closeResourcesPage()
    if (ui.drawPageOpen) ui.closeDrawPage()
    if (ui.translatePageOpen) ui.closeTranslatePage()
    if (ui.tasksPageOpen) ui.closeTasksPage()
    if (activeNavItem === item && leftSidebarOpen) {
      useUIStore.getState().setLeftSidebarOpen(false)
    } else {
      setActiveNavItem(item)
      // Open sidebar if it's closed
      if (!leftSidebarOpen) {
        useUIStore.getState().setLeftSidebarOpen(true)
      }
    }
  }

  return (
    <div className="flex h-full w-12 shrink-0 flex-col items-center border-r bg-muted/30 py-2">
      {/* Top nav items */}
      <div className="flex flex-col items-center gap-1">
        {navItems.map((item) => (
          <Tooltip key={item.value}>
            <TooltipTrigger asChild>
              <button
                onClick={() => handleNavClick(item.value)}
                className={cn(
                  'flex size-9 items-center justify-center rounded-lg transition-all duration-200',
                  (item.value === 'tasks' && tasksPageOpen) ||
                    (item.value === 'resources' && resourcesPageOpen) ||
                    (item.value === 'skills' && skillsPageOpen) ||
                    (item.value === 'draw' && drawPageOpen) ||
                    (item.value === 'translate' && translatePageOpen) ||
                    (!['tasks', 'resources', 'skills', 'draw', 'translate', 'ssh'].includes(
                      item.value
                    ) &&
                      activeNavItem === item.value &&
                      leftSidebarOpen)
                    ? 'bg-primary/10 text-primary shadow-sm'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {item.icon}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{t(item.labelKey)}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom: Settings + Version */}
      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => useUIStore.getState().openSettingsPage()}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground"
            >
              <Settings className="size-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('navRail.settings')}</TooltipContent>
        </Tooltip>
        <span className="text-[9px] text-muted-foreground/40 select-none">
          v{packageJson.version}
        </span>
      </div>
    </div>
  )
}
