import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  Loader2,
  Command,
  Paperclip,
  MessageSquare,
  Settings2,
  Check,
  Cable,
  ClipboardList,
  Target,
  Shapes
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { cn } from '@renderer/lib/utils'
import { useChannelStore } from '@renderer/stores/channel-store'
import { resolveConfiguredActiveMcpIds, useMcpStore } from '@renderer/stores/mcp-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { listCommands, type CommandCatalogItem } from '@renderer/lib/commands/command-loader'
import {
  resolveEffectiveActiveExtensionIds,
  useExtensionStore
} from '@renderer/stores/extension-store'
import { refreshExtensionTools } from '@renderer/lib/extensions/extension-tools'

interface SkillsMenuProps {
  onSelectCommand?: (commandName: string) => void
  onAttachMedia?: () => void
  disabled?: boolean
  projectId?: string | null
  showChannels?: boolean
  triggerClassName?: string
  menuClassName?: string
  showModeToggles?: boolean
  planModeEnabled?: boolean
  goalModeEnabled?: boolean
  planModeDisabled?: boolean
  goalModeDisabled?: boolean
  onPlanModeChange?: (enabled: boolean) => void
  onGoalModeChange?: (enabled: boolean) => void
}

/**
 * The composer should have one compact state indicator instead of a row of
 * status pills. Keep the count derived from the same project-scoped stores as
 * the menu so the badge remains useful while the menu is closed.
 */
function useActiveAdditionsCount(projectId?: string | null, showChannels = true): number {
  const mcpServers = useMcpStore((s) => s.servers)
  const activeMcpIdsByProject = useMcpStore((s) => s.activeMcpIdsByProject)
  const extensions = useExtensionStore((s) => s.extensions)
  const activeExtensionIdsByProject = useExtensionStore((s) => s.activeExtensionIdsByProject)
  const channels = useChannelStore((s) => s.channels)
  const activeChannelIdsByProject = useChannelStore((s) => s.activeChannelIdsByProject)

  return React.useMemo(() => {
    const activeMcpIds = resolveConfiguredActiveMcpIds({
      projectId,
      activeMcpIdsByProject,
      servers: mcpServers
    })
    const activeExtensionIds = resolveEffectiveActiveExtensionIds({
      projectId,
      activeExtensionIdsByProject,
      extensions
    })

    let activeChannelCount = 0
    if (showChannels) {
      const activeChannelIds = activeChannelIdsByProject[projectId ?? '__global__'] ?? []
      const configuredChannelIds = new Set(
        channels
          .filter((channel) => channel.enabled && (!projectId || channel.projectId === projectId))
          .map((channel) => channel.id)
      )
      activeChannelCount = activeChannelIds.filter((id) => configuredChannelIds.has(id)).length
    }

    return activeMcpIds.length + activeExtensionIds.length + activeChannelCount
  }, [
    activeChannelIdsByProject,
    activeExtensionIdsByProject,
    activeMcpIdsByProject,
    channels,
    extensions,
    mcpServers,
    projectId,
    showChannels
  ])
}

type MenuIconTone = 'sky' | 'violet' | 'amber' | 'indigo' | 'emerald' | 'purple' | 'teal'

const MENU_ICON_TONES: Record<MenuIconTone, { bg: string; text: string; border: string }> = {
  sky: {
    bg: 'bg-sky-500/12',
    text: 'text-sky-600 dark:text-sky-400',
    border: 'border-sky-500/25'
  },
  violet: {
    bg: 'bg-violet-500/12',
    text: 'text-violet-600 dark:text-violet-400',
    border: 'border-violet-500/25'
  },
  amber: {
    bg: 'bg-amber-500/12',
    text: 'text-amber-600 dark:text-amber-400',
    border: 'border-amber-500/25'
  },
  indigo: {
    bg: 'bg-indigo-500/12',
    text: 'text-indigo-600 dark:text-indigo-400',
    border: 'border-indigo-500/25'
  },
  emerald: {
    bg: 'bg-emerald-500/12',
    text: 'text-emerald-600 dark:text-emerald-400',
    border: 'border-emerald-500/25'
  },
  purple: {
    bg: 'bg-purple-500/12',
    text: 'text-purple-600 dark:text-purple-400',
    border: 'border-purple-500/25'
  },
  teal: {
    bg: 'bg-teal-500/12',
    text: 'text-teal-600 dark:text-teal-400',
    border: 'border-teal-500/25'
  }
}

