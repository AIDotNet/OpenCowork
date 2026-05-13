import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeftRight,
  CheckCircle2,
  Copy,
  Fingerprint,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ScrollText,
  Terminal
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@renderer/lib/utils'
import { useSshStore } from '@renderer/stores/ssh-store'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Textarea } from '@renderer/components/ui/textarea'
import {
  type KnownHostRecord,
  parseKnownHosts,
  readKnownHostsFile,
  writeLocalTextFile
} from './ssh-local-utils'

type ForwardRule = {
  id: string
  name: string
  connectionId: string
  type: 'local' | 'remote' | 'dynamic'
  localPort: string
  remoteHost: string
  remotePort: string
  description: string
}

type SnippetRecord = {
  id: string
  name: string
  connectionId: string
  command: string
  description: string
}

type ForwardForm = Omit<ForwardRule, 'id'>
type SnippetForm = Omit<SnippetRecord, 'id'>

const FORWARDING_STORAGE_KEY = 'ssh-workspace-forwarding-rules'
const SNIPPET_STORAGE_KEY = 'ssh-workspace-snippets'

function readStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeStorage<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify(value))
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function SectionCard({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-[24px] border border-border bg-card/88 p-4 shadow-[0_18px_40px_-28px_color-mix(in_srgb,var(--foreground)_18%,transparent)]">
      <div className="mb-3 text-[0.98rem] font-semibold text-foreground">{title}</div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  )
}

