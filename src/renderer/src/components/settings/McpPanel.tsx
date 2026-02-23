import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import {
  Plus,
  Search,
  Trash2,
  Cable,
  Play,
  Square,
  RefreshCw,
  Terminal,
  Globe,
  Wrench,
  FileText,
  MessageSquare,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { Switch } from '@renderer/components/ui/switch'
import { Separator } from '@renderer/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useMcpStore } from '@renderer/stores/mcp-store'
import type { McpServerConfig, McpTransportType } from '@renderer/lib/mcp/types'

// ─── Transport labels ───

const TRANSPORT_LABELS: Record<McpTransportType, string> = {
  'stdio': 'stdio',
  'sse': 'SSE (Legacy)',
  'streamable-http': 'Streamable HTTP',
}

// ─── Server Config Panel (right side) ───

function ServerConfigPanel({ server }: { server: McpServerConfig }): React.JSX.Element {
  const { t } = useTranslation('settings')
  const updateServer = useMcpStore((s) => s.updateServer)
  const removeServer = useMcpStore((s) => s.removeServer)
  const connectServer = useMcpStore((s) => s.connectServer)
  const disconnectServer = useMcpStore((s) => s.disconnectServer)
  const refreshServerInfo = useMcpStore((s) => s.refreshServerInfo)
  const serverStatuses = useMcpStore((s) => s.serverStatuses)
  const serverTools = useMcpStore((s) => s.serverTools)
  const serverResources = useMcpStore((s) => s.serverResources)
  const serverPrompts = useMcpStore((s) => s.serverPrompts)
  const serverErrors = useMcpStore((s) => s.serverErrors)

  const status = serverStatuses[server.id] ?? 'disconnected'
  const tools = serverTools[server.id] ?? []
  const resources = serverResources[server.id] ?? []
  const prompts = serverPrompts[server.id] ?? []
  const error = serverErrors[server.id]

  // Local state for debounced fields
  const [localName, setLocalName] = useState(server.name)
  const [localDescription, setLocalDescription] = useState(server.description ?? '')
  const [localCommand, setLocalCommand] = useState(server.command ?? '')
  const [localArgs, setLocalArgs] = useState((server.args ?? []).join(' '))
  const [localCwd, setLocalCwd] = useState(server.cwd ?? '')
  const [localEnv, setLocalEnv] = useState(
    server.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') : ''
  )
  const [localUrl, setLocalUrl] = useState(server.url ?? '')
  const [localHeaders, setLocalHeaders] = useState(
    server.headers ? Object.entries(server.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : ''
  )
  const [capTab, setCapTab] = useState<'tools' | 'resources' | 'prompts'>('tools')
  const [connecting, setConnecting] = useState(false)

  // Reset local state when selected server changes
  useEffect(() => {
    setLocalName(server.name)
    setLocalDescription(server.description ?? '')
    setLocalCommand(server.command ?? '')
    setLocalArgs((server.args ?? []).join(' '))
    setLocalCwd(server.cwd ?? '')
    setLocalEnv(
      server.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') : ''
    )
    setLocalUrl(server.url ?? '')
    setLocalHeaders(
      server.headers ? Object.entries(server.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : ''
    )
  }, [server.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh status on mount
  useEffect(() => {
    refreshServerInfo(server.id)
  }, [server.id, refreshServerInfo])

  // Debounced save
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debouncedSave = useCallback(
    (patch: Partial<McpServerConfig>) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        updateServer(server.id, patch)
      }, 500)
    },
    [server.id, updateServer]
  )

  const handleNameChange = (value: string): void => {
    setLocalName(value)
    debouncedSave({ name: value })
  }

  const handleDescriptionChange = (value: string): void => {
    setLocalDescription(value)
    debouncedSave({ description: value })
  }

  const handleTransportChange = (value: McpTransportType): void => {
    updateServer(server.id, { transport: value })
  }

  const handleCommandChange = (value: string): void => {
    setLocalCommand(value)
    debouncedSave({ command: value })
  }

  const handleArgsChange = (value: string): void => {
    setLocalArgs(value)
    debouncedSave({ args: value.trim() ? value.trim().split(/\s+/) : [] })
  }

  const handleCwdChange = (value: string): void => {
    setLocalCwd(value)
    debouncedSave({ cwd: value || undefined })
  }

  const handleEnvChange = (value: string): void => {
    setLocalEnv(value)
    const env: Record<string, string> = {}
    for (const line of value.split('\n')) {
      const eqIdx = line.indexOf('=')
      if (eqIdx > 0) {
        env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim()
      }
    }
    debouncedSave({ env: Object.keys(env).length > 0 ? env : undefined })
  }

  const handleUrlChange = (value: string): void => {
    setLocalUrl(value)
    debouncedSave({ url: value })
  }

  const handleHeadersChange = (value: string): void => {
    setLocalHeaders(value)
    const headers: Record<string, string> = {}
    for (const line of value.split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx > 0) {
        headers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
      }
    }
    debouncedSave({ headers: Object.keys(headers).length > 0 ? headers : undefined })
  }

  const handleConnect = async (): Promise<void> => {
    setConnecting(true)
    try {
      const err = await connectServer(server.id)
      if (err) {
        toast.error(t('mcp.connectionFailed'), { description: err })
      } else {
        toast.success(t('mcp.connectedTo', { name: server.name }))
      }
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    await disconnectServer(server.id)
    toast.success(t('mcp.disconnectedFrom', { name: server.name }))
  }

  const handleToggleEnabled = async (): Promise<void> => {
    const enabled = !server.enabled
    await updateServer(server.id, { enabled })
    if (!enabled && status === 'connected') {
      await disconnectServer(server.id)
    }
  }

  const handleDelete = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('mcp.deleteConfirm', { name: server.name }),
      variant: 'destructive',
    })
    if (!confirmed) return
    await removeServer(server.id)
    toast.success(t('mcp.serverRemoved'))
  }

  const handleRefresh = async (): Promise<void> => {
    await refreshServerInfo(server.id)
    toast.success(t('mcp.refreshed'))
  }

  const isHttp = server.transport === 'sse' || server.transport === 'streamable-http'

  return (
    <div className="flex flex-col h-full overflow-y-auto px-4 py-3">
      {/* Header with name + enabled toggle */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold">{localName}</h3>
          <p className="text-xs text-muted-foreground">{TRANSPORT_LABELS[server.transport]}</p>
        </div>
        <Switch
          checked={server.enabled}
          onCheckedChange={handleToggleEnabled}
        />
      </div>

      <Separator className="mb-4" />

      {/* Name */}
      <section className="space-y-1.5 mb-4">
        <label className="text-xs font-medium">{t('mcp.name')}</label>
        <Input
          value={localName}
          onChange={(e) => handleNameChange(e.target.value)}
          className="h-8 text-xs"
          placeholder={t('mcp.namePlaceholder')}
        />
      </section>

      {/* Description */}
      <section className="space-y-1.5 mb-4">
        <label className="text-xs font-medium">{t('mcp.description')}</label>
        <Input
          value={localDescription}
          onChange={(e) => handleDescriptionChange(e.target.value)}
          className="h-8 text-xs"
          placeholder={t('mcp.descriptionPlaceholder')}
        />
      </section>

      {/* Transport */}
      <section className="space-y-1.5 mb-4">
        <label className="text-xs font-medium">{t('mcp.transport')}</label>
        <Select value={server.transport} onValueChange={handleTransportChange}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stdio" className="text-xs">
              <span className="flex items-center gap-1.5">
                <Terminal className="size-3" /> stdio
              </span>
            </SelectItem>
            <SelectItem value="sse" className="text-xs">
              <span className="flex items-center gap-1.5">
                <Globe className="size-3" /> SSE (Legacy)
              </span>
            </SelectItem>
            <SelectItem value="streamable-http" className="text-xs">
              <span className="flex items-center gap-1.5">
                <Globe className="size-3" /> Streamable HTTP
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </section>

      <Separator className="mb-4" />

      {/* stdio config */}
      {server.transport === 'stdio' && (
        <>
          <section className="space-y-1.5 mb-3">
            <label className="text-xs font-medium">{t('mcp.command')}</label>
            <Input
              value={localCommand}
              onChange={(e) => handleCommandChange(e.target.value)}
              className="h-8 text-xs font-mono"
              placeholder={t('mcp.commandPlaceholder')}
            />
          </section>
          <section className="space-y-1.5 mb-3">
            <label className="text-xs font-medium">{t('mcp.arguments')}</label>
            <Input
              value={localArgs}
              onChange={(e) => handleArgsChange(e.target.value)}
              className="h-8 text-xs font-mono"
              placeholder={t('mcp.argumentsPlaceholder')}
            />
            <p className="text-[10px] text-muted-foreground">{t('mcp.argumentsHint')}</p>
          </section>
          <section className="space-y-1.5 mb-3">
            <label className="text-xs font-medium">{t('mcp.workingDirectory')}</label>
            <Input
              value={localCwd}
              onChange={(e) => handleCwdChange(e.target.value)}
              className="h-8 text-xs font-mono"
              placeholder={t('mcp.workingDirectoryPlaceholder')}
            />
          </section>
          <section className="space-y-1.5 mb-4">
            <label className="text-xs font-medium">{t('mcp.envVars')}</label>
            <Textarea
              value={localEnv}
              onChange={(e) => handleEnvChange(e.target.value)}
              className="text-xs font-mono min-h-[60px]"
              placeholder={t('mcp.envVarsPlaceholder')}
              rows={3}
            />
            <p className="text-[10px] text-muted-foreground">{t('mcp.envVarsHint')}</p>
          </section>
        </>
      )}

      {/* HTTP config (SSE / Streamable HTTP) */}
      {isHttp && (
        <>
          <section className="space-y-1.5 mb-3">
            <label className="text-xs font-medium">{t('mcp.url')}</label>
            <Input
              value={localUrl}
              onChange={(e) => handleUrlChange(e.target.value)}
              className="h-8 text-xs font-mono"
              placeholder={server.transport === 'sse' ? t('mcp.urlPlaceholderSse') : t('mcp.urlPlaceholderHttp')}
            />
          </section>
          <section className="space-y-1.5 mb-3">
            <label className="text-xs font-medium">{t('mcp.headers')}</label>
            <Textarea
              value={localHeaders}
              onChange={(e) => handleHeadersChange(e.target.value)}
              className="text-xs font-mono min-h-[60px]"
              placeholder={t('mcp.headersPlaceholder')}
              rows={3}
            />
            <p className="text-[10px] text-muted-foreground">{t('mcp.headersHint')}</p>
          </section>
          {server.transport === 'streamable-http' && (
            <section className="space-y-1.5 mb-4">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-xs font-medium">{t('mcp.autoFallback')}</label>
                  <p className="text-[10px] text-muted-foreground">
                    {t('mcp.autoFallbackDesc')}
                  </p>
                </div>
                <Switch
                  checked={server.autoFallback !== false}
                  onCheckedChange={(checked) => updateServer(server.id, { autoFallback: checked })}
                />
              </div>
            </section>
          )}
        </>
      )}

      <Separator className="mb-4" />

      {/* Connection control */}
      <section className="flex items-center gap-2 mb-4">
        {status === 'connected' ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={handleDisconnect}
          >
            <Square className="size-3 mr-1" />
            {t('mcp.disconnect')}
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            className="h-7 text-xs"
            onClick={handleConnect}
            disabled={connecting || status === 'connecting'}
          >
            <Play className="size-3 mr-1" />
            {connecting || status === 'connecting' ? t('mcp.connecting') : t('mcp.connect')}
          </Button>
        )}
        {status === 'connected' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={handleRefresh}
          >
            <RefreshCw className="size-3 mr-1" />
            {t('mcp.refresh')}
          </Button>
        )}
        <div className="flex-1" />
        <span
          className={`inline-flex items-center gap-1 text-[10px] ${
            status === 'connected'
              ? 'text-emerald-600 dark:text-emerald-400'
              : status === 'error'
                ? 'text-destructive'
                : status === 'connecting'
                  ? 'text-yellow-600 dark:text-yellow-400'
                  : 'text-muted-foreground'
          }`}
        >
          <span
            className={`size-1.5 rounded-full ${
              status === 'connected'
                ? 'bg-emerald-500'
                : status === 'error'
                  ? 'bg-destructive'
                  : status === 'connecting'
                    ? 'bg-yellow-500 animate-pulse'
                    : 'bg-muted-foreground/30'
            }`}
          />
          {status}
        </span>
      </section>

      {/* Error display */}
      {error && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 mb-4">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {/* Capabilities tabs */}
      {status === 'connected' && (
        <>
          <Separator className="mb-3" />
          <div className="flex items-center gap-1 mb-3">
            {(['tools', 'resources', 'prompts'] as const).map((tab) => {
              const count = tab === 'tools' ? tools.length : tab === 'resources' ? resources.length : prompts.length
              const Icon = tab === 'tools' ? Wrench : tab === 'resources' ? FileText : MessageSquare
              return (
                <button
                  key={tab}
                  onClick={() => setCapTab(tab)}
                  className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                    capTab === tab
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  <Icon className="size-3" />
                  {tab} ({count})
                </button>
              )
            })}
          </div>

          {/* Tools list */}
          {capTab === 'tools' && (
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {tools.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">{t('mcp.noTools')}</p>
              ) : (
                tools.map((tool) => (
                  <div key={tool.name} className="rounded-md border px-2.5 py-2">
                    <p className="text-xs font-medium font-mono">{tool.name}</p>
                    {tool.description && (
                      <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                        {tool.description}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* Resources list */}
          {capTab === 'resources' && (
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {resources.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">{t('mcp.noResources')}</p>
              ) : (
                resources.map((r) => (
                  <div key={r.uri} className="rounded-md border px-2.5 py-2">
                    <p className="text-xs font-medium">{r.name}</p>
                    <p className="text-[10px] text-muted-foreground font-mono">{r.uri}</p>
                    {r.description && (
                      <p className="text-[10px] text-muted-foreground mt-0.5">{r.description}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* Prompts list */}
          {capTab === 'prompts' && (
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {prompts.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">{t('mcp.noPrompts')}</p>
              ) : (
                prompts.map((p) => (
                  <div key={p.name} className="rounded-md border px-2.5 py-2">
                    <p className="text-xs font-medium">{p.name}</p>
                    {p.description && (
                      <p className="text-[10px] text-muted-foreground mt-0.5">{p.description}</p>
                    )}
                    {p.arguments && p.arguments.length > 0 && (
                      <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                        Args: {p.arguments.map((a) => a.name).join(', ')}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}

      <div className="flex-1" />

      {/* Delete */}
      <Separator className="my-4" />
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 self-start"
        onClick={handleDelete}
      >
        <Trash2 className="size-3 mr-1" />
        {t('mcp.deleteServer')}
      </Button>
    </div>
  )
}

// ─── Add Server Dialog ───

function AddServerDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const addServer = useMcpStore((s) => s.addServer)
  const setSelectedServer = useMcpStore((s) => s.setSelectedServer)

  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransportType>('stdio')

  const handleAdd = async (): Promise<void> => {
    const serverName = name.trim() || t('mcp.namePlaceholder')
    const id = await addServer({
      name: serverName,
      enabled: true,
      transport,
      autoFallback: true,
    })
    setSelectedServer(id)
    onOpenChange(false)
    setName('')
    setTransport('stdio')
    toast.success(t('mcp.serverAdded', { name: serverName }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('mcp.addServerTitle')}</DialogTitle>
          <DialogDescription>
            {t('mcp.addServerDesc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">{t('mcp.name')}</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('mcp.namePlaceholder')}
              className="h-8 text-xs"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">{t('mcp.transport')}</label>
            <div className="grid grid-cols-3 gap-2">
              {(['stdio', 'streamable-http', 'sse'] as const).map((tp) => (
                <button
                  key={tp}
                  onClick={() => setTransport(tp)}
                  className={`flex flex-col items-center gap-1 rounded-lg border p-3 text-center transition-colors ${
                    transport === tp
                      ? 'border-primary bg-primary/5'
                      : 'hover:bg-muted/50'
                  }`}
                >
                  {tp === 'stdio' ? (
                    <Terminal className="size-4" />
                  ) : (
                    <Globe className="size-4" />
                  )}
                  <span className="text-[10px] font-medium">{TRANSPORT_LABELS[tp]}</span>
                </button>
              ))}
            </div>
          </div>
          <Button onClick={handleAdd} className="w-full h-8 text-xs">
            {t('mcp.addServer')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Main MCP Panel ───

export function McpPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const servers = useMcpStore((s) => s.servers)
  const selectedServerId = useMcpStore((s) => s.selectedServerId)
  const setSelectedServer = useMcpStore((s) => s.setSelectedServer)
  const loadServers = useMcpStore((s) => s.loadServers)
  const serverStatuses = useMcpStore((s) => s.serverStatuses)
  const refreshAllServers = useMcpStore((s) => s.refreshAllServers)

  const [searchQuery, setSearchQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)

  // Load servers on mount
  useEffect(() => {
    loadServers()
    refreshAllServers()
  }, [loadServers, refreshAllServers])

  // Auto-select first server if none selected
  useEffect(() => {
    if (!selectedServerId && servers.length > 0) {
      setSelectedServer(servers[0].id)
    }
  }, [selectedServerId, servers, setSelectedServer])

  const filteredServers = useMemo(() => {
    if (!searchQuery.trim()) return servers
    const q = searchQuery.toLowerCase()
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.transport.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q)
    )
  }, [servers, searchQuery])

  const selectedServer = servers.find((s) => s.id === selectedServerId)

  const enabledServers = filteredServers.filter((s) => s.enabled)
  const disabledServers = filteredServers.filter((s) => !s.enabled)

  return (
    <div className="flex flex-col h-full">
      <div className="mb-3 shrink-0">
        <h2 className="text-lg font-semibold">{t('mcp.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('mcp.subtitle')}
        </p>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: Server list */}
        <div className="w-52 shrink-0 border-r flex flex-col">
          {/* Search + Add */}
          <div className="flex items-center gap-1 p-2 border-b">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
              <Input
                placeholder={t('mcp.searchServers')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-7 pl-7 text-[11px] bg-transparent border-0 shadow-none focus-visible:ring-0"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setDialogOpen(true)}
              title={t('mcp.addServerTitle')}
            >
              <Plus className="size-4" />
            </Button>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto py-1">
            {enabledServers.length > 0 && (
              <div className="px-2 pt-1.5 pb-1">
                <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider px-1">
                  {t('mcp.enabled')}
                </p>
                {enabledServers.map((srv) => {
                  const status = serverStatuses[srv.id] ?? 'disconnected'
                  return (
                    <button
                      key={srv.id}
                      onClick={() => setSelectedServer(srv.id)}
                      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 mt-0.5 text-left transition-colors ${
                        selectedServerId === srv.id
                          ? 'bg-accent text-accent-foreground'
                          : 'text-foreground/80 hover:bg-muted/60'
                      }`}
                    >
                      <Cable className="size-3.5 shrink-0" />
                      <span className="flex-1 truncate text-xs">{srv.name}</span>
                      <span
                        className={`size-1.5 rounded-full shrink-0 ${
                          status === 'connected'
                            ? 'bg-emerald-500'
                            : status === 'error'
                              ? 'bg-destructive'
                              : 'bg-muted-foreground/30'
                        }`}
                      />
                    </button>
                  )
                })}
              </div>
            )}

            {disabledServers.length > 0 && (
              <div className="px-2 pt-2 pb-1">
                <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider px-1">
                  {t('mcp.disabled')}
                </p>
                {disabledServers.map((srv) => (
                  <button
                    key={srv.id}
                    onClick={() => setSelectedServer(srv.id)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 mt-0.5 text-left transition-colors ${
                      selectedServerId === srv.id
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                  >
                    <Cable className="size-3.5 shrink-0 opacity-50" />
                    <span className="flex-1 truncate text-xs">{srv.name}</span>
                  </button>
                ))}
              </div>
            )}

            {filteredServers.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <Cable className="size-8 mb-2 opacity-30" />
                <p className="text-xs">{t('mcp.noServers')}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 h-7 text-xs"
                  onClick={() => setDialogOpen(true)}
                >
                  <Plus className="size-3 mr-1" />
                  {t('mcp.addServer')}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Right: Config panel */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {selectedServer ? (
            <ServerConfigPanel server={selectedServer} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('mcp.selectToConfig')}
            </div>
          )}
        </div>
      </div>

      <AddServerDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  )
}