function MenuIconBadge({
  tone,
  children
}: {
  tone: MenuIconTone
  children: React.ReactNode
}): React.JSX.Element {
  const t = MENU_ICON_TONES[tone]
  return (
    <span
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-lg border transition-transform duration-150',
        t.bg,
        t.text,
        t.border
      )}
    >
      {children}
    </span>
  )
}

interface MenuRowProps {
  icon: React.ReactNode
  label: React.ReactNode
  description?: React.ReactNode
  trailing?: React.ReactNode
  badge?: React.ReactNode
  className?: string
  active?: boolean
  disabled?: boolean
  onSelect?: (event: Event) => void
}

function MenuRow({
  icon,
  label,
  description,
  trailing,
  badge,
  className,
  active,
  disabled,
  onSelect
}: MenuRowProps): React.JSX.Element {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors cursor-pointer outline-none select-none',
        'hover:bg-muted/70 focus:bg-muted/70',
        active && 'bg-primary/10 text-primary',
        disabled && 'pointer-events-none opacity-40',
        className
      )}
    >
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'truncate text-xs font-medium',
              active
                ? 'font-semibold text-primary'
                : 'text-foreground/90 group-hover:text-foreground'
            )}
          >
            {label}
          </span>
          {badge}
        </div>
        {description && (
          <span className="truncate text-[11px] text-muted-foreground/80 leading-tight mt-0.5">
            {description}
          </span>
        )}
      </div>
      {trailing}
    </DropdownMenuItem>
  )
}

function SubmenuTriggerRow({
  icon,
  label,
  description,
  badge,
  className
}: {
  icon: React.ReactNode
  label: React.ReactNode
  description?: React.ReactNode
  badge?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <DropdownMenuSubTrigger
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors cursor-pointer outline-none select-none',
        'hover:bg-muted/70 focus:bg-muted/70 data-[state=open]:bg-muted/80',
        className
      )}
    >
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground/90 group-hover:text-foreground">
            {label}
          </span>
          {badge}
        </div>
        {description && (
          <span className="truncate text-[11px] text-muted-foreground/80 leading-tight mt-0.5">
            {description}
          </span>
        )}
      </div>
    </DropdownMenuSubTrigger>
  )
}

function SubmenuCheckboxRow({
  active,
  title,
  subtitle,
  onSelect
}: {
  active: boolean
  title: string
  subtitle?: string
  onSelect: (e: Event) => void
}): React.JSX.Element {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors cursor-pointer hover:bg-muted/70 focus:bg-muted/70',
        active && 'bg-primary/8'
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-md border transition-colors',
          active
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border/80 bg-background'
        )}
      >
        {active && <Check className="size-2.5 stroke-[3]" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            'truncate text-xs',
            active ? 'font-semibold text-primary' : 'font-medium text-foreground/90'
          )}
        >
          {title}
        </span>
        {subtitle && (
          <span className="truncate text-[10px] text-muted-foreground/75 leading-tight mt-0.5">
            {subtitle}
          </span>
        )}
      </div>
    </DropdownMenuItem>
  )
}

function SubmenuSettingsAction({
  label,
  onSelect
}: {
  label: string
  onSelect: (e: Event) => void
}): React.JSX.Element {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className="mt-1 flex w-full items-center gap-2 rounded-xl border border-dashed border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground cursor-pointer"
    >
      <Settings2 className="size-3.5 shrink-0" />
      <span className="truncate text-[11px] font-medium">{label}</span>
    </DropdownMenuItem>
  )
}

