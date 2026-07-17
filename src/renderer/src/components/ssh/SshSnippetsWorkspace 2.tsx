import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Copy, MoreHorizontal, Plus, ScrollText, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@renderer/lib/utils'
import { useSshStore } from '@renderer/stores/ssh-store'
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
  readStorage,
  writeStorage,
  makeId,
  SectionCard,
  Field,
  EmptyState
} from './ssh-workspace-shared'

type SnippetRecord = {
  id: string
  name: string
  connectionId: string
  command: string
  description: string
}

type SnippetForm = Omit<SnippetRecord, 'id'>
const SNIPPET_STORAGE_KEY = 'ssh-workspace-snippets'

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
      <main className="flex min-w-0 flex-1 flex-col border-r border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-10 rounded-[14px] bg-secondary px-4 text-[0.8rem] font-semibold text-secondary-foreground hover:bg-secondary/80"
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
                        ? 'border-primary shadow-[0_18px_40px_-24px_color-mix(in_srgb,var(--primary)_28%,transparent)]'
                        : 'border-border shadow-[0_18px_44px_-30px_color-mix(in_srgb,var(--foreground)_18%,transparent)] hover:border-primary/30'
                    )}
                  >
                    <div className="flex size-12 shrink-0 items-center justify-center rounded-[16px] bg-primary text-primary-foreground shadow-[0_16px_30px_-18px_color-mix(in_srgb,var(--primary)_32%,transparent)]">
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
              {t('workspace.personalVault', { defaultValue: 'Host profile' })}
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