function EmptyState({
  icon: Icon,
  title,
  body,
  actionLabel,
  onAction
}: {
  icon: typeof Fingerprint
  title: string
  body: string
  actionLabel?: string
  onAction?: () => void
}): React.JSX.Element {
  return (
    <div className="mt-5 flex min-h-[320px] flex-col items-center justify-center rounded-[28px] border border-dashed border-border bg-card/62 px-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-[22px] bg-primary/12 text-primary shadow-[0_14px_30px_-20px_color-mix(in_srgb,var(--primary)_25%,transparent)]">
        <Icon className="size-7" />
      </div>
      <div className="mt-5 text-[1.1rem] font-semibold text-foreground">{title}</div>
      <div className="mt-2 max-w-sm text-[0.88rem] text-muted-foreground">{body}</div>
      {actionLabel && onAction ? (
        <Button
          size="sm"
          className="mt-6 h-11 rounded-2xl bg-primary px-5 text-[0.88rem] font-semibold text-primary-foreground hover:bg-primary/90"
          onClick={onAction}
        >
          <Plus className="size-4" />
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}

function buildForwardCommand(
  rule: ForwardRule,
  target: { host: string; port: number; username: string }
): string {
  if (rule.type === 'dynamic') {
    return `ssh -D ${rule.localPort} ${target.username}@${target.host} -p ${target.port}`
  }

  const flag = rule.type === 'remote' ? '-R' : '-L'
  return `ssh ${flag} ${rule.localPort}:${rule.remoteHost}:${rule.remotePort} ${target.username}@${target.host} -p ${target.port}`
}

export function SshKnownHostsWorkspace(): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const [loading, setLoading] = useState(true)
  const [path, setPath] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [records, setRecords] = useState<KnownHostRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('edit')
  const [saving, setSaving] = useState(false)

  const selectedRecord =
    editorMode === 'edit' ? (records.find((record) => record.id === selectedId) ?? null) : null

  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await readKnownHostsFile()
      setPath(result.path)
      setLines(result.content.split(/\r?\n/))
      setRecords(result.records)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (editorMode === 'create') return
    if (records.some((record) => record.id === selectedId)) return
    setSelectedId(records[0]?.id ?? null)
  }, [editorMode, records, selectedId])

  useEffect(() => {
    if (editorMode === 'create') return
    setDraft(selectedRecord?.rawLine ?? '')
  }, [editorMode, selectedRecord])

  const handleSave = async (): Promise<void> => {
    const nextLine = draft.trim()
    if (!nextLine) {
      toast.error(
        t('workspace.knownHosts.lineRequired', {
          defaultValue: 'Please enter known_hosts entry content.'
        })
      )
      return
    }

    setSaving(true)
    try {
      const nextLines = [...lines]
      if (editorMode === 'edit' && selectedRecord) {
        nextLines[selectedRecord.lineNumber - 1] = nextLine
      } else {
        nextLines.push(nextLine)
      }

      const content = `${nextLines
        .filter((line) => line !== undefined)
        .join('\n')
        .trimEnd()}\n`
      await writeLocalTextFile(path, content)
      await refresh()
      const nextRecords = parseKnownHosts(content)
      const match = nextRecords.find((record) => record.rawLine.trim() === nextLine)
      setEditorMode('edit')
      setSelectedId(match?.id ?? nextRecords[0]?.id ?? null)
      toast.success(
        t('workspace.knownHosts.saved', {
          defaultValue: 'Known hosts saved.'
        })
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!selectedRecord) return
    setSaving(true)
    try {
      const nextLines = lines.filter((_, index) => index !== selectedRecord.lineNumber - 1)
      const content = nextLines.filter(Boolean).join('\n')
      await writeLocalTextFile(path, content ? `${content}\n` : '')
      await refresh()
      setEditorMode('create')
      setSelectedId(null)
      setDraft('')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      <main className="flex min-w-0 flex-1 flex-col border-r border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-10 rounded-[14px] bg-secondary px-4 text-[0.8rem] font-semibold text-secondary-foreground hover:bg-secondary/80"
              onClick={() => {
                setEditorMode('create')
                setSelectedId(null)
                setDraft('')
              }}
            >
              <Plus className="size-3.5" />
              {t('workspace.knownHosts.new', { defaultValue: 'Add entry' })}
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              className="ml-auto size-10 rounded-[14px] border-border bg-card text-foreground shadow-none hover:bg-accent"
              onClick={() => void refresh()}
              title={t('list.refresh')}
            >
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[1.12rem] font-semibold text-foreground">
                {t('workspace.nav.knownHosts', { defaultValue: 'Known Hosts' })}
              </div>
              <div className="mt-1 text-[0.82rem] text-muted-foreground">
                {t('workspace.knownHosts.subtitle', {
                  defaultValue: 'Maintain SSH host fingerprint trust list.'
                })}
              </div>
            </div>
            <div className="rounded-full bg-card px-3 py-2 text-[0.76rem] font-medium text-muted-foreground shadow-[0_10px_24px_-18px_color-mix(in_srgb,var(--foreground)_18%,transparent)]">
              {records.length} {t('workspace.knownHosts.items', { defaultValue: 'entries' })}
            </div>
          </div>

          {loading ? (
            <div className="flex min-h-[280px] items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : records.length === 0 ? (
            <EmptyState
              icon={Fingerprint}
              title={t('workspace.knownHosts.emptyTitle', {
                defaultValue: 'known_hosts is still empty.'
              })}
              body={t('workspace.knownHosts.emptyBody', {
                defaultValue:
                  'After connecting to a new host, or manually writing entries, trusted host fingerprints will appear here.'
              })}
              actionLabel={t('workspace.knownHosts.new', { defaultValue: 'Add entry' })}
              onAction={() => {
                setEditorMode('create')
                setDraft('')
              }}
            />
          ) : (
            <div className="mt-5 space-y-4">
              {records.map((record) => {
                const active = editorMode === 'edit' && record.id === selectedId
                return (
                  <button
                    key={record.id}
                    type="button"
                    onClick={() => {
                      setEditorMode('edit')
                      setSelectedId(record.id)
                    }}
                    className={cn(
                      'flex w-full items-center gap-4 rounded-[22px] border bg-card/92 px-4 py-4 text-left transition-all',
                      active
                        ? 'border-primary shadow-[0_18px_40px_-24px_color-mix(in_srgb,var(--primary)_28%,transparent)]'
                        : 'border-border shadow-[0_18px_44px_-30px_color-mix(in_srgb,var(--foreground)_20%,transparent)] hover:border-primary/25'
                    )}
                  >
                    <div className="flex size-12 shrink-0 items-center justify-center rounded-[16px] bg-primary text-primary-foreground shadow-[0_16px_30px_-18px_color-mix(in_srgb,var(--primary)_32%,transparent)]">
                      <Fingerprint className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[1rem] font-semibold text-foreground">
                        {record.hosts[0] || record.hostField}
                      </div>
                      <div className="mt-1 truncate text-[0.82rem] text-muted-foreground">
                        {record.keyType || 'ssh-rsa'}
                      </div>
                    </div>
                    {record.hashed ? (
                      <Badge
                        variant="outline"
                        className="rounded-full border-border bg-muted/60 px-2 py-1 text-[0.67rem] text-muted-foreground"
                      >
                        {t('workspace.knownHosts.hashed', { defaultValue: 'Hashed' })}
                      </Badge>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </main>

      <aside className="hidden w-[340px] shrink-0 bg-muted/35 lg:flex lg:flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-4">
          <div>
            <div className="text-[1.12rem] font-semibold text-foreground">
              {editorMode === 'create'
                ? t('workspace.knownHosts.new', { defaultValue: 'Add entry' })
                : t('workspace.knownHosts.edit', { defaultValue: 'Edit entry' })}
            </div>
            <div className="mt-1 text-[0.8rem] text-muted-foreground">{path}</div>
          </div>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-[12px] text-foreground hover:bg-accent"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <SectionCard title={t('workspace.knownHosts.raw', { defaultValue: 'Raw entry' })}>
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-[260px] rounded-[14px] border-border bg-card font-mono text-[0.8rem] leading-6"
              placeholder="example.com ssh-ed25519 AAAA..."
            />
          </SectionCard>
        </div>

        <div className="border-t border-border px-4 py-4">
          <div className="flex gap-3">
            {selectedRecord ? (
              <Button
                variant="outline"
                className="h-11 flex-1 rounded-[14px] border-border bg-card text-foreground hover:bg-accent"
                onClick={() => void handleDelete()}
                disabled={saving}
              >
                {t('delete')}
              </Button>
            ) : null}
            <Button
              className="h-11 flex-1 rounded-[14px] bg-primary text-[0.88rem] font-semibold text-primary-foreground hover:bg-primary/90"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('save')}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  )
}

export function SshPortForwardingWorkspace(): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const connections = useSshStore((state) => state.connections)
  const [rules, setRules] = useState<ForwardRule[]>(() =>
    readStorage<ForwardRule[]>(FORWARDING_STORAGE_KEY, [])
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<ForwardForm>({
    name: '',
    connectionId: '',
    type: 'local',
    localPort: '8080',
    remoteHost: '127.0.0.1',
    remotePort: '80',
    description: ''
  })
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create')

  const selectedRule = rules.find((rule) => rule.id === selectedId) ?? null
  const defaultConnectionId = connections[0]?.id ?? ''
  const effectiveConnectionId = form.connectionId || defaultConnectionId

  const saveRules = (nextRules: ForwardRule[]): void => {
    setRules(nextRules)
    writeStorage(FORWARDING_STORAGE_KEY, nextRules)
  }

  const resetForm = (): void => {
    setEditorMode('create')
    setSelectedId(null)
    setForm({
      name: '',
      connectionId: defaultConnectionId,
      type: 'local',
      localPort: '8080',
      remoteHost: '127.0.0.1',
      remotePort: '80',
      description: ''
    })
  }

  const handleSave = (): void => {
    if (!form.name.trim() || !effectiveConnectionId) {
      toast.error(
        t('workspace.forwarding.required', {
          defaultValue: 'Please fill in the name and select a host.'
        })
      )
      return
    }

    const nextRule: ForwardRule = {
      id: selectedRule?.id ?? makeId('forward'),
      ...form,
      connectionId: effectiveConnectionId,
      name: form.name.trim()
    }
    const nextRules =
      editorMode === 'edit' && selectedRule
        ? rules.map((rule) => (rule.id === selectedRule.id ? nextRule : rule))
        : [nextRule, ...rules]

    saveRules(nextRules)
    setEditorMode('edit')
    setSelectedId(nextRule.id)
    toast.success(
      t('workspace.forwarding.saved', {
        defaultValue: 'Port forwarding template saved.'
      })
    )
  }

  const handleDelete = (): void => {
    if (!selectedRule) return
    const nextRules = rules.filter((rule) => rule.id !== selectedRule.id)
    saveRules(nextRules)
    resetForm()
  }

  const commandPreview = useMemo(() => {
    const target = connections.find((connection) => connection.id === effectiveConnectionId)
    if (!target) return ''
    return buildForwardCommand(
      {
        id: selectedRule?.id ?? 'preview',
        ...form,
        connectionId: effectiveConnectionId
      },
      target
    )
  }, [connections, effectiveConnectionId, form, selectedRule?.id])

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      <main className="flex min-w-0 flex-1 flex-col border-r border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-10 rounded-[14px] bg-secondary px-4 text-[0.8rem] font-semibold text-secondary-foreground hover:bg-secondary/80"
              onClick={resetForm}
            >
              <Plus className="size-3.5" />
              {t('workspace.forwarding.new', { defaultValue: 'Add rule' })}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[1.12rem] font-semibold text-foreground">
                {t('workspace.nav.forwarding', { defaultValue: 'Port Forwarding' })}
              </div>
              <div className="mt-1 text-[0.82rem] text-muted-foreground">
                {t('workspace.forwarding.subtitle', {
                  defaultValue: 'Save reusable SSH port forwarding templates.'
                })}
              </div>
            </div>
            <div className="rounded-full bg-card px-3 py-2 text-[0.76rem] font-medium text-muted-foreground shadow-[0_10px_24px_-18px_color-mix(in_srgb,var(--foreground)_18%,transparent)]">
              {rules.length} {t('workspace.forwarding.items', { defaultValue: 'rules' })}
            </div>
          </div>

          {rules.length === 0 ? (
            <EmptyState
              icon={ArrowLeftRight}
              title={t('workspace.forwarding.emptyTitle', {
                defaultValue: 'No saved port forwarding templates yet.'
              })}
              body={t('workspace.forwarding.emptyBody', {
                defaultValue:
                  'Common local forwarding, remote forwarding and SOCKS proxies can all be configured here.'
              })}
              actionLabel={t('workspace.forwarding.new', { defaultValue: 'Add rule' })}
              onAction={resetForm}
            />
          ) : (
            <div className="mt-5 space-y-4">
              {rules.map((rule) => {
                const target = connections.find((connection) => connection.id === rule.connectionId)
                const active = rule.id === selectedId && editorMode === 'edit'

                return (
                  <button
                    key={rule.id}
                    type="button"
                    onClick={() => {
                      setEditorMode('edit')
                      setSelectedId(rule.id)
                      const { id: _id, ...nextForm } = rule
                      void _id
                      setForm(nextForm)
                    }}
                    className={cn(
                      'flex w-full items-center gap-4 rounded-[22px] border bg-card/92 px-4 py-4 text-left transition-all',
                      active
                        ? 'border-primary shadow-[0_18px_40px_-24px_color-mix(in_srgb,var(--primary)_28%,transparent)]'
                        : 'border-border shadow-[0_18px_44px_-30px_color-mix(in_srgb,var(--foreground)_20%,transparent)] hover:border-primary/25'
                    )}
                  >
                    <div className="flex size-12 shrink-0 items-center justify-center rounded-[16px] bg-primary text-primary-foreground shadow-[0_16px_30px_-18px_color-mix(in_srgb,var(--primary)_32%,transparent)]">
                      <ArrowLeftRight className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[1rem] font-semibold text-foreground">
                        {rule.name}
                      </div>
                      <div className="mt-1 truncate text-[0.82rem] text-muted-foreground">
                        {target?.name || 'SSH'} · {rule.type.toUpperCase()}
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className="rounded-full border-border bg-muted/60 px-2 py-1 text-[0.67rem] text-muted-foreground"
                    >
                      {rule.localPort}
                    </Badge>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </main>

      <aside className="hidden w-[340px] shrink-0 bg-muted/35 lg:flex lg:flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-4">
          <div>
            <div className="text-[1.12rem] font-semibold text-foreground">
              {editorMode === 'edit'
                ? t('workspace.forwarding.edit', { defaultValue: 'Edit rule' })
                : t('workspace.forwarding.new', { defaultValue: 'Add rule' })}
            </div>
            <div className="mt-1 text-[0.8rem] text-muted-foreground">
              {t('workspace.personalVault', { defaultValue: 'Personal vault' })}
            </div>
          </div>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-[12px] text-foreground hover:bg-accent"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <SectionCard title={t('workspace.forwarding.meta', { defaultValue: 'Rule info' })}>
            <Field label={t('workspace.forwarding.name', { defaultValue: 'Label' })}>
              <Input
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
                className="h-11 rounded-[14px] border-border bg-card"
                placeholder="Admin tunnel"
              />
            </Field>
            <Field label={t('workspace.forwarding.host', { defaultValue: 'Host' })}>
              <Select
                value={effectiveConnectionId}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, connectionId: value }))
                }
              >
                <SelectTrigger className="h-11 rounded-[14px] border-border bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {connections.map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('workspace.forwarding.type', { defaultValue: 'Type' })}>
              <Select
                value={form.type}
                onValueChange={(value: ForwardRule['type']) =>
                  setForm((current) => ({ ...current, type: value }))
                }
              >
                <SelectTrigger className="h-11 rounded-[14px] border-border bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local (-L)</SelectItem>
                  <SelectItem value="remote">Remote (-R)</SelectItem>
                  <SelectItem value="dynamic">Dynamic (-D)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('workspace.forwarding.localPort', { defaultValue: 'Local port' })}>
                <Input
                  value={form.localPort}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, localPort: event.target.value }))
                  }
                  className="h-11 rounded-[14px] border-border bg-card"
                />
              </Field>
              <Field label={t('workspace.forwarding.remotePort', { defaultValue: 'Remote port' })}>
                <Input
                  value={form.remotePort}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, remotePort: event.target.value }))
                  }
                  className="h-11 rounded-[14px] border-border bg-card"
                />
              </Field>
            </div>
            {form.type !== 'dynamic' ? (
              <Field label={t('workspace.forwarding.remoteHost', { defaultValue: 'Remote host' })}>
                <Input
                  value={form.remoteHost}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, remoteHost: event.target.value }))
                  }
                  className="h-11 rounded-[14px] border-border bg-card"
                />
              </Field>
            ) : null}
            <Field label={t('workspace.forwarding.note', { defaultValue: 'Description' })}>
              <Textarea
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
                className="min-h-[90px] rounded-[14px] border-border bg-card"
              />
            </Field>
          </SectionCard>

          <SectionCard
            title={t('workspace.forwarding.command', { defaultValue: 'Command preview' })}
          >
            <div className="rounded-[18px] border border-border bg-muted/45 p-3 font-mono text-[0.78rem] leading-6 text-foreground">
              {commandPreview || 'ssh -L 8080:127.0.0.1:80 user@example.com -p 22'}
            </div>
            <Button
              variant="outline"
              className="h-11 w-full rounded-[14px] border-border bg-card text-foreground hover:bg-accent"
              onClick={() => {
                navigator.clipboard.writeText(commandPreview)
                toast.success(
                  t('workspace.forwarding.copied', {
                    defaultValue: 'Port forwarding command copied.'
                  })
                )
              }}
              disabled={!commandPreview}
            >
              <Copy className="size-4" />
              {t('copy')}
            </Button>
          </SectionCard>
        </div>

        <div className="border-t border-border px-4 py-4">
          <div className="flex gap-3">
            {selectedRule ? (
              <Button
                variant="outline"
                className="h-11 flex-1 rounded-[14px] border-border bg-card text-foreground hover:bg-accent"
                onClick={handleDelete}
              >
                {t('delete')}
              </Button>
            ) : null}
            <Button
              className="h-11 flex-1 rounded-[14px] bg-primary text-[0.88rem] font-semibold text-primary-foreground hover:bg-primary/90"
              onClick={handleSave}
            >
              {t('save')}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  )
}

