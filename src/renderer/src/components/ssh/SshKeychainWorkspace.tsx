import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Usb
} from 'lucide-react'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
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
  KeychainFilter,
  type LocalKeychainRecord,
  ensureLocalSshDir,
  joinFsPath,
  loadLocalKeychainRecords,
  matchesKeychainFilter,
  writeLocalTextFile,
  deleteLocalPath
} from './ssh-local-utils'

type EditorState = {
  label: string
  privateKey: string
  publicKey: string
  certificate: string
}

const FILTERS: Array<{
  key: KeychainFilter
  label: string
  icon: typeof KeyRound
}> = [
  { key: 'key', label: 'KEY', icon: KeyRound },
  { key: 'certificate', label: 'CERTIFICATE', icon: ShieldCheck },
  { key: 'touchId', label: 'TOUCH ID', icon: Smartphone },
  { key: 'fido2', label: 'FIDO2', icon: Usb }
]

function createEditorState(record: LocalKeychainRecord | null): EditorState {
  return {
    label: record?.label ?? '',
    privateKey: record?.privateKey ?? '',
    publicKey: record?.publicKey ?? '',
    certificate: record?.certificate ?? ''
  }
}

function normalizeTextAreaValue(value: string): string {
  const trimmed = value.trim()
  return trimmed ? `${trimmed}\n` : ''
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

export function SshKeychainWorkspace(): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const connections = useSshStore((state) => state.connections)
  const detailConnectionId = useSshStore((state) => state.detailConnectionId)

  const [filter, setFilter] = useState<KeychainFilter>('key')
  const [records, setRecords] = useState<LocalKeychainRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState>(() => createEditorState(null))
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('edit')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportTargetId, setExportTargetId] = useState<string>('')

  const selectedRecord =
    editorMode === 'edit' ? (records.find((record) => record.id === selectedId) ?? null) : null

  const visibleRecords = useMemo(
    () => records.filter((record) => matchesKeychainFilter(record, filter)),
    [filter, records]
  )

  useEffect(() => {
    setExportTargetId(detailConnectionId ?? connections[0]?.id ?? '')
  }, [connections, detailConnectionId])

  const refreshRecords = async (): Promise<void> => {
    setLoading(true)
    try {
      const nextRecords = await loadLocalKeychainRecords()
      setRecords(nextRecords)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refreshRecords()
  }, [])

  useEffect(() => {
    if (editorMode === 'create') return
    if (visibleRecords.some((record) => record.id === selectedId)) return

    const nextRecord = visibleRecords[0] ?? null
    setSelectedId(nextRecord?.id ?? null)
  }, [editorMode, selectedId, visibleRecords])

  useEffect(() => {
    if (editorMode === 'create') return
    setEditor(createEditorState(selectedRecord))
  }, [editorMode, selectedRecord])

  const startCreate = (): void => {
    setEditorMode('create')
    setSelectedId(null)
    setEditor(createEditorState(null))
  }

  const setField = <K extends keyof EditorState>(key: K, value: EditorState[K]): void => {
    setEditor((current) => ({ ...current, [key]: value }))
  }

  const handleSave = async (): Promise<void> => {
    const label = editor.label.trim()
    if (!label) {
      toast.error(
        t('workspace.keychain.labelRequired', {
          defaultValue: 'Please enter key label.'
        })
      )
      return
    }

    setSaving(true)
    try {
      const sshDir = await ensureLocalSshDir()
      const basePath = joinFsPath(sshDir, label)
      const nextPrivatePath = editor.privateKey.trim() ? basePath : null
      const nextPublicPath = editor.publicKey.trim() ? `${basePath}.pub` : null
      const nextCertificatePath = editor.certificate.trim() ? `${basePath}-cert.pub` : null

      if (nextPrivatePath) {
        await writeLocalTextFile(nextPrivatePath, normalizeTextAreaValue(editor.privateKey))
      }
      if (nextPublicPath) {
        await writeLocalTextFile(nextPublicPath, normalizeTextAreaValue(editor.publicKey))
      }
      if (nextCertificatePath) {
        await writeLocalTextFile(nextCertificatePath, normalizeTextAreaValue(editor.certificate))
      }

      const stalePaths = new Set<string>()
      for (const candidate of [
        selectedRecord?.privateKeyPath,
        selectedRecord?.publicKeyPath,
        selectedRecord?.certificatePath
      ]) {
        if (candidate) stalePaths.add(candidate)
      }
      for (const nextPath of [nextPrivatePath, nextPublicPath, nextCertificatePath]) {
        if (nextPath) stalePaths.delete(nextPath)
      }

      if (!editor.privateKey.trim() && selectedRecord?.privateKeyPath) {
        stalePaths.add(selectedRecord.privateKeyPath)
      }
      if (!editor.publicKey.trim() && selectedRecord?.publicKeyPath) {
        stalePaths.add(selectedRecord.publicKeyPath)
      }
      if (!editor.certificate.trim() && selectedRecord?.certificatePath) {
        stalePaths.add(selectedRecord.certificatePath)
      }

      for (const path of stalePaths) {
        await deleteLocalPath(path)
      }

      await refreshRecords()
      setEditorMode('edit')
      setSelectedId(label)
      toast.success(
        t('workspace.keychain.saved', {
          defaultValue: 'Key saved.'
        })
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  const handleExportToHost = async (): Promise<void> => {
    const publicKey = editor.publicKey.trim()
    if (!publicKey) {
      toast.error(
        t('workspace.keychain.publicKeyRequired', {
          defaultValue: 'Public key content is required before exporting to host.'
        })
      )
      return
    }
    if (!exportTargetId) {
      toast.error(
        t('workspace.keychain.exportTargetRequired', {
          defaultValue: 'Please select the SSH host to install the public key.'
        })
      )
      return
    }

    setExporting(true)
    try {
      const result = (await ipcClient.invoke(IPC.SSH_AUTH_INSTALL_PUBLIC_KEY, {
        connectionId: exportTargetId,
        pubKey: publicKey
      })) as { success?: boolean; error?: string }

      if (result.error) {
        toast.error(result.error)
        return
      }

      toast.success(
        t('workspace.keychain.exported', {
          defaultValue: 'Public key installed to target host.'
        })
      )
    } finally {
      setExporting(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!selectedRecord) return

    setSaving(true)
    try {
      for (const path of [
        selectedRecord.privateKeyPath,
        selectedRecord.publicKeyPath,
        selectedRecord.certificatePath
      ]) {
        if (path) await deleteLocalPath(path)
      }
      await refreshRecords()
      setSelectedId(null)
      startCreate()
      toast.success(
        t('workspace.keychain.deleted', {
          defaultValue: 'Key entry deleted.'
        })
      )
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
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((item) => (
              <Button
                key={item.key}
                size="sm"
                className={cn(
                  'h-10 rounded-[14px] px-4 text-[0.8rem] font-semibold',
                  filter === item.key
                    ? 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                    : 'border border-border bg-card text-foreground hover:bg-accent'
                )}
                onClick={() => {
                  setFilter(item.key)
                  if (item.key !== 'key' || editorMode !== 'create') return
                }}
              >
                <item.icon className="size-3.5" />
                {item.label}
              </Button>
            ))}

            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="icon-sm"
                className="size-10 rounded-[14px] border-border bg-card text-foreground shadow-none hover:bg-accent"
                onClick={startCreate}
                title={t('workspace.keychain.new', { defaultValue: 'New key' })}
              >
                <Plus className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                className="size-10 rounded-[14px] border-border bg-card text-foreground shadow-none hover:bg-accent"
                onClick={() => void refreshRecords()}
                title={t('list.refresh')}
              >
                <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[1.12rem] font-semibold text-foreground">
                {t('workspace.nav.keychain', { defaultValue: 'Keychain' })}
              </div>
              <div className="mt-1 text-[0.82rem] text-muted-foreground">
                {t('workspace.keychain.subtitle', {
                  defaultValue: 'Manage keys, public keys and certificates in local ~/.ssh.'
                })}
              </div>
            </div>
            <div className="rounded-full bg-card px-3 py-2 text-[0.76rem] font-medium text-muted-foreground shadow-[0_10px_24px_-18px_color-mix(in_srgb,var(--foreground)_18%,transparent)]">
              {visibleRecords.length} {t('workspace.keychain.items', { defaultValue: 'items' })}
            </div>
          </div>

          {loading ? (
            <div className="flex min-h-[280px] items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : visibleRecords.length === 0 ? (
            <div className="mt-5 flex min-h-[320px] flex-col items-center justify-center rounded-[28px] border border-dashed border-border bg-card/62 px-8 text-center">
              <div className="flex size-16 items-center justify-center rounded-[22px] bg-primary/12 text-primary shadow-[0_14px_30px_-20px_color-mix(in_srgb,var(--primary)_25%,transparent)]">
                <KeyRound className="size-7" />
              </div>
              <div className="mt-5 text-[1.1rem] font-semibold text-foreground">
                {t('workspace.keychain.emptyTitle', {
                  defaultValue: 'No matching credentials yet.'
                })}
              </div>
              <div className="mt-2 max-w-sm text-[0.88rem] text-muted-foreground">
                {t('workspace.keychain.emptyBody', {
                  defaultValue:
                    'Create a new key entry, or place existing private/public keys in the local ~/.ssh directory.'
                })}
              </div>
              <Button
                size="sm"
                className="mt-6 h-11 rounded-2xl bg-primary px-5 text-[0.88rem] font-semibold text-primary-foreground hover:bg-primary/90"
                onClick={startCreate}
              >
                <Plus className="size-4" />
                {t('workspace.keychain.new', { defaultValue: 'New key' })}
              </Button>
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              {visibleRecords.map((record) => {
                const active = editorMode === 'edit' && selectedId === record.id
                const subtitle = record.isFido2
                  ? 'FIDO2'
                  : record.isTouchId
                    ? 'Touch ID'
                    : record.certificatePath
                      ? 'Certificate'
                      : 'RSA / OpenSSH'

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
                      'shadow-[0_18px_44px_-30px_color-mix(in_srgb,var(--foreground)_20%,transparent)] hover:-translate-y-0.5 hover:border-primary/25',
                      active
                        ? 'border-primary shadow-[0_18px_40px_-24px_color-mix(in_srgb,var(--primary)_28%,transparent)]'
                        : 'border-border'
                    )}
                  >
                    <div className="flex size-12 shrink-0 items-center justify-center rounded-[16px] bg-primary text-primary-foreground shadow-[0_16px_30px_-18px_color-mix(in_srgb,var(--primary)_32%,transparent)]">
                      {record.isFido2 ? (
                        <Usb className="size-5" />
                      ) : record.isTouchId ? (
                        <Smartphone className="size-5" />
                      ) : record.certificatePath ? (
                        <ShieldCheck className="size-5" />
                      ) : (
                        <KeyRound className="size-5" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[1rem] font-semibold text-foreground">
                        {record.label}
                      </div>
                      <div className="mt-1 truncate text-[0.82rem] text-muted-foreground">
                        {subtitle}
                      </div>
                    </div>
                    {record.publicKey ? (
                      <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
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
                ? t('workspace.keychain.new', { defaultValue: 'New key' })
                : t('workspace.keychain.edit', { defaultValue: 'Edit key' })}
            </div>
            <div className="mt-1 text-[0.8rem] text-muted-foreground">
              {t('workspace.personalVault', { defaultValue: 'Personal vault' })}
            </div>
          </div>
          <div className="flex items-center gap-2 text-foreground">
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center rounded-[12px] hover:bg-accent"
              title={t('common.more', { defaultValue: 'More' })}
            >
              <MoreHorizontal className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <SectionCard title={t('workspace.keychain.meta', { defaultValue: 'Key content' })}>
            <Field label={t('workspace.keychain.label', { defaultValue: 'Label' })}>
              <Input
                value={editor.label}
                onChange={(event) => setField('label', event.target.value)}
                className="h-11 rounded-[14px] border-border bg-card"
                placeholder="id_rsa"
              />
            </Field>
            <Field label={t('workspace.keychain.privateKey', { defaultValue: 'Private key' })}>
              <Textarea
                value={editor.privateKey}
                onChange={(event) => setField('privateKey', event.target.value)}
                className="min-h-[190px] rounded-[14px] border-border bg-card font-mono text-[0.8rem] leading-6"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              />
            </Field>
            <Field label={t('workspace.keychain.publicKey', { defaultValue: 'Public key' })}>
              <Textarea
                value={editor.publicKey}
                onChange={(event) => setField('publicKey', event.target.value)}
                className="min-h-[90px] rounded-[14px] border-border bg-card font-mono text-[0.8rem] leading-6"
                placeholder="ssh-ed25519 AAAA..."
              />
            </Field>
            <Field label={t('workspace.keychain.certificate', { defaultValue: 'Certificate' })}>
              <Textarea
                value={editor.certificate}
                onChange={(event) => setField('certificate', event.target.value)}
                className="min-h-[90px] rounded-[14px] border-border bg-card font-mono text-[0.8rem] leading-6"
                placeholder="ssh-ed25519-cert-v01@openssh.com AAAA..."
              />
            </Field>
          </SectionCard>

          <SectionCard title={t('workspace.keychain.exportTitle', { defaultValue: 'Key export' })}>
            <Field label={t('workspace.keychain.exportTarget', { defaultValue: 'Target host' })}>
              <Select value={exportTargetId} onValueChange={setExportTargetId}>
                <SelectTrigger className="h-11 rounded-[14px] border-border bg-card">
                  <SelectValue
                    placeholder={t('workspace.keychain.chooseHost', {
                      defaultValue: 'Select host to install public key'
                    })}
                  />
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
            <Button
              className="h-11 w-full rounded-[14px] bg-primary text-[0.88rem] font-semibold text-primary-foreground hover:bg-primary/90"
              onClick={() => void handleExportToHost()}
              disabled={exporting || !connections.length}
            >
              {exporting ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('workspace.keychain.exportButton', { defaultValue: 'Export to host' })}
            </Button>
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
