import {
  CalendarDays,
  CloudSync,
  FolderOpen,
  Image,
  MessageSquare,
  Monitor,
  Settings,
  Sparkles,
  SquareKanban,
  Wand2,
  Waypoints
} from 'lucide-react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useUIStore, type NavItem } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { cn } from '@renderer/lib/utils'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import packageJson from '../../../../../package.json'

const navItems: { value: NavItem | 'ssh'; icon: React.ReactNode; labelKey: string }[] = [
  { value: 'chat', icon: <MessageSquare className="size-5" />, labelKey: 'navRail.conversations' },
  { value: 'taskboard', icon: <SquareKanban className="size-5" />, labelKey: 'navRail.taskBoard' },
  { value: 'tasks', icon: <CalendarDays className="size-5" />, labelKey: 'navRail.tasks' },
  { value: 'resources', icon: <FolderOpen className="size-5" />, labelKey: 'navRail.resources' },
  { value: 'skills', icon: <Wand2 className="size-5" />, labelKey: 'navRail.skills' },
  { value: 'souls', icon: <Sparkles className="size-5" />, labelKey: 'navRail.souls' },
  { value: 'sync', icon: <CloudSync className="size-5" />, labelKey: 'navRail.sync' },
  { value: 'draw', icon: <Image className="size-5" />, labelKey: 'navRail.draw' },
  { value: 'codegraph', icon: <Waypoints className="size-5" />, labelKey: 'navRail.codegraph' },
  { value: 'ssh', icon: <Monitor className="size-5" />, labelKey: 'navRail.ssh' }
]

export function NavRail(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)
  const activeNavItem = useUIStore((s) => s.activeNavItem)
  const setActiveNavItem = useUIStore((s) => s.setActiveNavItem)
  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const skillsPageOpen = useUIStore((s) => s.skillsPageOpen)
  const soulsPageOpen = useUIStore((s) => s.soulsPageOpen)
  const syncPageOpen = useUIStore((s) => s.syncPageOpen)
  const resourcesPageOpen = useUIStore((s) => s.resourcesPageOpen)
  const drawPageOpen = useUIStore((s) => s.drawPageOpen)
  const translatePageOpen = useUIStore((s) => s.translatePageOpen)
  const tasksPageOpen = useUIStore((s) => s.tasksPageOpen)
  const taskBoardPageOpen = useUIStore((s) => s.taskBoardPageOpen)
  const codeGraphPageOpen = useUIStore((s) => s.codeGraphPageOpen)
  const settingsPageOpen = useUIStore((s) => s.settingsPageOpen)

  const handleNavClick = (item: NavItem | 'ssh'): void => {
    if (item === 'tasks') {
      useUIStore.getState().openTasksPage()
      return
    }
    if (item === 'taskboard') {
      useUIStore.getState().openTaskBoardPage()
      return
    }
    if (item === 'skills') {
      useUIStore.getState().openSkillsPage()
      return
    }
    if (item === 'souls') {
      useUIStore.getState().openSoulsPage()
      return
    }
    if (item === 'sync') {
      useUIStore.getState().openSyncPage()
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
    if (item === 'codegraph') {
      useUIStore.getState().openCodeGraphPage()
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
    if (ui.soulsPageOpen) ui.closeSoulsPage()
    if (ui.syncPageOpen) ui.closeSyncPage()
    if (ui.resourcesPageOpen) ui.closeResourcesPage()
    if (ui.drawPageOpen) ui.closeDrawPage()
    if (ui.translatePageOpen) ui.closeTranslatePage()
    if (ui.tasksPageOpen) ui.closeTasksPage()
    if (ui.taskBoardPageOpen) ui.closeTaskBoardPage()
    if (ui.codeGraphPageOpen) ui.closeCodeGraphPage()
    if (activeNavItem === item && leftSidebarOpen) {
      ui.toggleLeftSidebar()
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
        {navItems.map((item, index) => {
          const active =
            (item.value === 'tasks' && tasksPageOpen) ||
            (item.value === 'taskboard' && taskBoardPageOpen) ||
            (item.value === 'resources' && resourcesPageOpen) ||
            (item.value === 'skills' && skillsPageOpen) ||
            (item.value === 'souls' && soulsPageOpen) ||
            (item.value === 'sync' && syncPageOpen) ||
            (item.value === 'draw' && drawPageOpen) ||
            (item.value === 'codegraph' && codeGraphPageOpen) ||
            (item.value === 'translate' && translatePageOpen) ||
            (![
              'tasks',
              'taskboard',
              'resources',
              'skills',
              'souls',
              'sync',
              'draw',
              'codegraph',
              'translate',
              'ssh'
            ].includes(item.value) &&
              activeNavItem === item.value &&
              leftSidebarOpen)

          return (
            <Tooltip key={item.value}>
              <TooltipTrigger asChild>
                <motion.button
                  type="button"
                  onClick={() => handleNavClick(item.value)}
                  initial={animationsEnabled ? { opacity: 0, y: 4 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={
                    animationsEnabled
                      ? { duration: 0.18, delay: index * 0.02, ease: 'easeOut' }
                      : { duration: 0 }
                  }
                  whileHover={animationsEnabled ? { scale: 1.05 } : undefined}
                  whileTap={animationsEnabled ? { scale: 0.95 } : undefined}
                  className={cn(
                    'relative flex size-9 items-center justify-center rounded-lg transition-colors duration-200',
                    active
                      ? 'text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  {animationsEnabled && active ? (
                    <motion.span
                      layoutId="nav-rail-active"
                      className="absolute inset-0 rounded-lg bg-primary/10 shadow-sm"
                      transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.7 }}
                    />
                  ) : active ? (
                    <span className="absolute inset-0 rounded-lg bg-primary/10 shadow-sm" />
                  ) : null}
                  <span className="relative z-10">{item.icon}</span>
                </motion.button>
              </TooltipTrigger>
              <TooltipContent side="right">{t(item.labelKey)}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom: Settings + Version */}
      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.button
              type="button"
              onClick={() => useUIStore.getState().openSettingsPage()}
              whileHover={animationsEnabled ? { scale: 1.05 } : undefined}
              whileTap={animationsEnabled ? { scale: 0.95 } : undefined}
              className={cn(
                'relative flex size-9 items-center justify-center rounded-lg transition-colors duration-200',
                settingsPageOpen
                  ? 'text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {animationsEnabled && settingsPageOpen ? (
                <motion.span
                  layoutId="nav-rail-active"
                  className="absolute inset-0 rounded-lg bg-primary/10 shadow-sm"
                  transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.7 }}
                />
              ) : settingsPageOpen ? (
                <span className="absolute inset-0 rounded-lg bg-primary/10 shadow-sm" />
              ) : null}
              <Settings className="relative z-10 size-5" />
            </motion.button>
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