export function SshSnippetsWorkspace(): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const connections = useSshStore((state) => state.connections)
  const [snippets, setSnippets] = useState<SnippetRecord[]>(() =>
    readStorage<SnippetRecord[]>(SNIPPET_STORAGE_KEY, [])
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<SnippetForm>({
    name: '',
    connectionId: '',
    command: '',
    description: ''
  })
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create')

  const selectedSnippet = snippets.find((snippet) => snippet.id === selectedId) ?? null
  const defaultConnectionId = connections[0]?.id ?? ''
  const effectiveConnectionId = form.connectionId || defaultConnectionId

  const saveSnippets = (nextSnippets: SnippetRecord[]): void => {
    setSnippets(nextSnippets)
    writeStorage(SNIPPET_STORAGE_KEY, nextSnippets)
  }

  const resetForm = (): void => {
    setEditorMode('create')
    setSelectedId(null)
    setForm({
      name: '',
      connectionId: defaultConnectionId,
      command: '',
      description: ''
    })
  }

  const handleSave = (): void => {
    if (!form.name.trim() || !form.command.trim()) {
      toast.error(
        t('workspace.snippets.required', {
          defaultValue: 'Please fill in the name and command content.'
        })
      )
      return
    }

    const nextSnippet: SnippetRecord = {
      id: selectedSnippet?.id ?? makeId('snippet'),
      ...form,
      connectionId: effectiveConnectionId,
      name: form.name.trim(),
      command: form.command.trim()
    }
    const nextSnippets =
      editorMode === 'edit' && selectedSnippet
        ? snippets.map((snippet) => (snippet.id === selectedSnippet.id ? nextSnippet : snippet))
        : [nextSnippet, ...snippets]

    saveSnippets(nextSnippets)
    setEditorMode('edit')
    setSelectedId(nextSnippet.id)
    toast.success(
      t('workspace.snippets.saved', {
        defaultValue: 'Snippet saved.'
      })
    )
  }

  const handleDelete = (): void => {
    if (!selectedSnippet) return
    const nextSnippets = snippets.filter((snippet) => snippet.id !== selectedSnippet.id)
    saveSnippets(nextSnippets)
    resetForm()
  }

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      <main className="flex min-w-0 flex-1 flex-col border-r border-[#d7dee8] bg-[#eef2f6]">
        <div className="border-b border-[#d7dee8] px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-10 rounded-[14px] bg-[#59627b] px-4 text-[0.8rem] font-semibold text-white hover:bg-[#50586f]"
              onClick={resetForm}
            >
              <Plus className="size-3.5" />
              {t('workspace.snippets.new', { defaultValue: 'Add snippet' })}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[1.12rem] font-semibold text-foreground">
                {t('workspace.nav.snippets', { defaultValue: 'Snippets' })}
              </div>
              <div className="mt-1 text-[0.82rem] text-muted-foreground">
                {t('workspace.snippets.subtitle', {
                  defaultValue: 'Save common remote command snippets and ops scripts.'
                })}
              </div>
            </div>
            <div className="rounded-full bg-secondary px-3 py-2 text-[0.76rem] font-medium text-secondary-foreground shadow-sm">
              {snippets.length} {t('workspace.snippets.items', { defaultValue: 'snippets' })}
            </div>
          </div>

          {snippets.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title={t('workspace.snippets.emptyTitle', {
                defaultValue: 'No saved command snippets yet.'
              })}
              body={t('workspace.snippets.emptyBody', {
                defaultValue:
                  'Store common restart, deploy, troubleshoot commands here for quick reuse.'
              })}
              actionLabel={t('workspace.snippets.new', { defaultValue: 'Add snippet' })}
              onAction={resetForm}
            />
          ) : (
            <div className="mt-5 space-y-4">
              {snippets.map((snippet) => {
                const target = connections.find(
                  (connection) => connection.id === snippet.connectionId
                )
                const active = snippet.id === selectedId && editorMode === 'edit'

                return (
                  <button
                    key={snippet.id}
                    type="button"
                    onClick={() => {
                      setEditorMode('edit')
                      setSelectedId(snippet.id)
                      const { id: _id, ...nextForm } = snippet
                      void _id
                      setForm(nextForm)
                    }}
                    className={cn(
                      'flex w-full items-center gap-4 rounded-[22px] border bg-card px-4 py-4 text-left transition-all',
                      active
                        ? 'border-primary shadow-[0_18px_40px_rgba(47,140,243,0.16)]'
                        : 'border-border shadow-[0_18px_44px_rgba(98,116,146,0.08)] hover:border-primary/30'
                    )}
                  >
                    <div className="flex size-12 shrink-0 items-center justify-center rounded-[16px] bg-primary text-primary-foreground shadow-[0_16px_30px_rgba(10,93,150,0.25)]">
                      <Terminal className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[1rem] font-semibold text-foreground">
                        {snippet.name}
                      </div>
                      <div className="mt-1 truncate text-[0.82rem] text-muted-foreground">
                        {target?.name || 'SSH'} · {snippet.command}
                      </div>
                    </div>
                    <CheckCircle2 className="size-4 shrink-0 text-primary" />
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </main>

      <aside className="hidden w-[340px] shrink-0 bg-muted/30 lg:flex lg:flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-4">
          <div>
            <div className="text-[1.12rem] font-semibold text-foreground">
              {editorMode === 'edit'
                ? t('workspace.snippets.edit', { defaultValue: 'Edit snippet' })
                : t('workspace.snippets.new', { defaultValue: 'Add snippet' })}
            </div>
            <div className="mt-1 text-[0.8rem] text-muted-foreground">
              {t('workspace.personalVault', { defaultValue: 'Personal vault' })}
            </div>
          </div>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-[12px] text-muted-foreground hover:bg-muted"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <SectionCard title={t('workspace.snippets.meta', { defaultValue: 'Snippet info' })}>
            <Field label={t('workspace.snippets.name', { defaultValue: 'Label' })}>
              <Input
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
                className="h-11 rounded-[14px] border-border bg-background"
              />
            </Field>
            <Field label={t('workspace.snippets.host', { defaultValue: 'Host' })}>
              <Select
                value={effectiveConnectionId}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, connectionId: value }))
                }
              >
                <SelectTrigger className="h-11 rounded-[14px] border-border bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {connections.map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('workspace.snippets.command', { defaultValue: 'Command' })}>
              <Textarea
                value={form.command}
                onChange={(event) =>
                  setForm((current) => ({ ...current, command: event.target.value }))
                }
                className="min-h-[140px] rounded-[14px] border-border bg-background font-mono text-[0.82rem]"
                placeholder="systemctl restart nginx"
              />
            </Field>
            <Field label={t('workspace.snippets.note', { defaultValue: 'Description' })}>
              <Textarea
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
                className="min-h-[90px] rounded-[14px] border-border bg-background"
              />
            </Field>
          </SectionCard>

          <SectionCard title={t('workspace.snippets.actions', { defaultValue: 'Quick actions' })}>
            <Button
              variant="outline"
              className="h-11 w-full rounded-[14px] border-border bg-background text-muted-foreground hover:bg-muted"
              onClick={() => {
                navigator.clipboard.writeText(form.command)
                toast.success(
                  t('workspace.snippets.copied', {
                    defaultValue: 'Command snippet copied.'
                  })
                )
              }}
              disabled={!form.command.trim()}
            >
              <Copy className="size-4" />
              {t('copy')}
            </Button>
          </SectionCard>
        </div>

        <div className="border-t border-border px-4 py-4">
          <div className="flex gap-3">
            {selectedSnippet ? (
              <Button
                variant="outline"
                className="h-11 flex-1 rounded-[14px] border-border bg-background text-muted-foreground hover:bg-muted"
                onClick={handleDelete}
              >
                {t('delete')}
              </Button>
            ) : null}
            <Button
              className="h-11 flex-1 rounded-[14px] bg-primary text-[0.88rem] font-semibold text-primary-foreground hover:bg-primary/90"
              onClick={handleSave}
            >
              {t('save')}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  )
}

