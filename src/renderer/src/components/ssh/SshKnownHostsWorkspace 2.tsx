import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Fingerprint, Loader2, MoreHorizontal, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@renderer/lib/utils'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import {
  type KnownHostRecord,
  parseKnownHosts,
  readKnownHostsFile,
  writeLocalTextFile
} from './ssh-local-utils'

import { SectionCard, EmptyState } from './ssh-workspace-shared'

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
