import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  Sparkles,
  Loader2,
  Command,
  Paperclip,
  MessageSquare,
  Settings2,
  Check,
  Cable,
  ClipboardList,
  Target,
  Puzzle
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
import { useSkillsStore } from '@renderer/stores/skills-store'
import { useChannelStore } from '@renderer/stores/channel-store'
import { useMcpStore } from '@renderer/stores/mcp-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { listCommands, type CommandCatalogItem } from '@renderer/lib/commands/command-loader'
import { resolvePluginsForProject, useAppPluginStore } from '@renderer/stores/app-plugin-store'
import { APP_PLUGIN_DESCRIPTORS, type AppPluginId } from '@renderer/lib/app-plugin/types'

interface SkillsMenuProps {
  onSelectSkill: (skillName: string) => void
  onSelectCommand?: (commandName: string) => void
  onSelectPlugin?: (pluginId: AppPluginId) => void
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

export function SkillsMenu({
  onSelectSkill,
  onSelectCommand,
  onSelectPlugin,
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
  const [commands, setCommands] = React.useState<CommandCatalogItem[]>([])
  const [commandsLoading, setCommandsLoading] = React.useState(false)
  const skills = useSkillsStore((s) => s.skills)
  const loading = useSkillsStore((s) => s.loading)
  const loadSkills = useSkillsStore((s) => s.loadSkills)

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
  const activeMcpIds = activeMcpIdsByProject[projectId ?? '__global__'] ?? []
  const toggleActiveMcp = useMcpStore((s) => s.toggleActiveMcp)
  const loadMcpServers = useMcpStore((s) => s.loadServers)
  const refreshAllMcpServers = useMcpStore((s) => s.refreshAllServers)
  const mcpStatuses = useMcpStore((s) => s.serverStatuses)
  const mcpTools = useMcpStore((s) => s.serverTools)
  const pluginsByProject = useAppPluginStore((s) => s.pluginsByProject)
  const availablePlugins = React.useMemo(() => {
    const projectPlugins = resolvePluginsForProject(pluginsByProject, projectId)

    return APP_PLUGIN_DESCRIPTORS.filter((descriptor) => !descriptor.hidden)
      .map((descriptor) => {
        const plugin = projectPlugins.find((item) => item.id === descriptor.id)
        if (!plugin?.enabled) return null

        return {
          id: descriptor.id,
          title: t(`plugin.items.${descriptor.id}.title`, {
            ns: 'settings',
            defaultValue: descriptor.id
          }),
          description: t(`plugin.items.${descriptor.id}.description`, {
            ns: 'settings',
            defaultValue: ''
          })
        }
      })
      .filter(
        (item): item is { id: AppPluginId; title: string; description: string } => item !== null
      )
  }, [pluginsByProject, projectId, t])
  const pluginBackedSkillNames = React.useMemo(
    () =>
      new Set(
        APP_PLUGIN_DESCRIPTORS.filter((descriptor) => !descriptor.hidden).map(
          (descriptor) => descriptor.id
        )
      ),
    []
  )
  const visibleSkills = React.useMemo(
    () => skills.filter((skill) => !pluginBackedSkillNames.has(skill.name as AppPluginId)),
    [pluginBackedSkillNames, skills]
  )
  const connectedMcpServers = React.useMemo(
    () =>
      mcpServers.filter(
        (item) =>
          item.enabled &&
          mcpStatuses[item.id] === 'connected' &&
          (!projectId ? true : !item.projectId || item.projectId === projectId)
      ),
    [mcpServers, mcpStatuses, projectId]
  )

  const openSettingsPage = useUIStore((s) => s.openSettingsPage)
  const showModeSection = showModeToggles && Boolean(onPlanModeChange || onGoalModeChange)

  React.useEffect(() => {
    if (!open) return

    loadSkills()
    loadProviders()
    loadChannels()
    loadMcpServers()
    refreshAllMcpServers()

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
  }, [open, loadSkills, loadProviders, loadChannels, loadMcpServers, refreshAllMcpServers])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          data-tour="composer-plus"
          variant="ghost"
          size="icon-sm"
          className={cn('size-8 shrink-0 rounded-lg', triggerClassName)}
          disabled={disabled}
          aria-label={t('skills.addActions')}
          title={t('skills.addActions')}
        >
          <Plus className="size-4" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className={cn('w-56', menuClassName)}>
        <DropdownMenuLabel>{t('skills.addToChat')}</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {onAttachMedia && (
          <>
            <DropdownMenuItem
              onClick={() => {
                setOpen(false)
                requestAnimationFrame(() => {
                  onAttachMedia()
                })
              }}
            >
              <Paperclip className="mr-2 size-4" />
              <span>{t('skills.attachMedia')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}

        {showModeSection && (
          <>
            <DropdownMenuGroup>
              {onPlanModeChange && (
                <DropdownMenuItem
                  disabled={planModeDisabled}
                  onSelect={(event) => {
                    event.preventDefault()
                    onPlanModeChange(!planModeEnabled)
                  }}
                  className="justify-between"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ClipboardList className="size-4" />
                    <span>{t('input.planModeMenu', { defaultValue: 'Plan Mode' })}</span>
                  </span>
                  <Switch
                    size="sm"
                    checked={planModeEnabled}
                    disabled={planModeDisabled}
                    tabIndex={-1}
                    className="pointer-events-none ml-3"
                  />
                </DropdownMenuItem>
              )}
              {onGoalModeChange && (
                <DropdownMenuItem
                  disabled={goalModeDisabled}
                  onSelect={(event) => {
                    event.preventDefault()
                    onGoalModeChange(!goalModeEnabled)
                  }}
                  className="justify-between"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Target className="size-4" />
                    <span>{t('input.pursueGoalMenu', { defaultValue: 'Pursue Goal' })}</span>
                  </span>
                  <Switch
                    size="sm"
                    checked={goalModeEnabled}
                    disabled={goalModeDisabled}
                    tabIndex={-1}
                    className="pointer-events-none ml-3"
                  />
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Command className="mr-2 size-4" />
              <span>{t('skills.commandsLabel')}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                className={cn('w-64 max-h-80 overflow-y-auto', menuClassName)}
              >
                <DropdownMenuLabel>{t('skills.availableCommands')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {commandsLoading ? (
                  <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    {t('skills.loadingCommands')}
                  </div>
                ) : commands.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    <p>{t('skills.noCommands')}</p>
                    <p className="mt-1 text-[10px] opacity-70">~/.open-cowork/commands/</p>
                  </div>
                ) : (
                  commands.map((command) => (
                    <DropdownMenuItem
                      key={command.name}
                      onClick={() => {
                        onSelectCommand?.(command.name)
                        setOpen(false)
                      }}
                      className="flex flex-col items-start gap-1 py-2"
                    >
                      <span className="font-medium">/{command.name}</span>
                      {command.summary && (
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {command.summary}
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Sparkles className="mr-2 size-4" />
              <span>{t('skills.skillsLabel')}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                className={cn('w-64 max-h-80 overflow-y-auto', menuClassName)}
              >
                <DropdownMenuLabel>{t('skills.availableSkills')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {loading ? (
                  <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    {t('skills.loadingSkills')}
                  </div>
                ) : visibleSkills.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    <p>{t('skills.noSkills')}</p>
                    <p className="mt-1 text-[10px] opacity-70">~/.open-cowork/skills/</p>
                  </div>
                ) : (
                  visibleSkills.map((skill) => (
                    <DropdownMenuItem
                      key={skill.name}
                      onClick={() => {
                        onSelectSkill(skill.name)
                        setOpen(false)
                      }}
                      className="flex flex-col items-start gap-1 py-2"
                    >
                      <span className="font-medium">{skill.name}</span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {skill.description}
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        {showChannels && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <MessageSquare className="mr-2 size-4" />
                  <span>{t('skills.channelsLabel')}</span>
                  {activeChannelIds.length > 0 && (
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {activeChannelIds.length}
                    </span>
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent
                    className={cn('w-56 max-h-80 overflow-y-auto', menuClassName)}
                  >
                    <DropdownMenuLabel>{t('skills.availableChannels')}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {configuredChannels.length === 0 ? (
                      <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                        <p>{t('skills.noChannels')}</p>
                        <p className="mt-1 text-[10px] opacity-70">
                          {t('skills.configureInSettings')}
                        </p>
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
                            className="flex cursor-pointer items-center gap-2 py-1.5"
                          >
                            <span
                              className={`flex size-4 items-center justify-center rounded border ${
                                isActive
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'border-muted-foreground/30'
                              }`}
                            >
                              {isActive && <Check className="size-3" />}
                            </span>
                            <span className="flex-1 truncate text-xs">{channel.name}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {channel.type}
                            </span>
                          </DropdownMenuItem>
                        )
                      })
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        setOpen(false)
                        openSettingsPage('channel')
                      }}
                      className="text-xs"
                    >
                      <Settings2 className="mr-2 size-3.5" />
                      {t('skills.configureChannels')}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}

        {onSelectPlugin && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Puzzle className="mr-2 size-4" />
                  <span>{t('skills.pluginsLabel')}</span>
                  {availablePlugins.length > 0 && (
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {availablePlugins.length}
                    </span>
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent
                    className={cn('w-64 max-h-80 overflow-y-auto', menuClassName)}
                  >
                    <DropdownMenuLabel>{t('skills.availablePlugins')}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {availablePlugins.length === 0 ? (
                      <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                        <p>{t('skills.noPlugins')}</p>
                      </div>
                    ) : (
                      availablePlugins.map((plugin) => (
                        <DropdownMenuItem
                          key={plugin.id}
                          onClick={() => {
                            onSelectPlugin(plugin.id)
                            setOpen(false)
                          }}
                          className="flex flex-col items-start gap-1 py-2"
                        >
                          <span className="font-medium">{plugin.title}</span>
                          <span className="line-clamp-2 text-xs text-muted-foreground">
                            {plugin.description}
                          </span>
                        </DropdownMenuItem>
                      ))
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        setOpen(false)
                        openSettingsPage('plugin')
                      }}
                      className="text-xs"
                    >
                      <Settings2 className="mr-2 size-3.5" />
                      {t('skills.configurePlugins')}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Cable className="mr-2 size-4" />
              <span>{t('skills.mcpLabel')}</span>
              {activeMcpIds.length > 0 && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {activeMcpIds.length}
                </span>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                className={cn('w-56 max-h-80 overflow-y-auto', menuClassName)}
              >
                <DropdownMenuLabel>{t('skills.availableMcps')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {connectedMcpServers.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    <p>{t('skills.noMcps')}</p>
                    <p className="mt-1 text-[10px] opacity-70">{t('skills.configureMcps')}</p>
                  </div>
                ) : (
                  connectedMcpServers.map((server) => {
                    const isActive = activeMcpIds.includes(server.id)
                    const toolCount = mcpTools[server.id]?.length ?? 0
                    return (
                      <DropdownMenuItem
                        key={server.id}
                        onSelect={(event) => {
                          event.preventDefault()
                          toggleActiveMcp(server.id, projectId)
                        }}
                        className="flex cursor-pointer items-center gap-2 py-1.5"
                      >
                        <span
                          className={`flex size-4 items-center justify-center rounded border ${
                            isActive
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-muted-foreground/30'
                          }`}
                        >
                          {isActive && <Check className="size-3" />}
                        </span>
                        <span className="flex-1 truncate text-xs">{server.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {t('skills.mcpToolCount', { count: toolCount })}
                        </span>
                      </DropdownMenuItem>
                    )
                  })
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    setOpen(false)
                    openSettingsPage('mcp')
                  }}
                  className="text-xs"
                >
                  <Settings2 className="mr-2 size-3.5" />
                  {t('skills.configureMcpServers')}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
