import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeftRight,
  Braces,
  ChevronDown,
  Download,
  Fingerprint,
  FolderArchive,
  FolderSync,
  HardDriveDownload,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  SquareTerminal
} from 'lucide-react'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { cn } from '@renderer/lib/utils'
import {
  useSshStore,
  type SshConnection,
  type SshGroup,
  type SshSession,
  type SshWorkspaceSection
} from '@renderer/stores/ssh-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Button } from '@renderer/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@renderer/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { SshConnectionInspector } from './SshConnectionInspector'
import { SshGroupDialog } from './SshGroupDialog'
import { SshImportDialog } from './SshImportDialog'
import { SshKeychainWorkspace } from './SshKeychainWorkspace'
import { SshSftpWorkspace } from './SshSftpWorkspace'
import {
  SshKnownHostsWorkspace,
  SshLogsWorkspace,
  SshPortForwardingWorkspace,
  SshSnippetsWorkspace
} from './SshSupportWorkspaces'

interface SshConnectionListProps {
  onConnect: (connectionId: string) => void
}

const TEST_STATUS_TTL_MS = 15000

const NAV_ITEMS: Array<{
  key: Exclude<SshWorkspaceSection, 'terminal' | 'sftp'>
  icon: typeof Server
}> = [
  { key: 'hosts', icon: Server },
  { key: 'keychain', icon: KeyRound },
  { key: 'forwarding', icon: ArrowLeftRight },
  { key: 'snippets', icon: Braces },
  { key: 'knownHosts', icon: Fingerprint },
  { key: 'logs', icon: ScrollText }
]

const HOST_ACCENTS = [
  {
    iconBg: 'var(--primary)',
    iconShadow: '0 16px 30px -18px color-mix(in srgb, var(--primary) 44%, transparent)',
    highlight: 'var(--primary)',
    highlightShadow: '0 18px 40px -24px color-mix(in srgb, var(--primary) 28%, transparent)'
  },
  {
    iconBg: 'var(--chart-3)',
    iconShadow: '0 16px 30px -18px color-mix(in srgb, var(--chart-3) 44%, transparent)',
    highlight: 'var(--chart-3)',
    highlightShadow: '0 18px 40px -24px color-mix(in srgb, var(--chart-3) 28%, transparent)'
  }
] as const

function hashConnection(connection: SshConnection): number {
  return Array.from(`${connection.name}:${connection.host}:${connection.username}`).reduce(
    (acc, char) => acc + char.charCodeAt(0),
    0
  )
}