export function SkillsMenu({
  onSelectCommand,
  onAttachMedia,
  disabled = false,
  projectId,
  showChannels = true,
  triggerClassName,
  menuClassName,
  showModeToggles = true,
  planModeEnabled = false,
  goalModeEnabled = false,
  planModeDisabled = false,
  goalModeDisabled = false,
  onPlanModeChange,
  onGoalModeChange
}: SkillsMenuProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [open, setOpen] = React.useState(false)
  const activeAdditionsCount = useActiveAdditionsCount(projectId, showChannels)
  const displayedCount = activeAdditionsCount > 99 ? '99+' : activeAdditionsCount
  const triggerLabel =
    activeAdditionsCount > 0
      ? t('skills.addActionsWithCount', {
          count: activeAdditionsCount,
          defaultValue: `${t('skills.addActions')} (${activeAdditionsCount})`
        })
      : t('skills.addActions')

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          data-tour="composer-plus"
          variant="ghost"
          size="icon-sm"
          className={cn(
            'group relative size-8 shrink-0 overflow-visible rounded-lg transition-all',
            triggerClassName
          )}
          disabled={disabled}
          aria-label={triggerLabel}
          title={triggerLabel}
        >
          <Plus className="size-4" />
          {activeAdditionsCount > 0 && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-0.5 top-0.5 inline-flex min-h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-semibold leading-3 text-primary-foreground shadow-xs ring-1 ring-[var(--composer-shell-top)] transition-transform group-hover:scale-110"
            >
              {displayedCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      {open && (
        <SkillsMenuContent
          onSelectCommand={onSelectCommand}
          onAttachMedia={onAttachMedia}
          projectId={projectId}
          showChannels={showChannels}
          menuClassName={menuClassName}
          showModeToggles={showModeToggles}
          planModeEnabled={planModeEnabled}
          goalModeEnabled={goalModeEnabled}
          planModeDisabled={planModeDisabled}
          goalModeDisabled={goalModeDisabled}
          onPlanModeChange={onPlanModeChange}
          onGoalModeChange={onGoalModeChange}
          setOpen={setOpen}
        />
      )}
    </DropdownMenu>
  )
}

function SkillsMenuContent({
  onSelectCommand,
  onAttachMedia,
  projectId,
  showChannels = true,
  menuClassName,
  showModeToggles = true,
  planModeEnabled = false,
  goalModeEnabled = false,
  planModeDisabled = false,
  goalModeDisabled = false,
  onPlanModeChange,
  onGoalModeChange,
  setOpen
}: SkillsMenuProps & { setOpen: (open: boolean) => void }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [commands, setCommands] = React.useState<CommandCatalogItem[]>([])
  const [commandsLoading, setCommandsLoading] = React.useState(false)

  const channels = useChannelStore((s) => s.channels)
  const activeChannelIdsByProject = useChannelStore((s) => s.activeChannelIdsByProject)
  const activeChannelIds = activeChannelIdsByProject[projectId ?? '__global__'] ?? []
  const toggleActiveChannel = useChannelStore((s) => s.toggleActiveChannel)
  const loadChannels = useChannelStore((s) => s.loadChannels)
  const loadProviders = useChannelStore((s) => s.loadProviders)
  const configuredChannels = React.useMemo(
    () =>
      channels.filter((item) => item.enabled && (!projectId ? true : item.projectId === projectId)),
    [channels, projectId]
  )

  const mcpServers = useMcpStore((s) => s.servers)
  const activeMcpIdsByProject = useMcpStore((s) => s.activeMcpIdsByProject)
  const activeMcpIds = React.useMemo(
    () =>
      resolveConfiguredActiveMcpIds({
        projectId,
        activeMcpIdsByProject,
        servers: mcpServers
      }),
    [activeMcpIdsByProject, mcpServers, projectId]
  )
  const toggleActiveMcp = useMcpStore((s) => s.toggleActiveMcp)
  const loadMcpServers = useMcpStore((s) => s.loadServers)
  const refreshAllMcpServers = useMcpStore((s) => s.refreshAllServers)
  const availableMcpServers = React.useMemo(
    () =>
      mcpServers.filter(
        (item) =>
          item.enabled && (!projectId ? true : !item.projectId || item.projectId === projectId)
      ),
    [mcpServers, projectId]
  )
  const extensions = useExtensionStore((s) => s.extensions)
  const activeExtensionIdsByProject = useExtensionStore((s) => s.activeExtensionIdsByProject)
  const activeExtensionIds = React.useMemo(
    () =>
      resolveEffectiveActiveExtensionIds({
        projectId,
        activeExtensionIdsByProject,
        extensions
      }),
    [activeExtensionIdsByProject, extensions, projectId]
  )
  const availableExtensions = React.useMemo(
    () => extensions.filter((extension) => extension.enabled),
    [extensions]
  )
  const toggleActiveExtension = useExtensionStore((s) => s.toggleActiveExtension)
  const loadExtensions = useExtensionStore((s) => s.loadExtensions)

  const openSettingsPage = useUIStore((s) => s.openSettingsPage)
  const showModeSection = showModeToggles && Boolean(onPlanModeChange || onGoalModeChange)

  React.useEffect(() => {
    loadProviders()
    loadChannels()
    loadMcpServers()
    refreshAllMcpServers()
    loadExtensions()

    let cancelled = false
    setCommandsLoading(true)
    void listCommands()
      .then((items) => {
        if (!cancelled) {
          setCommands(items)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCommandsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [loadProviders, loadChannels, loadMcpServers, refreshAllMcpServers, loadExtensions])

  return (
    <DropdownMenuContent
      align="start"
      side="top"
      sideOffset={8}
      collisionPadding={8}
      className={cn(
        'w-80 max-w-[calc(100vw-1.5rem)] max-h-[min(460px,calc(100vh-4.5rem))] overflow-y-auto rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-2xl backdrop-blur-xl',
        menuClassName
      )}
    >
      <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {t('skills.addLabel', { defaultValue: '添加与模式' })}
      </div>

      <div className="space-y-0.5">
        {onAttachMedia && (
          <MenuRow
            icon={
              <MenuIconBadge tone="sky">
                <Paperclip className="size-3.5" />
              </MenuIconBadge>
            }
            label={t('skills.attachMediaMenu', {
              defaultValue: t('skills.attachMedia')
            })}
            description={t('skills.attachMediaDescription', {
              defaultValue: '添加图片、代码文件或目录'
            })}
            onSelect={(event) => {
              event.preventDefault()
              setOpen(false)
              requestAnimationFrame(() => {
                onAttachMedia()
              })
            }}
          />
        )}

        {showModeSection && (
          <>
            {onPlanModeChange && (
              <MenuRow
                icon={
                  <MenuIconBadge tone="violet">
                    <ClipboardList className="size-3.5" />
                  </MenuIconBadge>
                }
                label={t('input.planModeMenu', { defaultValue: 'Plan Mode' })}
                description={t('skills.planModeDescription', {
                  defaultValue: '开启计划模式，先审阅再做变更'
                })}
                disabled={planModeDisabled}
                active={planModeEnabled}
                trailing={
                  <Switch
                    size="sm"
                    checked={planModeEnabled}
                    disabled={planModeDisabled}
                    tabIndex={-1}
                    className="pointer-events-none shrink-0"
                  />
                }
                onSelect={(event) => {
                  event.preventDefault()
                  onPlanModeChange(!planModeEnabled)
                }}
              />
            )}
            {onGoalModeChange && (
              <MenuRow
                icon={
                  <MenuIconBadge tone="amber">
                    <Target className="size-3.5" />
                  </MenuIconBadge>
                }
                label={t('input.pursueGoalMenu', { defaultValue: 'Pursue Goal' })}
                description={t('skills.goalModeDescription', {
                  defaultValue: '在整个对话中持续聚焦目标'
                })}
                disabled={goalModeDisabled}
                active={goalModeEnabled}
                trailing={
                  <Switch
                    size="sm"
                    checked={goalModeEnabled}
                    disabled={goalModeDisabled}
                    tabIndex={-1}
                    className="pointer-events-none shrink-0"
                  />
                }
                onSelect={(event) => {
                  event.preventDefault()
                  onGoalModeChange(!goalModeEnabled)
                }}
              />
            )}
          </>
        )}
      </div>

      <div className="my-1.5 border-t border-border/50" />

      <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {t('skills.toolsAndIntegrations', { defaultValue: '扩展与工具' })}
      </div>

      <div className="space-y-0.5">
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <SubmenuTriggerRow
              icon={
                <MenuIconBadge tone="indigo">
                  <Command className="size-3.5" />
                </MenuIconBadge>
              }
              label={t('skills.commandsLabel')}
              description={t('skills.commandsDescription', {
                defaultValue: '运行已保存的命令模板'
              })}
              badge={
                commands.length > 0 ? (
                  <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {commands.length}
                  </span>
                ) : null
              }
            />
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                sideOffset={6}
                collisionPadding={8}
                className={cn(
                  'w-[300px] max-w-[calc(100vw-1.5rem)] max-h-[min(380px,calc(100vh-4.5rem))] overflow-y-auto rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-2xl backdrop-blur-xl',
                  menuClassName
                )}
              >
                <div className="sticky top-0 z-10 mb-1 flex items-center justify-between border-b border-border/60 bg-popover/95 px-2.5 py-1.5 backdrop-blur-sm">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {t('skills.availableCommands')}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground/50">
                    {commands.length}
                  </span>
                </div>
                {commandsLoading ? (
                  <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    <span>{t('skills.loadingCommands')}</span>
                  </div>
                ) : commands.length === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    <p className="font-medium">{t('skills.noCommands')}</p>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">
                      ~/.open-cowork/commands/
                    </p>
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {commands.map((command) => (
                      <MenuRow
                        key={command.name}
                        icon={
                          <MenuIconBadge tone="indigo">
                            <Command className="size-3" />
                          </MenuIconBadge>
                        }
                        label={`/${command.name}`}
                        description={
                          command.summary ||
                          t('skills.commandDescription', {
                            defaultValue: '在下一条消息中使用此命令'
                          })
                        }
                        onSelect={(event) => {
                          event.preventDefault()
                          onSelectCommand?.(command.name)
                          setOpen(false)
                        }}
                      />
                    ))}
                  </div>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>

        <DropdownMenuGroup>
          <DropdownMenuSub>
            <SubmenuTriggerRow
              icon={
                <MenuIconBadge tone="emerald">
                  <Cable className="size-3.5" />
                </MenuIconBadge>
              }
              label={t('skills.mcpLabel')}
              description={t('skills.mcpDescription', {
                defaultValue: '将外部工具连接到此对话'
              })}
              badge={
                activeMcpIds.length > 0 ? (
                  <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                    {activeMcpIds.length} {t('skills.activeBadge', { defaultValue: '活跃' })}
                  </span>
                ) : availableMcpServers.length > 0 ? (
                  <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {availableMcpServers.length}
                  </span>
                ) : null
              }
            />
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                sideOffset={6}
                collisionPadding={8}
                className={cn(
                  'w-[300px] max-w-[calc(100vw-1.5rem)] max-h-[min(380px,calc(100vh-4.5rem))] overflow-y-auto rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-2xl backdrop-blur-xl',
                  menuClassName
                )}
              >
                <div className="sticky top-0 z-10 mb-1 flex items-center justify-between border-b border-border/60 bg-popover/95 px-2.5 py-1.5 backdrop-blur-sm">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {t('skills.availableMcps')}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground/50">
                    {availableMcpServers.length}
                  </span>
                </div>
                {availableMcpServers.length === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    <p className="font-medium">{t('skills.noMcps')}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground/70">
                      {t('skills.configureMcps')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {availableMcpServers.map((server) => {
                      const isActive = activeMcpIds.includes(server.id)
                      return (
                        <SubmenuCheckboxRow
                          key={server.id}
                          active={isActive}
                          title={server.name}
                          subtitle={
                            server.description ||
                            t('skills.mcpServerDescription', {
                              defaultValue: '已连接的 MCP 服务器'
                            })
                          }
                          onSelect={(event) => {
                            event.preventDefault()
                            toggleActiveMcp(server.id, projectId)
                          }}
                        />
                      )
                    })}
                  </div>
                )}
                <SubmenuSettingsAction
                  label={t('skills.configureMcpServers')}
                  onSelect={(event) => {
                    event.preventDefault()
                    setOpen(false)
                    openSettingsPage('mcp')
                  }}
                />
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>

        <DropdownMenuGroup>
          <DropdownMenuSub>
            <SubmenuTriggerRow
              icon={
                <MenuIconBadge tone="purple">
                  <Shapes className="size-3.5" />
                </MenuIconBadge>
              }
              label={t('skills.customExtensionsLabel')}
              description={t('skills.extensionsDescription', {
                defaultValue: '为此项目启用专属自定义工具'
              })}
              badge={
                activeExtensionIds.length > 0 ? (
                  <span className="rounded-md bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-400">
                    {activeExtensionIds.length} {t('skills.activeBadge', { defaultValue: '活跃' })}
                  </span>
                ) : availableExtensions.length > 0 ? (
                  <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {availableExtensions.length}
                  </span>
                ) : null
              }
            />
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                sideOffset={6}
                collisionPadding={8}
                className={cn(
                  'w-[300px] max-w-[calc(100vw-1.5rem)] max-h-[min(380px,calc(100vh-4.5rem))] overflow-y-auto rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-2xl backdrop-blur-xl',
                  menuClassName
                )}
              >
                <div className="sticky top-0 z-10 mb-1 flex items-center justify-between border-b border-border/60 bg-popover/95 px-2.5 py-1.5 backdrop-blur-sm">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {t('skills.availableCustomExtensions')}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground/50">
                    {availableExtensions.length}
                  </span>
                </div>
                {availableExtensions.length === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    <p className="font-medium">{t('skills.noCustomExtensions')}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground/70">
                      {t('skills.configureCustomExtensions')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {availableExtensions.map((extension) => {
                      const isActive = activeExtensionIds.includes(extension.id)
                      return (
                        <SubmenuCheckboxRow
                          key={extension.id}
                          active={isActive}
                          title={extension.manifest.name}
                          subtitle={extension.id}
                          onSelect={(event) => {
                            event.preventDefault()
                            toggleActiveExtension(extension.id, projectId)
                            void refreshExtensionTools()
                          }}
                        />
                      )
                    })}
                  </div>
                )}
                <SubmenuSettingsAction
                  label={t('skills.configureCustomExtensionSettings')}
                  onSelect={(event) => {
                    event.preventDefault()
                    setOpen(false)
                    openSettingsPage('extension')
                  }}
                />
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>

        {showChannels && (
          <DropdownMenuGroup>
            <DropdownMenuSub>
              <SubmenuTriggerRow
                icon={
                  <MenuIconBadge tone="teal">
                    <MessageSquare className="size-3.5" />
                  </MenuIconBadge>
                }
                label={t('skills.channelsLabel')}
                description={t('skills.channelsDescription', {
                  defaultValue: '将消息发送到已连接的频道'
                })}
                badge={
                  activeChannelIds.length > 0 ? (
                    <span className="rounded-md bg-teal-500/15 px-1.5 py-0.5 text-[10px] font-medium text-teal-600 dark:text-teal-400">
                      {activeChannelIds.length} {t('skills.activeBadge', { defaultValue: '活跃' })}
                    </span>
                  ) : configuredChannels.length > 0 ? (
                    <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {configuredChannels.length}
                    </span>
                  ) : null
                }
              />
              <DropdownMenuPortal>
                <DropdownMenuSubContent
                  sideOffset={6}
                  collisionPadding={8}
                  className={cn(
                    'w-[300px] max-w-[calc(100vw-1.5rem)] max-h-[min(380px,calc(100vh-4.5rem))] overflow-y-auto rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-2xl backdrop-blur-xl',
                    menuClassName
                  )}
                >
                  <div className="sticky top-0 z-10 mb-1 flex items-center justify-between border-b border-border/60 bg-popover/95 px-2.5 py-1.5 backdrop-blur-sm">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      {t('skills.availableChannels')}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground/50">
                      {configuredChannels.length}
                    </span>
                  </div>
                  {configuredChannels.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                      <p className="font-medium">{t('skills.noChannels')}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground/70">
                        {t('skills.configureInSettings')}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      {configuredChannels.map((channel) => {
                        const isActive = activeChannelIds.includes(channel.id)
                        return (
                          <SubmenuCheckboxRow
                            key={channel.id}
                            active={isActive}
                            title={channel.name}
                            subtitle={channel.type}
                            onSelect={(event) => {
                              event.preventDefault()
                              toggleActiveChannel(channel.id, projectId)
                            }}
                          />
                        )
                      })}
                    </div>
                  )}
                  <SubmenuSettingsAction
                    label={t('skills.configureChannels')}
                    onSelect={(event) => {
                      event.preventDefault()
                      setOpen(false)
                      openSettingsPage('channel')
                    }}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          </DropdownMenuGroup>
        )}
      </div>
    </DropdownMenuContent>
  )
}
