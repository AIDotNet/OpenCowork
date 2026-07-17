import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  ArrowLeftRight,
  Braces,
  Copy,
  Download,
  Fingerprint,
  Folder,
  FolderOpen,
  FolderSync,
  KeyRound,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  Terminal,
  type LucideIcon
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
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
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

type WorkspaceNavKey = Exclude<SshWorkspaceSection, 'terminal'>

type QuickConnectTarget = {
  username: string
  host: string
  port: number
  name: string
  command: string
}

const TEST_STATUS_TTL_MS = 15000

const NAV_ITEMS: Array<{
  key: WorkspaceNavKey
  icon: LucideIcon
}> = [
  { key: 'hosts', icon: Server },
  { key: 'sftp', icon: FolderOpen },
  { key: 'keychain', icon: KeyRound },
  { key: 'forwarding', icon: ArrowLeftRight },
  { key: 'snippets', icon: Braces },
  { key: 'knownHosts', icon: Fingerprint },
  { key: 'logs', icon: ScrollText }
]

function parseQuickConnect(rawValue: string): QuickConnectTarget | null {
  const value = rawValue.trim()
  if (!value) return null

  const command = value.replace(/\s+/g, ' ')
  const startsWithSsh = command.startsWith('ssh ')
  const tokens = startsWithSsh ? command.split(' ').slice(1) : command.split(' ')
  let port = 22
  let loginToken: string | null = null

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue

    if (token === '-p') {
      const nextPort = Number.parseInt(tokens[index + 1] ?? '', 10)
      if (Number.isFinite(nextPort) && nextPort > 0) port = nextPort
      index += 1
      continue
    }

    if (token.startsWith('-p') && token.length > 2) {
      const inlinePort = Number.parseInt(token.slice(2), 10)
      if (Number.isFinite(inlinePort) && inlinePort > 0) port = inlinePort
      continue
    }

    if (token === '-l') {
      index += 1
      continue
    }

    if (token.startsWith('-')) continue
    loginToken = token
  }

  if (!loginToken && !startsWithSsh) loginToken = command
  if (!loginToken || !loginToken.includes('@')) return null

  const cleanedToken = loginToken.replace(/^ssh:\/\//, '').replace(/[;,]$/, '')
  const atIndex = cleanedToken.lastIndexOf('@')
  if (atIndex <= 0 || atIndex >= cleanedToken.length - 1) return null

  const username = cleanedToken.slice(0, atIndex)
  let host = cleanedToken.slice(atIndex + 1)
  const hostWithPort = host.match(/^([^:\s]+):(\d+)$/)
  if (hostWithPort) {
    host = hostWithPort[1]
    port = Number.parseInt(hostWithPort[2], 10) || port
  }

  if (!username || !host) return null

  return {
    username,
    host,
    port,
    name: host,
    command: `ssh ${username}@${host} -p ${port}`
  }
}

function getSessionForConnection(
  sessions: Record<string, SshSession>,
  connectionId: string
): SshSession | undefined {
  return Object.values(sessions).find(
    (item) =>
      item.connectionId === connectionId &&
      (item.status === 'connected' || item.status === 'connecting')
  )
}

function getGroupHostCount(connections: SshConnection[], groupId: string | null): number {
  return connections.filter((connection) => connection.groupId === groupId).length
}

type SshOsKind = 'ubuntu' | 'windows' | 'debian' | 'centos' | 'fedora' | 'macos' | 'linux'

const SSH_OS_META: Record<SshOsKind, { label: string; bg: string; fg: string }> = {
  ubuntu: { label: 'Ubuntu', bg: '#e95420', fg: '#fff7ed' },
  windows: { label: 'Windows', bg: '#0078d4', fg: '#eef7ff' },
  debian: { label: 'Debian', bg: '#a80030', fg: '#fff1f5' },
  centos: { label: 'CentOS', bg: '#6f42c1', fg: '#f5f0ff' },
  fedora: { label: 'Fedora', bg: '#294172', fg: '#edf5ff' },
  macos: { label: 'macOS', bg: '#3f3f46', fg: '#f4f4f5' },
  linux: { label: 'Linux', bg: '#262626', fg: '#f5f5f5' }
}