function HostCard({
  connection,
  group,
  session,
  isSelected,
  isTesting,
  testOk,
  onSelect,
  onConnect,
  onTest
}: {
  connection: SshConnection
  group: SshGroup | undefined
  session: SshSession | undefined
  isSelected: boolean
  isTesting: boolean
  testOk: boolean | undefined
  onSelect: () => void
  onConnect: () => void
  onTest: () => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const accent = HOST_ACCENTS[hashConnection(connection) % HOST_ACCENTS.length]
  const isConnected = session?.status === 'connected'
  const isConnecting = session?.status === 'connecting'

  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onConnect}
      className={cn(
        'group flex min-h-[132px] flex-col justify-between rounded-[22px] border bg-card/95 p-4 text-left transition-all',
        'shadow-[0_18px_44px_-30px_color-mix(in_srgb,var(--foreground)_20%,transparent)] hover:-translate-y-0.5 hover:border-primary/30',
        !isSelected && 'border-border'
      )}
      style={
        isSelected
          ? {
              borderColor: accent.highlight,
              boxShadow: accent.highlightShadow
            }
          : undefined
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-[16px] text-white"
            style={{
              background: accent.iconBg,
              boxShadow: accent.iconShadow
            }}
          >
            <Server className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[1rem] font-semibold text-foreground">
              {connection.name}
            </div>
            <div className="truncate text-[0.82rem] text-muted-foreground">
              ssh, {connection.username}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {group ? (
            <span className="rounded-full bg-muted px-2 py-1 text-[0.67rem] font-medium text-muted-foreground">
              {group.name}
            </span>
          ) : null}
          {isConnected ? (
            <span className="rounded-full bg-emerald-500/12 px-2 py-1 text-[0.67rem] font-semibold text-emerald-600 dark:text-emerald-400">
              {t('list.online')}
            </span>
          ) : isConnecting ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/12 px-2 py-1 text-[0.67rem] font-semibold text-amber-600 dark:text-amber-400">
              <Loader2 className="size-3 animate-spin" />
              {t('connecting')}
            </span>
          ) : testOk === true ? (
            <span className="rounded-full bg-emerald-500/12 px-2 py-1 text-[0.67rem] font-semibold text-emerald-600 dark:text-emerald-400">
              {t('list.reachable')}
            </span>
          ) : testOk === false ? (
            <span className="rounded-full bg-rose-500/12 px-2 py-1 text-[0.67rem] font-semibold text-rose-600 dark:text-rose-400">
              {t('list.unreachable')}
            </span>
          ) : (
            <span className="rounded-full bg-muted px-2 py-1 text-[0.67rem] font-medium text-muted-foreground">
              {t('list.offline')}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-[0.88rem] text-foreground/90">
            {connection.host}:{connection.port}
          </div>
          <div className="mt-1 truncate text-[0.74rem] text-muted-foreground">
            {t(`migration.auth.${connection.authType}`)}
            {connection.defaultDirectory ? ` · ${connection.defaultDirectory}` : ''}
          </div>
        </div>

        <div
          className="flex shrink-0 items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={(event) => event.stopPropagation()}
        >
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-full border-border bg-card px-3 text-[0.75rem] font-medium text-foreground shadow-none hover:bg-accent"
            onClick={onTest}
            disabled={isTesting}
          >
            {isTesting ? <Loader2 className="size-3.5 animate-spin" /> : t('testConnection')}
          </Button>
          <Button
            size="sm"
            className="h-9 rounded-full bg-primary px-4 text-[0.75rem] font-semibold text-primary-foreground hover:bg-primary/90"
            onClick={onConnect}
          >
            {isConnected ? t('openTerminal') : t('connect')}
          </Button>
        </div>
      </div>
    </button>
  )
}

function HostsWorkspace({
  onConnect
}: {
  onConnect: (connectionId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const groups = useSshStore((state) => state.groups)
  const connections = useSshStore((state) => state.connections)
  const sessions = useSshStore((state) => state.sessions)
  const loadAll = useSshStore((state) => state.loadAll)
  const detailConnectionId = useSshStore((state) => state.detailConnectionId)
  const setDetailConnectionId = useSshStore((state) => state.setDetailConnectionId)
  const inspectorMode = useSshStore((state) => state.inspectorMode)
  const setInspectorMode = useSshStore((state) => state.setInspectorMode)

  const userAvatar = useSettingsStore((state) => state.userAvatar)
  const userName = useSettingsStore((state) => state.userName)

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [draftKey, setDraftKey] = useState(0)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testStatus, setTestStatus] = useState<Record<string, { ok: boolean; at: number }>>({})
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<SshGroup | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const getSessionForConnection = useCallback(
    (connectionId: string) =>
      Object.values(sessions).find(
        (item) =>
          item.connectionId === connectionId &&
          (item.status === 'connected' || item.status === 'connecting')
      ),
    [sessions]
  )

  const visibleConnections = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase()
    return connections.filter((connection) => {
      if (selectedGroupId !== null && connection.groupId !== selectedGroupId) return false
      if (!normalized) return true
      return (
        connection.name.toLowerCase().includes(normalized) ||
        connection.host.toLowerCase().includes(normalized) ||
        connection.username.toLowerCase().includes(normalized)
      )
    })
  }, [connections, searchQuery, selectedGroupId])

  const selectedConnection =
    inspectorMode === 'edit' && detailConnectionId
      ? (connections.find((connection) => connection.id === detailConnectionId) ?? null)
      : null

  const selectedSession = selectedConnection
    ? getSessionForConnection(selectedConnection.id)
    : undefined

  const onlineCount = useMemo(
    () =>
      connections.filter((connection) =>
        Object.values(sessions).some(
          (session) => session.connectionId === connection.id && session.status === 'connected'
        )
      ).length,
    [connections, sessions]
  )

  const activeVaultLabel =
    selectedGroupId == null
      ? t('workspace.allVaults', { defaultValue: 'All vaults' })
      : (groups.find((group) => group.id === selectedGroupId)?.name ??
        t('workspace.allVaults', { defaultValue: 'All vaults' }))

  useEffect(() => {
    if (connections.length === 0) {
      setInspectorMode('create')
      setDetailConnectionId(null)
      return
    }

    if (inspectorMode === 'create') return

    const selectedStillVisible = visibleConnections.some(
      (connection) => connection.id === detailConnectionId
    )
    if (selectedStillVisible) return

    const nextConnection = visibleConnections[0] ?? connections[0] ?? null
    setDetailConnectionId(nextConnection?.id ?? null)
  }, [
    connections,
    detailConnectionId,
    inspectorMode,
    setDetailConnectionId,
    setInspectorMode,
    visibleConnections
  ])

  const startCreateConnection = useCallback(() => {
    setInspectorMode('create')
    setDetailConnectionId(null)
    setDraftKey((current) => current + 1)
  }, [setDetailConnectionId, setInspectorMode])

  const handleSelectConnection = useCallback(
    (connectionId: string) => {
      setInspectorMode('edit')
      setDetailConnectionId(connectionId)
    },
    [setDetailConnectionId, setInspectorMode]
  )

  const handleTest = useCallback(
    async (connectionId: string) => {
      setTestingId(connectionId)
      try {
        const result = await useSshStore.getState().testConnection(connectionId)
        setTestStatus((current) => ({
          ...current,
          [connectionId]: { ok: result.success, at: Date.now() }
        }))
        if (result.success) {
          toast.success(t('connectionSuccess'))
        } else {
          toast.error(`${t('connectionFailed')}: ${result.error}`)
        }
      } finally {
        setTestingId(null)
      }
    },
    [t]
  )

  const handleDeleteConnection = useCallback(
    async (connection: SshConnection) => {
      const ok = await confirm({
        title: t('deleteConnection'),
        description: t('confirmDelete')
      })
      if (!ok) return

      await useSshStore.getState().deleteConnection(connection.id)
      toast.success(t('deleted'))

      const remaining = useSshStore.getState().connections
      if (remaining.length === 0) {
        startCreateConnection()
        return
      }

      const nextConnection =
        visibleConnections.find((item) => item.id !== connection.id) ??
        remaining.find((item) => item.id !== connection.id) ??
        remaining[0]

      if (nextConnection) {
        setInspectorMode('edit')
        setDetailConnectionId(nextConnection.id)
      }
    },
    [setDetailConnectionId, setInspectorMode, startCreateConnection, t, visibleConnections]
  )

  const handleExportAll = useCallback(async (): Promise<void> => {
    if (connections.length === 0) {
      toast.error(t('migration.noSelection'))
      return
    }

    const ok = await confirm({
      title: t('migration.exportSensitiveTitle'),
      description: t('migration.exportSensitiveDesc')
    })
    if (!ok) return

    const date = new Date().toISOString().slice(0, 10)
    const filePick = await ipcClient.invoke(IPC.FS_SELECT_SAVE_FILE, {
      defaultPath: `open-cowork-ssh-all-${date}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (!filePick || typeof filePick !== 'object' || !('path' in filePick) || !filePick.path) {
      return
    }

    const result = (await ipcClient.invoke(IPC.SSH_EXPORT, {
      filePath: filePick.path
    })) as { success?: boolean; error?: string }

    if (result.error) {
      toast.error(result.error)
      return
    }

    toast.success(t('migration.exportSuccess'))
  }, [connections.length, t])

  return (
    <>
      <div className="flex min-w-0 flex-1 overflow-hidden">
        <main className="flex min-w-0 flex-1 flex-col border-r border-border bg-background">
          <div className="border-b border-border px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-[280px] flex-1">
                <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t('workspace.searchHosts', {
                    defaultValue: 'Find a host or ssh user@hostname...'
                  })}
                  className="h-12 w-full rounded-[18px] border border-input bg-card pl-11 pr-4 text-[0.95rem] text-foreground outline-none transition focus:border-ring focus:ring-4 focus:ring-ring/15"
                />
              </div>
              <Button
                size="sm"
                className="h-11 rounded-2xl bg-secondary px-5 text-[0.78rem] font-semibold uppercase tracking-[0.12em] text-secondary-foreground shadow-none hover:bg-secondary/80"
                onClick={() => {
                  if (selectedConnection) onConnect(selectedConnection.id)
                }}
                disabled={!selectedConnection}
              >
                {t('connect')}
              </Button>
            </div>
          </div>

          <div className="border-b border-border px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    className="h-10 rounded-[14px] bg-secondary px-4 text-[0.8rem] font-semibold text-secondary-foreground hover:bg-secondary/80"
                  >
                    <Server className="size-3.5" />
                    {t('workspace.newHost', { defaultValue: 'NEW HOST' })}
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={startCreateConnection}>
                    {t('newConnection')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setEditingGroup(null)
                      setGroupDialogOpen(true)
                    }}
                  >
                    {t('newGroup')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                variant="outline"
                size="sm"
                className="h-10 rounded-[14px] border-border bg-secondary px-4 text-[0.8rem] font-semibold text-secondary-foreground hover:bg-secondary/80"
                disabled
                title={t('workspace.comingSoon', { defaultValue: 'Coming soon' })}
              >
                <SquareTerminal className="size-3.5" />
                {t('workspace.serial', { defaultValue: 'SERIAL' })}
              </Button>

              <div className="ml-auto flex flex-wrap items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-10 rounded-[14px] border-border bg-card px-4 text-[0.8rem] font-medium text-foreground shadow-none hover:bg-accent"
                    >
                      <FolderArchive className="size-3.5" />
                      {activeVaultLabel}
                      <ChevronDown className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setSelectedGroupId(null)}>
                      {t('workspace.allVaults', { defaultValue: 'All vaults' })}
                    </DropdownMenuItem>
                    {groups.map((group) => (
                      <DropdownMenuItem key={group.id} onClick={() => setSelectedGroupId(group.id)}>
                        {group.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                <Button
                  variant="outline"
                  size="icon-sm"
                  className="size-10 rounded-[14px] border-border bg-card text-foreground shadow-none hover:bg-accent"
                  onClick={() => void loadAll()}
                  title={t('list.refresh')}
                >
                  <RefreshCw className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="size-10 rounded-[14px] border-border bg-card text-foreground shadow-none hover:bg-accent"
                  onClick={() => setImportOpen(true)}
                  title={t('migration.importButton')}
                >
                  <FolderSync className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="size-10 rounded-[14px] border-border bg-card text-foreground shadow-none hover:bg-accent"
                  onClick={() => void handleExportAll()}
                  title={t('migration.exportAll')}
                >
                  <Download className="size-4" />
                </Button>
                <Avatar className="size-10 rounded-[14px] border border-border bg-card">
                  {userAvatar ? <AvatarImage src={userAvatar} alt={userName || 'SSH'} /> : null}
                  <AvatarFallback className="rounded-[14px] bg-primary/12 text-[0.78rem] font-semibold text-primary">
                    {(userName || 'SSH').slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="rounded-[24px] border border-border bg-card/72 px-5 py-4 shadow-[0_22px_48px_-34px_color-mix(in_srgb,var(--foreground)_20%,transparent)] backdrop-blur-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[1rem] font-semibold text-foreground">
                    {t('workspace.bannerTitle', {
                      defaultValue: 'Manage hosts from one workspace.'
                    })}
                  </div>
                  <div className="mt-1 text-[0.84rem] text-muted-foreground">
                    {t('workspace.bannerDesc', {
                      defaultValue:
                        'Keep credentials, jump hosts, and default directories ready for the next session.'
                    })}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 rounded-full border-border bg-muted/60 px-4 text-[0.78rem] font-medium text-foreground shadow-none hover:bg-card"
                  onClick={() => setImportOpen(true)}
                >
                  <HardDriveDownload className="size-3.5" />
                  {t('migration.importButton')}
                </Button>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-between gap-3">
              <div>
                <div className="text-[1.12rem] font-semibold text-foreground">
                  {t('workspace.hostsHeading', { defaultValue: 'Hosts' })}
                </div>
                <div className="mt-1 text-[0.82rem] text-muted-foreground">
                  {t('workspace.hostsMeta', {
                    defaultValue: '{{count}} hosts · {{online}} online',
                    count: visibleConnections.length,
                    online: onlineCount
                  })}
                </div>
              </div>

              <div className="rounded-full bg-card px-3 py-2 text-[0.76rem] font-medium text-muted-foreground shadow-[0_10px_24px_-18px_color-mix(in_srgb,var(--foreground)_18%,transparent)]">
                {activeVaultLabel}
              </div>
            </div>

            {visibleConnections.length === 0 ? (
              <div className="mt-6 flex min-h-[320px] flex-col items-center justify-center rounded-[28px] border border-dashed border-border bg-card/62 px-8 text-center">
                <div className="flex size-16 items-center justify-center rounded-[22px] bg-primary/12 text-primary shadow-[0_14px_30px_-20px_color-mix(in_srgb,var(--primary)_25%,transparent)]">
                  <Server className="size-7" />
                </div>
                <div className="mt-5 text-[1.1rem] font-semibold text-foreground">
                  {t('noConnections')}
                </div>
                <div className="mt-2 max-w-sm text-[0.88rem] text-muted-foreground">
                  {searchQuery.trim()
                    ? t('workspace.noSearchMatches', {
                        defaultValue:
                          'No hosts match the current search. Try another hostname or user.'
                      })
                    : t('noConnectionsDesc')}
                </div>
                <Button
                  size="sm"
                  className="mt-6 h-11 rounded-2xl bg-primary px-5 text-[0.88rem] font-semibold text-primary-foreground hover:bg-primary/90"
                  onClick={startCreateConnection}
                >
                  <Plus className="size-4" />
                  {t('newConnection')}
                </Button>
              </div>
            ) : (
              <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-2">
                {visibleConnections.map((connection) => {
                  const testInfo = testStatus[connection.id]
                  const fresh =
                    typeof testInfo?.at === 'number' &&
                    Date.now() - testInfo.at < TEST_STATUS_TTL_MS
                  const testOk = fresh ? testInfo?.ok : undefined

                  return (
                    <HostCard
                      key={connection.id}
                      connection={connection}
                      group={groups.find((group) => group.id === connection.groupId)}
                      session={getSessionForConnection(connection.id)}
                      isSelected={inspectorMode === 'edit' && detailConnectionId === connection.id}
                      isTesting={testingId === connection.id}
                      testOk={testOk}
                      onSelect={() => handleSelectConnection(connection.id)}
                      onConnect={() => onConnect(connection.id)}
                      onTest={() => void handleTest(connection.id)}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </main>

        <aside className="hidden w-[360px] shrink-0 bg-muted/35 lg:flex lg:flex-col">
          <SshConnectionInspector
            mode={connections.length === 0 ? 'create' : inspectorMode}
            draftKey={draftKey}
            connection={selectedConnection}
            groups={groups}
            session={selectedSession}
            onConnect={(connectionId) => onConnect(connectionId)}
            onSaved={(connectionId) => {
              setInspectorMode('edit')
              setDetailConnectionId(connectionId)
            }}
            onDelete={(connection) => void handleDeleteConnection(connection)}
            onManageGroups={() => {
              setEditingGroup(null)
              setGroupDialogOpen(true)
            }}
          />
        </aside>
      </div>

      <SshGroupDialog
        open={groupDialogOpen}
        group={editingGroup}
        onClose={() => {
          setGroupDialogOpen(false)
          setEditingGroup(null)
        }}
      />

      <SshImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {
          void loadAll()
        }}
      />
    </>
  )
}

export function SshConnectionList({ onConnect }: SshConnectionListProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const connections = useSshStore((state) => state.connections)
  const sessions = useSshStore((state) => state.sessions)
  const workspaceSection = useSshStore((state) => state.workspaceSection)
  const setWorkspaceSection = useSshStore((state) => state.setWorkspaceSection)

  const onlineCount = useMemo(
    () =>
      connections.filter((connection) =>
        Object.values(sessions).some(
          (session) => session.connectionId === connection.id && session.status === 'connected'
        )
      ).length,
    [connections, sessions]
  )

  const body = useMemo(() => {
    switch (workspaceSection) {
      case 'keychain':
        return <SshKeychainWorkspace />
      case 'forwarding':
        return <SshPortForwardingWorkspace />
      case 'snippets':
        return <SshSnippetsWorkspace />
      case 'knownHosts':
        return <SshKnownHostsWorkspace />
      case 'logs':
        return <SshLogsWorkspace />
      case 'sftp':
        return <SshSftpWorkspace />
      case 'hosts':
      default:
        return <HostsWorkspace onConnect={onConnect} />
    }
  }, [onConnect, workspaceSection])

  return (
    <div className="flex h-full w-full min-w-0 overflow-hidden bg-background text-foreground">
      <aside className="flex w-[184px] shrink-0 flex-col border-r border-border bg-sidebar/55">
        <div className="px-4 py-5">
          <div className="text-[0.74rem] font-semibold uppercase tracking-[0.28em] text-muted-foreground">
            SSH
          </div>
          <div className="mt-2 text-[1.15rem] font-semibold text-foreground">
            {t('workspace.controlCenter', { defaultValue: 'Control Center' })}
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {NAV_ITEMS.map((item) => {
            const label = t(`workspace.nav.${item.key}`, {
              defaultValue:
                item.key === 'hosts'
                  ? 'Hosts'
                  : item.key === 'keychain'
                    ? 'Keychain'
                    : item.key === 'forwarding'
                      ? 'Port Forwarding'
                      : item.key === 'snippets'
                        ? 'Snippets'
                        : item.key === 'knownHosts'
                          ? 'Known Hosts'
                          : 'Logs'
            })
            const active = workspaceSection === item.key

            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setWorkspaceSection(item.key)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left text-[0.95rem] transition-colors',
                  active
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <item.icon className="size-4" />
                <span>{label}</span>
              </button>
            )
          })}
        </nav>

        <div className="border-t border-border px-4 py-4">
          <div className="flex items-center justify-between text-[0.74rem] text-muted-foreground">
            <span>{t('dashboard.totalServers')}</span>
            <span className="font-semibold text-foreground">{connections.length}</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-[0.74rem] text-muted-foreground">
            <span>{t('dashboard.onlineServers')}</span>
            <span className="font-semibold text-foreground">{onlineCount}</span>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 overflow-hidden">{body}</div>
    </div>
  )
}
