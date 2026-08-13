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
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
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

interface MenuRowProps {
  icon: React.ReactNode
  label: React.ReactNode
  description?: React.ReactNode
  trailing?: React.ReactNode
  className?: string
  disabled?: boolean
  onSelect?: (event: Event) => void
}

function MenuRow({
  icon,
  label,
  description,
  trailing,
  className,
  disabled,
  onSelect
}: MenuRowProps): React.JSX.Element {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={onSelect}
      className={cn('composer-menu-row', description && 'composer-menu-row--described', className)}
    >
      <span className="composer-menu-icon">{icon}</span>
      <span className="composer-menu-copy">
        <span className="composer-menu-title">{label}</span>
        {description && <span className="composer-menu-description">{description}</span>}
      </span>
      {trailing}
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
            'group relative size-8 shrink-0 overflow-visible rounded-lg',
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
              className="pointer-events-none absolute right-0.5 top-0.5 inline-flex min-h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-semibold leading-3 text-primary-foreground shadow-sm ring-1 ring-[var(--composer-shell-top)] transition-transform group-hover:scale-110"
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
        'composer-flyout composer-flyout--menu max-w-[calc(100vw-1.5rem)] max-h-[min(320px,calc(100vh-4.5rem))] overflow-y-auto',
        menuClassName
      )}
    >
      <DropdownMenuLabel className="composer-menu-header">
        {t('skills.addLabel', { defaultValue: 'Add' })}
      </DropdownMenuLabel>

      <div className="composer-menu-section">
        {onAttachMedia && (
          <MenuRow
            icon={<Paperclip className="size-4" />}
            label={t('skills.attachMediaMenu', {
              defaultValue: t('skills.attachMedia')
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
                icon={<ClipboardList className="size-4" />}
                label={t('input.planModeMenu', { defaultValue: 'Plan Mode' })}
                description={t('skills.planModeDescription', {
                  defaultValue: 'Review the work before making changes'
                })}
                disabled={planModeDisabled}
                trailing={
                  <Switch
                    size="sm"
                    checked={planModeEnabled}
                    disabled={planModeDisabled}
                    tabIndex={-1}
                    className="composer-menu-switch pointer-events-none"
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
                icon={<Target className="size-4" />}
                label={t('input.pursueGoalMenu', { defaultValue: 'Pursue Goal' })}
                description={t('skills.goalModeDescription', {
                  defaultValue: 'Keep a goal active across the conversation'
                })}
                disabled={goalModeDisabled}
                trailing={
                  <Switch
                    size="sm"
                    checked={goalModeEnabled}
                    disabled={goalModeDisabled}
                    tabIndex={-1}
                    className="composer-menu-switch pointer-events-none"
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

      {(onAttachMedia || showModeSection) && <DropdownMenuSeparator />}

      {/* Plugins and skills are attached from the composer `/` suggestions. */}

      <div className="composer-menu-section">
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="composer-menu-row composer-menu-row--described">
              <span className="composer-menu-icon">
                <Command className="size-4" />
              </span>
              <span className="composer-menu-copy">
                <span className="composer-menu-title">{t('skills.commandsLabel')}</span>
                <span className="composer-menu-description">
                  {t('skills.commandsDescription', {
                    defaultValue: 'Run a saved command template'
                  })}
                </span>
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                sideOffset={6}
                collisionPadding={8}
                className={cn(
                  'composer-flyout composer-flyout--submenu max-w-[calc(100vw-1.5rem)] max-h-[min(320px,calc(100vh-4.5rem))] overflow-y-auto',
                  menuClassName
                )}
              >
                <DropdownMenuLabel className="composer-menu-header">
                  {t('skills.availableCommands')}
                </DropdownMenuLabel>
                {commandsLoading ? (
                  <div className="composer-menu-loading">
                    <Loader2 className="size-3.5 animate-spin" />
                    {t('skills.loadingCommands')}
                  </div>
                ) : commands.length === 0 ? (
                  <div className="composer-menu-empty">
                    <p>{t('skills.noCommands')}</p>
                    <p className="mt-1 opacity-70">~/.open-cowork/commands/</p>
                  </div>
                ) : (
                  commands.map((command) => (
                    <MenuRow
                      key={command.name}
                      icon={<Command className="size-3.5" />}
                      label={`/${command.name}`}
                      description={
                        command.summary ||
                        t('skills.commandDescription', {
                          defaultValue: 'Use this command in the next message'
                        })
                      }
                      onSelect={(event) => {
                        event.preventDefault()
                        onSelectCommand?.(command.name)
                        setOpen(false)
                      }}
                    />
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>

        {showChannels && (
          <DropdownMenuGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="composer-menu-row composer-menu-row--described">
                <span className="composer-menu-icon">
                  <MessageSquare className="size-4" />
                </span>
                <span className="composer-menu-copy">
                  <span className="composer-menu-title">{t('skills.channelsLabel')}</span>
                  <span className="composer-menu-description">
                    {t('skills.channelsDescription', {
                      defaultValue: 'Send this message to connected channels'
                    })}
                  </span>
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent
                  sideOffset={6}
                  collisionPadding={8}
                  className={cn(
                    'composer-flyout composer-flyout--submenu max-w-[calc(100vw-1.5rem)] max-h-[min(320px,calc(100vh-4.5rem))] overflow-y-auto',
                    menuClassName
                  )}
                >
                  <DropdownMenuLabel className="composer-menu-header">
                    {t('skills.availableChannels')}
                  </DropdownMenuLabel>
                  {configuredChannels.length === 0 ? (
                    <div className="composer-menu-empty">
                      <p>{t('skills.noChannels')}</p>
                      <p className="mt-1 opacity-70">{t('skills.configureInSettings')}</p>
                    </div>
                  ) : (
                    configuredChannels.map((channel) => {
                      const isActive = activeChannelIds.includes(channel.id)
                      return (
                        <DropdownMenuItem
                          key={channel.id}
                          onSelect={(event) => {
                            event.preventDefault()
                            toggleActiveChannel(channel.id, projectId)
                          }}
                          className="composer-menu-check-row"
                        >
                          <span
                            className={cn(
                              'composer-menu-checkbox',
                              isActive && 'composer-menu-checkbox--checked'
                            )}
                          >
                            {isActive && <Check className="size-3" />}
                          </span>
                          <span className="composer-menu-copy">
                            <span className="composer-menu-title">{channel.name}</span>
                            <span className="composer-menu-description">{channel.type}</span>
                          </span>
                        </DropdownMenuItem>
                      )
                    })
                  )}
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault()
                      setOpen(false)
                      openSettingsPage('channel')
                    }}
                    className="composer-menu-settings-row"
                  >
                    <Settings2 className="size-3.5" />
                    {t('skills.configureChannels')}
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          </DropdownMenuGroup>
        )}

        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="composer-menu-row composer-menu-row--described">
              <span className="composer-menu-icon">
                <Shapes className="size-4" />
              </span>
              <span className="composer-menu-copy">
                <span className="composer-menu-title">{t('skills.customExtensionsLabel')}</span>
                <span className="composer-menu-description">
                  {t('skills.extensionsDescription', {
                    defaultValue: 'Enable custom tools for this project'
                  })}
                </span>
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                sideOffset={6}
                collisionPadding={8}
                className={cn(
                  'composer-flyout composer-flyout--submenu max-w-[calc(100vw-1.5rem)] max-h-[min(320px,calc(100vh-4.5rem))] overflow-y-auto',
                  menuClassName
                )}
              >
                <DropdownMenuLabel className="composer-menu-header">
                  {t('skills.availableCustomExtensions')}
                </DropdownMenuLabel>
                {availableExtensions.length === 0 ? (
                  <div className="composer-menu-empty">
                    <p>{t('skills.noCustomExtensions')}</p>
                    <p className="mt-1 opacity-70">{t('skills.configureCustomExtensions')}</p>
                  </div>
                ) : (
                  availableExtensions.map((extension) => {
                    const isActive = activeExtensionIds.includes(extension.id)
                    return (
                      <DropdownMenuItem
                        key={extension.id}
                        onSelect={(event) => {
                          event.preventDefault()
                          toggleActiveExtension(extension.id, projectId)
                          void refreshExtensionTools()
                        }}
                        className="composer-menu-check-row"
                      >
                        <span
                          className={cn(
                            'composer-menu-checkbox',
                            isActive && 'composer-menu-checkbox--checked'
                          )}
                        >
                          {isActive && <Check className="size-3" />}
                        </span>
                        <span className="composer-menu-copy">
                          <span className="composer-menu-title">{extension.manifest.name}</span>
                          <span className="composer-menu-description">{extension.id}</span>
                        </span>
                      </DropdownMenuItem>
                    )
                  })
                )}
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault()
                    setOpen(false)
                    openSettingsPage('extension')
                  }}
                  className="composer-menu-settings-row"
                >
                  <Settings2 className="size-3.5" />
                  {t('skills.configureCustomExtensionSettings')}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>

        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="composer-menu-row composer-menu-row--described">
              <span className="composer-menu-icon">
                <Cable className="size-4" />
              </span>
              <span className="composer-menu-copy">
                <span className="composer-menu-title">{t('skills.mcpLabel')}</span>
                <span className="composer-menu-description">
                  {t('skills.mcpDescription', {
                    defaultValue: 'Connect external tools to this conversation'
                  })}
                </span>
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                sideOffset={6}
                collisionPadding={8}
                className={cn(
                  'composer-flyout composer-flyout--submenu max-w-[calc(100vw-1.5rem)] max-h-[min(320px,calc(100vh-4.5rem))] overflow-y-auto',
                  menuClassName
                )}
              >
                <DropdownMenuLabel className="composer-menu-header">
                  {t('skills.availableMcps')}
                </DropdownMenuLabel>
                {availableMcpServers.length === 0 ? (
                  <div className="composer-menu-empty">
                    <p>{t('skills.noMcps')}</p>
                    <p className="mt-1 opacity-70">{t('skills.configureMcps')}</p>
                  </div>
                ) : (
                  availableMcpServers.map((server) => {
                    const isActive = activeMcpIds.includes(server.id)
                    return (
                      <DropdownMenuItem
                        key={server.id}
                        onSelect={(event) => {
                          event.preventDefault()
                          toggleActiveMcp(server.id, projectId)
                        }}
                        className="composer-menu-check-row"
                      >
                        <span
                          className={cn(
                            'composer-menu-checkbox',
                            isActive && 'composer-menu-checkbox--checked'
                          )}
                        >
                          {isActive && <Check className="size-3" />}
                        </span>
                        <span className="composer-menu-copy">
                          <span className="composer-menu-title">{server.name}</span>
                          <span className="composer-menu-description">
                            {server.description ||
                              t('skills.mcpServerDescription', {
                                defaultValue: 'Connected MCP server'
                              })}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    )
                  })
                )}
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault()
                    setOpen(false)
                    openSettingsPage('mcp')
                  }}
                  className="composer-menu-settings-row"
                >
                  <Settings2 className="size-3.5" />
                  {t('skills.configureMcpServers')}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>
      </div>
    </DropdownMenuContent>
  )
}
