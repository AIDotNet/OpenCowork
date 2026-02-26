import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  FolderPlus,
  ChevronRight,
  ChevronDown,
  Server,
  Trash2,
  Pencil,
  Play,
  Square,
  Loader2,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react'
import { useSshStore, type SshConnection, type SshGroup } from '@renderer/stores/ssh-store'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'
import { toast } from 'sonner'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { SshConnectionForm } from './SshConnectionForm'
import { SshGroupDialog } from './SshGroupDialog'

interface SshConnectionListProps {
  onConnect: (connectionId: string) => void
}

const TEST_STATUS_TTL_MS = 15000

export function SshConnectionList({ onConnect }: SshConnectionListProps): React.JSX.Element {
  const { t } = useTranslation('ssh')

  const groups = useSshStore((s) => s.groups)
  const connections = useSshStore((s) => s.connections)
  const sessions = useSshStore((s) => s.sessions)
  const loadAll = useSshStore((s) => s.loadAll)

  const [showForm, setShowForm] = useState(false)
  const [editingConnection, setEditingConnection] = useState<SshConnection | null>(null)
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<SshGroup | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testStatus, setTestStatus] = useState<Record<string, { ok: boolean; at: number }>>({})
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)

  const toggleGroup = (groupId: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  const handleConnect = useCallback(
    async (connectionId: string) => {
      onConnect(connectionId)
    },
    [onConnect]
  )

  const handleOpenTerminal = useCallback(
    (connectionId: string) => {
      onConnect(connectionId)
    },
    [onConnect]
  )

  const handleDisconnect = useCallback(async (sessionId: string) => {
    await useSshStore.getState().disconnect(sessionId)
  }, [])

  const handleTest = useCallback(
    async (connectionId: string) => {
      setTestingId(connectionId)
      try {
        const result = await useSshStore.getState().testConnection(connectionId)
        setTestStatus((prev) => ({
          ...prev,
          [connectionId]: { ok: result.success, at: Date.now() },
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
        description: t('confirmDelete'),
      })
      if (!ok) return
      await useSshStore.getState().deleteConnection(connection.id)
      toast.success(t('deleted'))
    },
    [t]
  )

  const handleDeleteGroup = useCallback(
    async (group: SshGroup) => {
      const ok = await confirm({
        title: t('groupDialog.title'),
        description: t('confirmDeleteGroup'),
      })
      if (!ok) return
      await useSshStore.getState().deleteGroup(group.id)
      toast.success(t('groupDeleted'))
    },
    [t]
  )

  const getSessionForConnection = (connectionId: string) => {
    return Object.values(sessions).find(
      (s) => s.connectionId === connectionId && (s.status === 'connected' || s.status === 'connecting')
    )
  }

  // Group connections
  const grouped = new Map<string | null, SshConnection[]>()
  for (const conn of connections) {
    const key = conn.groupId
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(conn)
  }

  // Filter connections by selected group
  const visibleConnections =
    selectedGroupId === null
      ? connections
      : connections.filter((c) => c.groupId === selectedGroupId)

  const now = Date.now()

  return (
    <div className="flex h-full w-full flex-1 min-w-0 overflow-hidden">
      {/* Left sidebar: Group tree */}
      <div className="flex w-52 shrink-0 flex-col border-r bg-muted/20">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            {t('groups')}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-1">
          {/* All connections */}
          <button
            className={cn(
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
              selectedGroupId === null
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
            onClick={() => setSelectedGroupId(null)}
          >
            <Server className="size-3 shrink-0" />
            <span className="truncate">{t('list.allConnections')}</span>
            <span className="ml-auto text-[9px] text-muted-foreground/50">{connections.length}</span>
          </button>

          {/* Groups */}
          {groups.map((group) => {
            const groupConns = grouped.get(group.id) || []
            const isCollapsed = collapsedGroups.has(group.id)
            const isSelected = selectedGroupId === group.id
            return (
              <div key={group.id} className="mt-0.5">
                <div className="flex items-center group">
                  <button
                    className={cn(
                      'flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                      isSelected
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                    )}
                    onClick={() => setSelectedGroupId(group.id)}
                  >
                    <button
                      className="shrink-0"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleGroup(group.id)
                      }}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="size-3 text-muted-foreground/50" />
                      ) : (
                        <ChevronDown className="size-3 text-muted-foreground/50" />
                      )}
                    </button>
                    <span className="truncate">{group.name}</span>
                    <span className="ml-auto text-[9px] text-muted-foreground/50">
                      {groupConns.length}
                    </span>
                  </button>
                  <button
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted mr-0.5 transition-opacity"
                    onClick={() => {
                      setEditingGroup(group)
                      setGroupDialogOpen(true)
                    }}
                  >
                    <Pencil className="size-2.5 text-muted-foreground/50" />
                  </button>
                  <button
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 mr-1 transition-opacity"
                    onClick={() => void handleDeleteGroup(group)}
                  >
                    <Trash2 className="size-2.5 text-destructive/60" />
                  </button>
                </div>
                {!isCollapsed &&
                  groupConns.map((conn) => {
                    const sess = getSessionForConnection(conn.id)
                    const isConnected = sess?.status === 'connected'
                    return (
                      <button
                        key={conn.id}
                        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 ml-4 text-left text-[11px] text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground transition-colors"
                        onClick={() => void handleOpenTerminal(conn.id)}
                      >
                        <div className="relative">
                          <Server className="size-2.5" />
                          {isConnected && (
                            <div className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-emerald-500" />
                          )}
                        </div>
                        <span className="truncate">{conn.name}</span>
                      </button>
                    )
                  })}
              </div>
            )
          })}
        </div>
      </div>

      {/* Main area: Connection table */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-1.5 border-b px-3 py-1.5 shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => void loadAll()}
          >
            <RefreshCw className="size-3" />
            {t('list.refresh')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => {
              setEditingGroup(null)
              setGroupDialogOpen(true)
            }}
          >
            <FolderPlus className="size-3" />
            {t('list.addGroup')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => {
              setEditingConnection(null)
              setShowForm(true)
            }}
          >
            <Plus className="size-3" />
            {t('list.addServer')}
          </Button>
        </div>

        {/* Connection list */}
        <div className="flex-1 overflow-y-auto">
          {visibleConnections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-8">
              <Server className="mb-3 size-10 text-muted-foreground/25" />
              <p className="text-sm text-muted-foreground/60">{t('noConnections')}</p>
              <p className="mt-1 text-xs text-muted-foreground/40">{t('noConnectionsDesc')}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4 gap-1 text-xs"
                onClick={() => {
                  setEditingConnection(null)
                  setShowForm(true)
                }}
              >
                <Plus className="size-3" />
                {t('newConnection')}
              </Button>
            </div>
          ) : (
            <div className="divide-y">
              {visibleConnections.map((conn) => {
                const sess = getSessionForConnection(conn.id)
                const isConnected = sess?.status === 'connected'
                const isConnecting = sess?.status === 'connecting'
                const isTesting = testingId === conn.id
                const group = groups.find((g) => g.id === conn.groupId)
                const testInfo = testStatus[conn.id]
                const testFresh = testInfo ? now - testInfo.at < TEST_STATUS_TTL_MS : false
                const isReachable = !isConnected && !isConnecting && testFresh && !!testInfo?.ok
                const isUnreachable = !isConnected && !isConnecting && testFresh && testInfo != null && !testInfo.ok

                return (
                  <div
                    key={conn.id}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors group"
                  >
                    {/* Server icon + status */}
                    <div className="relative shrink-0">
                      <div className="flex size-8 items-center justify-center rounded-lg bg-muted/40">
                        <Server className="size-4 text-muted-foreground" />
                      </div>
                      {isConnected && (
                        <div className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-emerald-500 border-2 border-background" />
                      )}
                      {isConnecting && (
                        <div className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-amber-500 border-2 border-background animate-pulse" />
                      )}
                      {isReachable && (
                        <div className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-emerald-400 border-2 border-background" />
                      )}
                      {isUnreachable && (
                        <div className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-destructive border-2 border-background" />
                      )}
                    </div>

                    {/* Name + host */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{conn.name}</div>
                      <div className="text-[11px] text-muted-foreground/60 truncate">
                        {conn.username}@{conn.host}:{conn.port}
                        {group && (
                          <span className="ml-2 text-muted-foreground/40">· {group.name}</span>
                        )}
                      </div>
                    </div>

                    {/* Status badge */}
                    <div className="shrink-0 w-16 text-center">
                      {isConnected ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-emerald-500">
                          <div className="size-1.5 rounded-full bg-emerald-500" />
                          {t('list.online')}
                        </span>
                      ) : isConnecting ? (
                        <Loader2 className="mx-auto size-3 animate-spin text-amber-500" />
                      ) : isReachable ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-emerald-500">
                          <div className="size-1.5 rounded-full bg-emerald-500" />
                          {t('list.reachable')}
                        </span>
                      ) : isUnreachable ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-destructive">
                          <div className="size-1.5 rounded-full bg-destructive" />
                          {t('list.unreachable')}
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground/40">{t('list.offline')}</span>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      {isConnected && sess ? (
                        <>
                          <Button
                            variant="default"
                            size="sm"
                            className="h-7 px-3 text-xs"
                            onClick={() => handleOpenTerminal(conn.id)}
                          >
                            {t('openTerminal')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-destructive/60 hover:text-destructive hover:bg-destructive/10"
                            onClick={() => void handleDisconnect(sess.id)}
                            title={t('disconnect')}
                          >
                            <Square className="size-3" />
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="default"
                          size="sm"
                          className="h-7 px-3 text-xs"
                          onClick={() => void handleConnect(conn.id)}
                          disabled={isConnecting}
                        >
                          {isConnecting ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <>
                              <Play className="size-3 mr-1" />
                              {t('connect')}
                            </>
                          )}
                        </Button>
                      )}
                      {isTesting ? (
                        <Loader2 className="size-3 animate-spin text-muted-foreground/50" />
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => void handleTest(conn.id)}
                          title={t('testConnection')}
                        >
                          <CheckCircle2 className="size-3 text-muted-foreground/50" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => {
                          setEditingConnection(conn)
                          setShowForm(true)
                        }}
                        title={t('editConnection')}
                      >
                        <Pencil className="size-3 text-muted-foreground/50" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-destructive/50 hover:text-destructive hover:bg-destructive/10"
                        onClick={() => void handleDeleteConnection(conn)}
                        title={t('deleteConnection')}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Connection Dialog */}
      <Dialog
        open={showForm}
        onOpenChange={(open) => {
          if (!open) {
            setShowForm(false)
            setEditingConnection(null)
          }
        }}
      >
        <DialogContent
          className="p-0 gap-0 sm:max-w-sm h-[85vh] max-h-[85vh] flex flex-col"
          showCloseButton={false}
        >
          <SshConnectionForm
            connection={editingConnection}
            groups={groups}
            onClose={() => {
              setShowForm(false)
              setEditingConnection(null)
            }}
            onSaved={() => {
              setShowForm(false)
              setEditingConnection(null)
              toast.success(t('saved'))
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Group Dialog */}
      <SshGroupDialog
        open={groupDialogOpen}
        group={editingGroup}
        onClose={() => {
          setGroupDialogOpen(false)
          setEditingGroup(null)
        }}
      />
    </div>
  )
}
