import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeftRight, Copy, MoreHorizontal, Plus } from 'lucide-react'
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
  readStorage,
  writeStorage,
  makeId,
  SectionCard,
  Field,
  EmptyState
} from './ssh-workspace-shared'

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

type ForwardForm = Omit<ForwardRule, 'id'>
const FORWARDING_STORAGE_KEY = 'ssh-workspace-forwarding-rules'
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
              {t('workspace.personalVault', { defaultValue: 'Host profile' })}
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