function inferSshOsKind(connection: SshConnection): SshOsKind {
  const configured = (connection as SshConnection & { osType?: string | null }).osType
  const text = [
    configured,
    connection.name,
    connection.host,
    connection.username,
    connection.defaultDirectory,
    connection.startupCommand
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (/\b(win|windows|rdp)\b/.test(text)) return 'windows'
  if (text.includes('ubuntu') || connection.authType === 'password') return 'ubuntu'
  if (text.includes('debian')) return 'debian'
  if (text.includes('centos') || text.includes('rocky') || text.includes('almalinux'))
    return 'centos'
  if (text.includes('fedora')) return 'fedora'
  if (text.includes('macos') || text.includes('darwin')) return 'macos'
  return 'linux'
}

function SshOsBadge({ kind }: { kind: SshOsKind }): React.JSX.Element {
  const meta = SSH_OS_META[kind]

  return (
    <div
      className="inline-flex size-9 items-center justify-center rounded-[9px] border border-[#404040] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
      style={{ backgroundColor: meta.bg, color: meta.fg }}
      title={meta.label}
      aria-label={meta.label}
    >
      {kind === 'windows' ? (
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
          <path
            fill="currentColor"
            d="M3 5.4 10.8 4v7.4H3V5.4Zm8.8-1.6L21 2.2v9.2h-9.2V3.8ZM3 12.6h7.8V20L3 18.6v-6Zm8.8 0H21v9.2l-9.2-1.6v-7.6Z"
          />
        </svg>
      ) : kind === 'ubuntu' ? (
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
          <circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" strokeWidth="2.2" />
          <circle cx="18.3" cy="7.2" r="2.2" fill="currentColor" />
          <circle cx="18.3" cy="16.8" r="2.2" fill="currentColor" />
          <circle cx="6.4" cy="12" r="2.2" fill="currentColor" />
          <path
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="2"
            d="m15.3 9.5 1.5-1.1M15.3 14.5l1.5 1.1M8.1 12H6.4"
          />
        </svg>
      ) : kind === 'macos' ? (
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
          <path
            fill="currentColor"
            d="M16.8 2.8c.1 1.2-.4 2.3-1.1 3.1-.8.9-2 1.5-3.1 1.4-.1-1.1.4-2.3 1.1-3.1.8-.9 2.1-1.5 3.1-1.4Zm3.5 14.6c-.5 1.1-.8 1.6-1.5 2.6-1 1.4-2.4 3.1-4.1 3.1-1.5 0-1.9-1-3.9-1s-2.4 1-3.9 1c-1.7 0-3-1.5-4-2.9-2.7-3.9-3-8.5-1.3-11 1.2-1.8 3.1-2.8 4.9-2.8 1.8 0 2.9 1 4.3 1 1.4 0 2.3-1 4.4-1 1.6 0 3.3.9 4.5 2.3-3.9 2.1-3.3 7.7.6 8.7Z"
          />
        </svg>
      ) : (
        <span className="text-[11px] font-bold uppercase leading-none">
          {meta.label.slice(0, kind === 'linux' ? 3 : 2)}
        </span>
      )}
    </div>
  )
}

function HostRow({
  connection,
  group,
  session,
  isSelected,
  isTesting,
  testOk,
  onEdit,
  onConnect,
  onTest
}: {
  connection: SshConnection
  group: SshGroup | undefined
  session: SshSession | undefined
  isSelected: boolean
  isTesting: boolean
  testOk: boolean | undefined
  onEdit: () => void
  onConnect: () => void
  onTest: () => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const sessionBusy = session?.status === 'connecting' || session?.status === 'reconnecting'
  const statusTone =
    session?.status === 'connected'
      ? 'text-[var(--ssh-success)]'
      : sessionBusy || isTesting
        ? 'text-[var(--ssh-warning)]'
        : testOk === false
          ? 'text-[var(--ssh-danger)]'
          : 'text-[var(--ssh-muted)]'
  const statusText =
    session?.status === 'connected'
      ? t('list.online')
      : sessionBusy
        ? t('connecting')
        : isTesting
          ? t('testing')
          : testOk === false
            ? t('list.unreachable')
            : t('list.offline')
  const osKind = inferSshOsKind(connection)
  const openActionLabel = t('list.open', { defaultValue: 'Open' })
  const badges = [
    group?.name ?? t('ungrouped'),
    t(`migration.auth.${connection.authType}`),
    `${connection.port} 端口`,
    connection.keepAliveInterval ? `${connection.keepAliveInterval}s 心跳` : null
  ].filter(Boolean) as string[]

  return (
    <div
      className={cn(
        'grid min-w-[940px] grid-cols-[76px_96px_minmax(170px,1fr)_220px_minmax(230px,280px)_144px] items-center border-b border-[#2c2c2c] bg-[#151515] px-2 text-[13px] text-[#e5e7eb] transition-colors hover:bg-[#1b1b1b]',
        isSelected && 'bg-[#1f1f1f]'
      )}
    >
      <div className="flex items-center gap-2">
        <SshOsBadge kind={osKind} />
      </div>

      <div className="flex items-center gap-2">
        <span className={cn('inline-flex items-center gap-1 text-[12px]', statusTone)}>
          <span className="size-2 rounded-full bg-current" />
          {statusText}
        </span>
      </div>

      <div className="truncate text-left font-medium">{connection.name}</div>

      <div className="flex items-center gap-2 font-mono text-[12px] text-[#d4d4d8]">
        <span className="truncate">{connection.host}</span>
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded-[6px] text-[#6ee787] hover:bg-[#222]"
          onClick={() => {
            void navigator.clipboard.writeText(connection.host)
          }}
          title="Copy host"
        >
          <Copy className="size-3" />
        </button>
      </div>

      <div className="flex flex-wrap gap-2 py-3">
        {badges.map((badge) => (
          <span
            key={badge}
            className="rounded-[6px] border border-[#3b3b3b] bg-[#2a2a2a] px-2 py-1 text-[11px] text-[#c4c4c4]"
          >
            {badge}
          </span>
        ))}
      </div>

      <div
        className="flex items-center justify-end gap-1.5 whitespace-nowrap"
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          size="sm"
          className="h-8 min-w-14 rounded-[7px] bg-[#38b768] px-3 text-[12px] font-semibold text-white shadow-none hover:bg-[#45c874]"
          onClick={onConnect}
          title={session?.status === 'connected' ? t('openTerminal') : t('connect')}
        >
          {session?.status === 'connected' ? openActionLabel : t('connect')}
        </Button>
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-[7px] border border-[#343434] bg-[#1d1d1d] text-[#b8b8b8] transition-colors hover:border-[#454545] hover:bg-[#262626] hover:text-white"
          onClick={onEdit}
          title={t('editConnection')}
          aria-label={t('editConnection')}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-[7px] border border-[#343434] bg-[#1d1d1d] text-[#b8b8b8] transition-colors hover:border-[#454545] hover:bg-[#262626] hover:text-white"
          onClick={onTest}
          title={t('testConnection')}
          aria-label={t('testConnection')}
        >
          {isTesting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Activity className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  )
}

function GroupRail({
  groups,
  connections,
  selectedGroupId,
  collapsed,
  onSelectGroup,
  onCreateGroup
}: {
  groups: SshGroup[]
  connections: SshConnection[]
  selectedGroupId: string | null
  collapsed: boolean
  onSelectGroup: (groupId: string | null) => void
  onCreateGroup: () => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const ungroupedCount = getGroupHostCount(connections, null)
  const showUngrouped = ungroupedCount > 0

  const treeItemClass = (active: boolean): string =>
    cn(
      'flex w-full items-center gap-2 rounded-[8px] px-3 py-2 text-left text-[13px] transition-colors',
      active ? 'bg-[#2b2b2b] text-white' : 'text-[#d4d4d8] hover:bg-[#212121] hover:text-white'
    )

  return (
    <aside
      className={cn(
        'shrink-0 border-r border-[#2d2d2d] bg-[#141414] text-white transition-all',
        collapsed ? 'w-[68px]' : 'w-[285px]'
      )}
    >
      <div className="h-full overflow-y-auto px-2 py-3">
        {collapsed ? (
          <div className="flex flex-col items-center gap-3 pt-2 text-[#9ca3af]">
            <Folder className="size-4" />
            {groups.slice(0, 3).map((group) => (
              <button
                key={group.id}
                type="button"
                onClick={() => onSelectGroup(group.id)}
                className={cn(
                  'inline-flex size-8 items-center justify-center rounded-[8px] transition-colors',
                  selectedGroupId === group.id
                    ? 'bg-[#2b2b2b] text-white'
                    : 'hover:bg-[#212121] hover:text-white'
                )}
                title={group.name}
              >
                <FolderOpen className="size-4" />
              </button>
            ))}
            {showUngrouped ? <Server className="size-4" /> : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-[10px] border border-[#2a2a2a] bg-[#161616] px-2 py-2">
              <div className="mb-2 flex items-center justify-between px-2 text-[13px] text-[#d4d4d8]">
                <span>{t('workspace.groupRailTitle')}</span>
                <button
                  type="button"
                  onClick={onCreateGroup}
                  className="rounded-[6px] px-2 py-1 text-[#9ca3af] hover:bg-[#212121] hover:text-white"
                  title={t('newGroup')}
                >
                  <Plus className="size-3.5" />
                </button>
              </div>

              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => onSelectGroup(null)}
                  className={treeItemClass(selectedGroupId === null)}
                >
                  <Folder className="size-4" />
                  <span className="truncate">{t('workspace.allVaults')}</span>
                  <span className="ml-auto text-[#777]">{connections.length}</span>
                </button>

                <div className="ml-4 space-y-1 border-l border-[#2a2a2a] pl-3">
                  {groups.length === 0 ? (
                    <div className="px-3 py-3 text-[12px] leading-5 text-[#7a7a7a]">
                      {t('workspace.emptyGroupsDesc', {
                        defaultValue: 'No groups yet. Create one to organize your hosts.'
                      })}
                    </div>
                  ) : null}

                  {groups.map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => onSelectGroup(group.id)}
                      className={treeItemClass(selectedGroupId === group.id)}
                    >
                      <FolderOpen className="size-4" />
                      <span className="truncate">{group.name}</span>
                      <span className="ml-auto text-[#777]">
                        {getGroupHostCount(connections, group.id)}
                      </span>
                    </button>
                  ))}

                  {showUngrouped ? (
                    <button
                      type="button"
                      onClick={() => onSelectGroup('__ungrouped__')}
                      className={treeItemClass(selectedGroupId === '__ungrouped__')}
                    >
                      <Server className="size-4" />
                      <span>{t('ungrouped')}</span>
                      <span className="ml-auto text-[#777]">{ungroupedCount}</span>
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
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

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [draftKey, setDraftKey] = useState(0)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testStatus, setTestStatus] = useState<Record<string, { ok: boolean; at: number }>>({})
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<SshGroup | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [inspectorDialogOpen, setInspectorDialogOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const quickConnectTarget = useMemo(() => parseQuickConnect(searchQuery), [searchQuery])

  const visibleConnections = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase()
    return connections.filter((connection) => {
      if (selectedGroupId === '__ungrouped__' && connection.groupId !== null) return false
      if (
        selectedGroupId !== null &&
        selectedGroupId !== '__ungrouped__' &&
        connection.groupId !== selectedGroupId
      ) {
        return false
      }
      if (!normalized || quickConnectTarget) return true
      return (
        connection.name.toLowerCase().includes(normalized) ||
        connection.host.toLowerCase().includes(normalized) ||
        connection.username.toLowerCase().includes(normalized)
      )
    })
  }, [connections, quickConnectTarget, searchQuery, selectedGroupId])

  const selectedConnection =
    inspectorMode === 'edit' && detailConnectionId
      ? (connections.find((connection) => connection.id === detailConnectionId) ?? null)
      : null

  const selectedSession = selectedConnection
    ? getSessionForConnection(sessions, selectedConnection.id)
    : undefined

  const onlineCount = useMemo(
    () =>
      connections.filter((connection) => getSessionForConnection(sessions, connection.id)).length,
    [connections, sessions]
  )

  const activeVaultLabel =
    selectedGroupId == null
      ? t('workspace.allVaults', { defaultValue: 'All hosts' })
      : selectedGroupId === '__ungrouped__'
        ? t('ungrouped')
        : (groups.find((group) => group.id === selectedGroupId)?.name ??
          t('workspace.allVaults', { defaultValue: 'All hosts' }))

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

    const nextConnection =
      visibleConnections[0] ??
      (selectedGroupId === null && !searchQuery.trim() ? (connections[0] ?? null) : null)
    setDetailConnectionId(nextConnection?.id ?? null)
  }, [
    connections,
    detailConnectionId,
    inspectorMode,
    searchQuery,
    selectedGroupId,
    setDetailConnectionId,
    setInspectorMode,
    visibleConnections
  ])

  const startCreateConnection = useCallback(() => {
    setInspectorMode('create')
    setDetailConnectionId(null)
    setDraftKey((current) => current + 1)
    setInspectorDialogOpen(true)
  }, [setDetailConnectionId, setInspectorMode])

  const handleEditConnection = useCallback(
    (connectionId: string) => {
      setInspectorMode('edit')
      setDetailConnectionId(connectionId)
      setInspectorDialogOpen(true)
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
      setInspectorDialogOpen(false)

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

  const handleQuickConnect = useCallback(async (): Promise<void> => {
    if (!quickConnectTarget) return

    const existing = connections.find(
      (connection) =>
        connection.host === quickConnectTarget.host &&
        connection.username === quickConnectTarget.username &&
        connection.port === quickConnectTarget.port
    )

    if (existing) {
      setInspectorMode('edit')
      setDetailConnectionId(existing.id)
      onConnect(existing.id)
      return
    }

    try {
      const id = await useSshStore.getState().createConnection({
        name: quickConnectTarget.name,
        host: quickConnectTarget.host,
        port: quickConnectTarget.port,
        username: quickConnectTarget.username,
        authType: 'agent',
        groupId:
          selectedGroupId && selectedGroupId !== '__ungrouped__' ? selectedGroupId : undefined,
        keepAliveInterval: 60
      })
      toast.success(t('saved'))
      setInspectorMode('edit')
      setDetailConnectionId(id)
      setSearchQuery('')
      onConnect(id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }, [
    connections,
    onConnect,
    quickConnectTarget,
    selectedGroupId,
    setDetailConnectionId,
    setInspectorMode,
    t
  ])

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || !quickConnectTarget) return
    event.preventDefault()
    void handleQuickConnect()
  }

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#141414] text-white">
        <div className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)] border-b border-[#2d2d2d]">
          <div className="flex items-center gap-2 px-3 py-3">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-[8px] px-2 py-1 text-[13px] text-[#d4d4d8] hover:bg-[#212121] hover:text-white"
              onClick={() => setSidebarCollapsed((current) => !current)}
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
              {!sidebarCollapsed ? <span>收起</span> : null}
            </button>
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center rounded-[8px] border border-[#3a3a3a] text-[#d4d4d8] hover:bg-[#212121] hover:text-white"
              onClick={() => void loadAll()}
            >
              <RefreshCw className="size-4" />
            </button>
            {!sidebarCollapsed ? (
              <>
                <button
                  type="button"
                  className="rounded-[8px] border border-[#3a3a3a] px-3 py-1.5 text-[13px] text-[#f5f5f5] hover:bg-[#212121]"
                  onClick={() => {
                    setEditingGroup(null)
                    setGroupDialogOpen(true)
                  }}
                >
                  + 分组
                </button>
                <button
                  type="button"
                  className="rounded-[8px] border border-[#3a3a3a] px-3 py-1.5 text-[13px] text-[#f5f5f5] hover:bg-[#212121]"
                  onClick={startCreateConnection}
                >
                  + SSH
                </button>
              </>
            ) : null}
          </div>

          <div className="flex items-center gap-3 px-4 py-3">
            <button
              type="button"
              className={cn(
                'rounded-[8px] px-3 py-1.5 text-[13px]',
                selectedGroupId == null
                  ? 'bg-[#232323] text-white'
                  : 'text-[#b6b6b6] hover:bg-[#212121]'
              )}
              onClick={() => setSelectedGroupId(null)}
            >
              全部
            </button>

            <div className="relative min-w-[320px] max-w-[520px] flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#71717a]" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="ssh root@** / 搜索"
                className="h-10 w-full rounded-[8px] border border-[#3a3a3a] bg-[#191919] pl-10 pr-4 text-[13px] text-[#f5f5f5] outline-none placeholder:text-[#71717a]"
              />
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                className="inline-flex size-8 items-center justify-center rounded-[8px] border border-[#3a3a3a] text-[#d4d4d8] hover:bg-[#212121] hover:text-white"
                onClick={() => setImportOpen(true)}
              >
                <FolderSync className="size-4" />
              </button>
              <button
                type="button"
                className="inline-flex size-8 items-center justify-center rounded-[8px] border border-[#3a3a3a] text-[#d4d4d8] hover:bg-[#212121] hover:text-white"
                onClick={() => void handleExportAll()}
              >
                <Download className="size-4" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <GroupRail
            groups={groups}
            connections={connections}
            selectedGroupId={selectedGroupId}
            collapsed={sidebarCollapsed}
            onSelectGroup={(groupId) => setSelectedGroupId(groupId)}
            onCreateGroup={() => {
              setEditingGroup(null)
              setGroupDialogOpen(true)
            }}
          />

          <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#141414]">
            <div className="flex items-center justify-between border-b border-[#2d2d2d] px-4 py-3">
              <div>
                <div className="text-[15px] font-semibold text-white">{activeVaultLabel}</div>
                <div className="mt-1 text-[12px] text-[#8b8b8b]">
                  {visibleConnections.length} 台主机 / {onlineCount} 台在线
                </div>
              </div>

              {quickConnectTarget ? (
                <button
                  type="button"
                  className="rounded-[8px] border border-[#2d7d48] bg-[#173620] px-3 py-1.5 text-[13px] text-[#6ee787]"
                  onClick={() => void handleQuickConnect()}
                >
                  {quickConnectTarget.command}
                </button>
              ) : null}
            </div>

            {visibleConnections.length === 0 ? (
              <div className="flex flex-1 items-center justify-center px-8">
                <div className="max-w-[420px] text-center">
                  <div className="mx-auto flex size-16 items-center justify-center rounded-[18px] border border-[#3a3a3a] bg-[#1d1d1d] text-[#6ee787]">
                    <Server className="size-7" />
                  </div>
                  <div className="mt-5 text-[18px] font-semibold text-white">
                    {t('noConnections')}
                  </div>
                  <div className="mt-2 text-[13px] leading-6 text-[#8b8b8b]">
                    {searchQuery.trim() ? t('workspace.noSearchMatches') : t('noConnectionsDesc')}
                  </div>
                  <Button
                    size="sm"
                    className="mt-6 h-10 rounded-[10px] bg-[#38b768] px-4 text-[13px] font-semibold text-white hover:bg-[#45c874]"
                    onClick={startCreateConnection}
                  >
                    <Plus className="size-4" />
                    {t('newConnection')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="min-w-[940px] border-b border-[#2d2d2d] bg-[#1b1b1b] px-2 py-3 text-[12px] text-[#9ca3af]">
                  <div className="grid grid-cols-[76px_96px_minmax(170px,1fr)_220px_minmax(230px,280px)_144px] items-center">
                    <div>系统</div>
                    <div>延迟</div>
                    <div>名称</div>
                    <div>地址</div>
                    <div>信息</div>
                    <div className="text-right">操作</div>
                  </div>
                </div>

                {visibleConnections.map((connection) => {
                  const testInfo = testStatus[connection.id]
                  const fresh =
                    typeof testInfo?.at === 'number' &&
                    Date.now() - testInfo.at < TEST_STATUS_TTL_MS
                  const testOk = fresh ? testInfo?.ok : undefined
                  const session = getSessionForConnection(sessions, connection.id)

                  return (
                    <HostRow
                      key={connection.id}
                      connection={connection}
                      group={groups.find((group) => group.id === connection.groupId)}
                      session={session}
                      isSelected={inspectorMode === 'edit' && detailConnectionId === connection.id}
                      isTesting={testingId === connection.id}
                      testOk={testOk}
                      onEdit={() => handleEditConnection(connection.id)}
                      onConnect={() => onConnect(connection.id)}
                      onTest={() => void handleTest(connection.id)}
                    />
                  )
                })}
              </div>
            )}
          </main>
        </div>
      </div>

      <Dialog open={inspectorDialogOpen} onOpenChange={setInspectorDialogOpen}>
        <DialogContent
          className="max-h-[min(860px,calc(100vh-2rem))] gap-0 overflow-hidden border-border bg-background p-0 text-foreground sm:max-w-[860px]"
          showCloseButton
        >
          <DialogHeader className="border-b border-border px-5 py-4 pr-12">
            <DialogTitle className="text-[1.05rem] text-foreground">
              {inspectorMode === 'create' || !selectedConnection
                ? t('newConnection')
                : t('editConnection')}
            </DialogTitle>
            <DialogDescription className="truncate text-[0.78rem] text-muted-foreground">
              {selectedConnection
                ? `${selectedConnection.username}@${selectedConnection.host}:${selectedConnection.port}`
                : t('workspace.newHostHint', {
                    defaultValue: 'Create a new SSH host profile.'
                  })}
            </DialogDescription>
          </DialogHeader>

          <div className="h-[min(720px,calc(100vh-9rem))] min-h-[520px] overflow-hidden">
            <SshConnectionInspector
              mode={connections.length === 0 ? 'create' : inspectorMode}
              draftKey={draftKey}
              connection={selectedConnection}
              groups={groups}
              session={selectedSession}
              showHeader={false}
              onCancel={() => setInspectorDialogOpen(false)}
              onConnect={(connectionId) => {
                setInspectorDialogOpen(false)
                onConnect(connectionId)
              }}
              onSaved={(connectionId) => {
                setInspectorMode('edit')
                setDetailConnectionId(connectionId)
                setInspectorDialogOpen(false)
              }}
              onDelete={(connection) => void handleDeleteConnection(connection)}
              onManageGroups={() => {
                setEditingGroup(null)
                setGroupDialogOpen(true)
              }}
            />
          </div>
        </DialogContent>
      </Dialog>

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
      connections.filter((connection) => getSessionForConnection(sessions, connection.id)).length,
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

  if (workspaceSection === 'hosts') {
    return <div className="flex h-full w-full min-w-0 overflow-hidden bg-[#141414]">{body}</div>
  }

  return (
    <div className="flex h-full w-full min-w-0 overflow-hidden bg-[var(--ssh-canvas)] text-[var(--ssh-text)]">
      <aside className="flex w-[72px] shrink-0 flex-col items-center border-r border-[var(--ssh-panel-border)] bg-[var(--ssh-panel-strong)] py-3">
        <div className="mb-5 flex size-10 items-center justify-center rounded-[14px] bg-[var(--ssh-accent)] text-[var(--ssh-accent-contrast)] shadow-[0_12px_28px_-18px_color-mix(in_srgb,var(--ssh-accent)_70%,transparent)]">
          <Terminal className="size-5" />
        </div>

        <nav className="flex flex-1 flex-col items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const label = t(`workspace.nav.${item.key}`, {
              defaultValue:
                item.key === 'hosts'
                  ? 'Hosts'
                  : item.key === 'sftp'
                    ? 'SFTP'
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
                  'relative inline-flex size-11 items-center justify-center rounded-[13px] transition-colors',
                  active
                    ? 'bg-[var(--ssh-accent)] text-[var(--ssh-accent-contrast)]'
                    : 'text-[var(--ssh-panel-muted)] hover:bg-[var(--ssh-panel-hover)] hover:text-[var(--ssh-panel-text)]'
                )}
                title={label}
              >
                <item.icon className="size-5" />
                {active ? (
                  <span className="absolute -right-[13px] top-1/2 h-6 w-1 -translate-y-1/2 rounded-full bg-[var(--ssh-accent)]" />
                ) : null}
              </button>
            )
          })}
        </nav>

        <div className="mt-5 space-y-2 border-t border-[var(--ssh-panel-border)] pt-3 text-center">
          <div className="text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-[var(--ssh-panel-muted)] opacity-60">
            {t('dashboard.totalServers')}
          </div>
          <div className="text-[0.9rem] font-semibold text-[var(--ssh-panel-text)]">
            {connections.length}
          </div>
          <div className="text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-[var(--ssh-panel-muted)] opacity-60">
            {t('dashboard.onlineServers')}
          </div>
          <div className="text-[0.9rem] font-semibold text-[var(--ssh-success)]">{onlineCount}</div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 overflow-hidden">{body}</div>
    </div>
  )
}