export function SshLogsWorkspace(): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const connections = useSshStore((state) => state.connections)
  const sessions = useSshStore((state) => state.sessions)
  const transferTasks = useSshStore((state) => state.transferTasks)

  const liveSessions = useMemo(
    () =>
      Object.values(sessions)
        .map((session) => ({
          ...session,
          connection:
            connections.find((connection) => connection.id === session.connectionId) ?? null
        }))
        .sort((left, right) => left.connectionId.localeCompare(right.connectionId)),
    [connections, sessions]
  )

  const recentConnections = useMemo(
    () =>
      connections
        .filter((connection) => typeof connection.lastConnectedAt === 'number')
        .sort((left, right) => (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0))
        .slice(0, 8),
    [connections]
  )

  const recentUploads = useMemo(
    () =>
      Object.values(transferTasks)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 8),
    [transferTasks]
  )

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            className="size-10 rounded-[14px] border-border bg-card text-foreground shadow-none hover:bg-accent"
            onClick={() => void useSshStore.getState().loadAll()}
            title={t('list.refresh')}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[1.12rem] font-semibold text-foreground">
              {t('workspace.nav.logs', { defaultValue: 'Logs' })}
            </div>
            <div className="mt-1 text-[0.82rem] text-muted-foreground">
              {t('workspace.logs.subtitle', {
                defaultValue:
                  'View recent connections, session status and upload transfer activity.'
              })}
            </div>
          </div>
          <div className="rounded-full bg-card px-3 py-2 text-[0.76rem] font-medium text-muted-foreground shadow-[0_10px_24px_-18px_color-mix(in_srgb,var(--foreground)_18%,transparent)]">
            {liveSessions.length} {t('workspace.logs.live', { defaultValue: 'live sessions' })}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-3">
          <SectionCard title={t('workspace.logs.sessions', { defaultValue: 'Session status' })}>
            {liveSessions.length === 0 ? (
              <div className="text-[0.84rem] text-muted-foreground">
                {t('workspace.logs.noSessions', { defaultValue: 'No active sessions.' })}
              </div>
            ) : (
              liveSessions.map((session) => (
                <div
                  key={session.id}
                  className="rounded-[18px] border border-border bg-muted/45 px-3 py-3"
                >
                  <div className="text-[0.92rem] font-semibold text-foreground">
                    {session.connection?.name ?? session.connectionId}
                  </div>
                  <div className="mt-1 text-[0.8rem] text-muted-foreground">
                    {session.status}
                    {session.error ? ` · ${session.error}` : ''}
                  </div>
                </div>
              ))
            )}
          </SectionCard>

          <SectionCard
            title={t('workspace.logs.connections', { defaultValue: 'Recent connections' })}
          >
            {recentConnections.length === 0 ? (
              <div className="text-[0.84rem] text-muted-foreground">
                {t('workspace.logs.noConnections', { defaultValue: 'No connection history yet.' })}
              </div>
            ) : (
              recentConnections.map((connection) => (
                <div
                  key={connection.id}
                  className="rounded-[18px] border border-border bg-muted/45 px-3 py-3"
                >
                  <div className="text-[0.92rem] font-semibold text-foreground">
                    {connection.name}
                  </div>
                  <div className="mt-1 text-[0.8rem] text-muted-foreground">
                    {new Date(connection.lastConnectedAt ?? 0).toLocaleString()}
                  </div>
                </div>
              ))
            )}
          </SectionCard>

          <SectionCard title={t('workspace.logs.uploads', { defaultValue: 'Upload activity' })}>
            {recentUploads.length === 0 ? (
              <div className="text-[0.84rem] text-muted-foreground">
                {t('workspace.logs.noUploads', { defaultValue: 'No upload activity.' })}
              </div>
            ) : (
              recentUploads.map((task) => (
                <div
                  key={task.taskId}
                  className="rounded-[18px] border border-border bg-muted/45 px-3 py-3"
                >
                  <div className="text-[0.92rem] font-semibold text-foreground">{task.taskId}</div>
                  <div className="mt-1 text-[0.8rem] text-muted-foreground">
                    {task.stage}
                    {task.message ? ` · ${task.message}` : ''}
                  </div>
                </div>
              ))
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  )
}
