import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpRight,
  CheckCircle2,
  FolderOpen,
  KeyRound,
  LockKeyhole,
  Plus,
  Save,
  Server,
  Terminal,
  Trash2,
  UserCircle2
} from 'lucide-react'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { cn } from '@renderer/lib/utils'
import {
  useSshStore,
  type SshConnection,
  type SshGroup,
  type SshSession
} from '@renderer/stores/ssh-store'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Separator } from '@renderer/components/ui/separator'

interface SshConnectionInspectorProps {
  mode: 'create' | 'edit'
  draftKey: number
  connection: SshConnection | null
  groups: SshGroup[]
  session: SshSession | undefined
  onConnect: (connectionId: string) => void
  onSaved: (connectionId: string) => void
  onDelete: (connection: SshConnection) => void
  onManageGroups: () => void
}

type FormState = {
  name: string
  host: string
  port: string
  username: string
  authType: SshConnection['authType']
  password: string
  privateKeyPath: string
  passphrase: string
  groupId: string
  defaultDirectory: string
  startupCommand: string
  proxyJump: string
  keepAliveInterval: string
}

function joinFsPath(...parts: string[]): string {
  if (parts.length === 0) return ''
  const separator = parts[0]?.includes('\\') ? '\\' : '/'
  const trimTrailing = (value: string): string => {
    let result = value
    while (result.length > 1 && result.endsWith(separator)) {
      result = result.slice(0, -1)
    }
    return result
  }
  const trimBoth = (value: string): string => {
    let result = value
    while (result.startsWith(separator)) {
      result = result.slice(1)
    }
    while (result.endsWith(separator)) {
      result = result.slice(0, -1)
    }
    return result
  }

  return parts
    .filter(Boolean)
    .map((part, index) => {
      const normalized = separator === '\\' ? part.replace(/\//g, '\\') : part.replace(/\\/g, '/')
      if (index === 0) return trimTrailing(normalized)
      return trimBoth(normalized)
    })
    .join(separator)
}

function createInitialState(connection: SshConnection | null): FormState {
  return {
    name: connection?.name ?? '',
    host: connection?.host ?? '',
    port: String(connection?.port ?? 22),
    username: connection?.username ?? '',
    authType: connection?.authType ?? 'password',
    password: '',
    privateKeyPath: connection?.privateKeyPath ?? '',
    passphrase: '',
    groupId: connection?.groupId ?? '__none__',
    defaultDirectory: connection?.defaultDirectory ?? '',
    startupCommand: connection?.startupCommand ?? '',
    proxyJump: connection?.proxyJump ?? '',
    keepAliveInterval: String(connection?.keepAliveInterval ?? 60)
  }
}

function SectionCard({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-[24px] border border-border bg-card/86 px-4 py-4 shadow-[0_16px_40px_-28px_color-mix(in_srgb,var(--foreground)_18%,transparent)] backdrop-blur-sm">
      <div className="mb-3">
        <div className="text-[0.98rem] font-semibold text-foreground">{title}</div>
        {description ? (
          <div className="mt-1 text-[0.73rem] text-muted-foreground">{description}</div>
        ) : null}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Field({
  label,
  hint,
  className,
  children
}: {
  label: string
  hint?: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {label}
        </label>
        {hint ? <span className="text-[0.68rem] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

export function SshConnectionInspector({
  mode,
  draftKey,
  connection,
  groups,
  session,
  onConnect,
  onSaved,
  onDelete,
  onManageGroups
}: SshConnectionInspectorProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const isEditing = mode === 'edit' && !!connection
  const [formState, setFormState] = useState<FormState>(() => createInitialState(connection))
  const [saving, setSaving] = useState(false)
  const [installingKey, setInstallingKey] = useState(false)

  useEffect(() => {
    setFormState(createInitialState(connection))
  }, [connection, draftKey])

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setFormState((current) => ({ ...current, [key]: value }))
  }

  const snapshot = useMemo(
    () =>
      JSON.stringify({
        name: formState.name.trim(),
        host: formState.host.trim(),
        port: formState.port.trim(),
        username: formState.username.trim(),
        authType: formState.authType,
        privateKeyPath: formState.privateKeyPath.trim(),
        groupId: formState.groupId,
        defaultDirectory: formState.defaultDirectory.trim(),
        startupCommand: formState.startupCommand.trim(),
        proxyJump: formState.proxyJump.trim(),
        keepAliveInterval: formState.keepAliveInterval.trim()
      }),
    [formState]
  )

  const initialSnapshot = useMemo(
    () =>
      JSON.stringify({
        name: connection?.name ?? '',
        host: connection?.host ?? '',
        port: String(connection?.port ?? 22),
        username: connection?.username ?? '',
        authType: connection?.authType ?? 'password',
        privateKeyPath: connection?.privateKeyPath ?? '',
        groupId: connection?.groupId ?? '__none__',
        defaultDirectory: connection?.defaultDirectory ?? '',
        startupCommand: connection?.startupCommand ?? '',
        proxyJump: connection?.proxyJump ?? '',
        keepAliveInterval: String(connection?.keepAliveInterval ?? 60)
      }),
    [connection]
  )

  const requirePassword =
    formState.authType === 'password' && (!isEditing || connection?.authType !== 'password')
  const requirePrivateKey =
    formState.authType === 'privateKey' &&
    (!isEditing || connection?.authType !== 'privateKey' || !connection?.privateKeyPath)

  const canSubmit =
    formState.name.trim().length > 0 &&
    formState.host.trim().length > 0 &&
    formState.username.trim().length > 0 &&
    (!requirePassword || formState.password.trim().length > 0) &&
    (!requirePrivateKey || formState.privateKeyPath.trim().length > 0)

  const isDirty =
    mode === 'create'
      ? snapshot !== JSON.stringify(createInitialState(null))
      : snapshot !== initialSnapshot

  const handleSelectKeyFile = async (): Promise<void> => {
    const result = await ipcClient.invoke(IPC.FS_SELECT_FILE)
    if (!result || typeof result !== 'object') return
    if ((result as { canceled?: boolean }).canceled) return
    const filePath = (result as { path?: string }).path
    if (filePath) {
      setField('privateKeyPath', filePath)
    }
  }

  const loadDefaultPublicKey = async (): Promise<
    { pubContent: string; privateKeyPath: string } | { error: string }
  > => {
    const homeResult = await ipcClient.invoke(IPC.APP_HOMEDIR)
    const homeDir =
      homeResult && typeof homeResult === 'object' && 'path' in homeResult
        ? String((homeResult as { path?: string }).path ?? '')
        : String(homeResult ?? '')

    if (!homeDir) return { error: 'Failed to resolve home directory' }

    const sshDir = joinFsPath(homeDir, '.ssh')
    const candidates = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa', 'identity']

    for (const base of candidates) {
      const publicKeyPath = joinFsPath(sshDir, `${base}.pub`)
      const doc = await ipcClient.invoke(IPC.FS_READ_DOCUMENT, { path: publicKeyPath })
      if (
        doc &&
        typeof doc === 'object' &&
        'content' in doc &&
        typeof (doc as { content?: string }).content === 'string'
      ) {
        return {
          pubContent: String((doc as { content: string }).content),
          privateKeyPath: joinFsPath(sshDir, base)
        }
      }
    }

    return { error: 'No public key found under ~/.ssh' }
  }

  const handleCopyPublicKey = async (): Promise<void> => {
    try {
      const result = await loadDefaultPublicKey()
      if ('error' in result) {
        toast.error(t('form.publicKeyLoadFailed'))
        return
      }

      await navigator.clipboard.writeText(result.pubContent)
      setField('privateKeyPath', formState.privateKeyPath || result.privateKeyPath)
      toast.success(t('form.publicKeyCopied'))
    } catch (error) {
      toast.error(String(error))
    }
  }

  const handleInstallPublicKey = async (): Promise<void> => {
    if (!connection?.id) {
      toast.error(t('form.saveBeforeInstallKey'))
      return
    }

    setInstallingKey(true)
    try {
      const result = await loadDefaultPublicKey()
      if ('error' in result) {
        toast.error(t('form.publicKeyLoadFailed'))
        return
      }

      const installResult = await ipcClient.invoke(IPC.SSH_AUTH_INSTALL_PUBLIC_KEY, {
        connectionId: connection.id,
        publicKey: result.pubContent
      })
      if (installResult && typeof installResult === 'object' && 'error' in installResult) {
        toast.error(String((installResult as { error?: string }).error ?? t('form.installFailed')))
        return
      }

      setFormState((current) => ({
        ...current,
        authType: 'privateKey',
        privateKeyPath: current.privateKeyPath || result.privateKeyPath
      }))
      toast.success(t('form.publicKeyInstalled'))
    } finally {
      setInstallingKey(false)
    }
  }

  const persistConnection = async (): Promise<string | null> => {
    if (!canSubmit) return null

    const payload = {
      name: formState.name.trim(),
      host: formState.host.trim(),
      port: parseInt(formState.port, 10) || 22,
      username: formState.username.trim(),
      authType: formState.authType,
      groupId: formState.groupId === '__none__' ? undefined : formState.groupId,
      defaultDirectory: formState.defaultDirectory.trim() || undefined,
      startupCommand: formState.startupCommand.trim() || undefined,
      proxyJump: formState.proxyJump.trim() || undefined,
      keepAliveInterval: parseInt(formState.keepAliveInterval, 10) || 60
    }

    setSaving(true)
    try {
      if (isEditing && connection) {
        const updateData: Record<string, unknown> = {
          ...payload,
          groupId: formState.groupId === '__none__' ? null : formState.groupId
        }
        if (formState.password) updateData.password = formState.password
        if (formState.privateKeyPath) updateData.privateKeyPath = formState.privateKeyPath
        if (formState.passphrase) updateData.passphrase = formState.passphrase

        await useSshStore.getState().updateConnection(connection.id, updateData)
        onSaved(connection.id)
        return connection.id
      }

      const id = await useSshStore.getState().createConnection({
        ...payload,
        password: formState.password || undefined,
        privateKeyPath: formState.privateKeyPath.trim() || undefined,
        passphrase: formState.passphrase || undefined
      })
      onSaved(id)
      return id
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    const id = await persistConnection()
    if (!id) return
    toast.success(t('saved'))
  }

  const handlePrimaryAction = async (): Promise<void> => {
    if (session?.status === 'connected' && connection?.id) {
      onConnect(connection.id)
      return
    }

    const id = await persistConnection()
    if (!id) return
    onConnect(id)
  }

  return (
    <div className="flex h-full flex-col bg-muted/35">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[1.1rem] font-semibold text-foreground">
              {t('dashboard.serverDetails', { defaultValue: 'Host Details' })}
            </div>
            <div className="mt-1 text-[0.78rem] text-muted-foreground">
              {isEditing
                ? t('workspace.personalVault', { defaultValue: 'Personal vault' })
                : t('workspace.newHostHint', { defaultValue: 'Create a new SSH host profile' })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {session?.status === 'connected' ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2.5 py-1 text-[0.7rem] font-semibold text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3" />
                {t('list.online')}
              </span>
            ) : null}
            {isEditing && connection ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onDelete(connection)}
                title={t('deleteConnection')}
              >
                <Trash2 className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <SectionCard
          title={t('workspace.addressTitle', { defaultValue: 'Address' })}
          description={t('workspace.addressHint', {
            defaultValue: 'Use the hostname or public IP that your SSH client should dial.'
          })}
        >
          <div className="flex items-center gap-3 rounded-[20px] border border-border bg-muted/45 px-3 py-3">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_12px_24px_-16px_color-mix(in_srgb,var(--primary)_34%,transparent)]">
              <Server className="size-5" />
            </div>
            <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[minmax(0,1fr)_96px]">
              <Field label={t('form.host')}>
                <Input
                  value={formState.host}
                  onChange={(event) => setField('host', event.target.value)}
                  placeholder={t('form.hostPlaceholder')}
                  className="h-11 rounded-2xl border-border bg-card px-4 text-[0.95rem] shadow-none"
                />
              </Field>
              <Field label={t('form.port')}>
                <Input
                  value={formState.port}
                  onChange={(event) => setField('port', event.target.value)}
                  className="h-11 rounded-2xl border-border bg-card px-4 text-[0.95rem] shadow-none"
                  inputMode="numeric"
                />
              </Field>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title={t('workspace.generalTitle', { defaultValue: 'General' })}
          description={t('workspace.generalHint', {
            defaultValue: 'Name the host, assign a group, and define the default working path.'
          })}
        >
          <Field label={t('form.name')}>
            <Input
              value={formState.name}
              onChange={(event) => setField('name', event.target.value)}
              placeholder={t('form.namePlaceholder')}
              className="h-11 rounded-2xl border-border bg-card px-4 shadow-none"
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Field label={t('form.group')}>
              <Select
                value={formState.groupId}
                onValueChange={(value) => setField('groupId', value)}
              >
                <SelectTrigger className="h-11 rounded-2xl border-border bg-card px-4 text-[0.92rem] shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t('form.groupNone')}</SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="flex items-end">
              <Button
                variant="outline"
                size="sm"
                className="h-11 rounded-2xl border-border px-3 text-[0.78rem] text-foreground shadow-none hover:bg-accent"
                onClick={onManageGroups}
              >
                <Plus className="size-3.5" />
                {t('list.addGroup')}
              </Button>
            </div>
          </div>

          <Field
            label={t('form.defaultDirectory')}
            hint={t('workspace.optional', { defaultValue: 'Optional' })}
          >
            <Input
              value={formState.defaultDirectory}
              onChange={(event) => setField('defaultDirectory', event.target.value)}
              placeholder="/home/ubuntu/project"
              className="h-11 rounded-2xl border-border bg-card px-4 shadow-none"
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('form.proxyJump')}
              hint={t('workspace.optional', { defaultValue: 'Optional' })}
            >
              <Input
                value={formState.proxyJump}
                onChange={(event) => setField('proxyJump', event.target.value)}
                placeholder={t('form.proxyJumpPlaceholder')}
                className="h-11 rounded-2xl border-border bg-card px-4 shadow-none"
              />
            </Field>
            <Field label={t('form.keepAlive')}>
              <Input
                value={formState.keepAliveInterval}
                onChange={(event) => setField('keepAliveInterval', event.target.value)}
                className="h-11 rounded-2xl border-border bg-card px-4 shadow-none"
                inputMode="numeric"
              />
            </Field>
          </div>
        </SectionCard>

        <SectionCard
          title={t('workspace.credentialsTitle', { defaultValue: 'Credentials' })}
          description={t('workspace.credentialsHint', {
            defaultValue:
              'Choose how this host authenticates and what user the shell should log in as.'
          })}
        >
          <Field label={t('form.username')}>
            <div className="relative">
              <UserCircle2 className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={formState.username}
                onChange={(event) => setField('username', event.target.value)}
                placeholder={t('form.usernamePlaceholder')}
                className="h-11 rounded-2xl border-border bg-card pl-11 pr-4 shadow-none"
              />
            </div>
          </Field>

          <Field label={t('form.authType')}>
            <Select
              value={formState.authType}
              onValueChange={(value) => setField('authType', value as SshConnection['authType'])}
            >
              <SelectTrigger className="h-11 rounded-2xl border-border bg-card px-4 text-[0.92rem] shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="password">{t('form.authPassword')}</SelectItem>
                <SelectItem value="privateKey">{t('form.authPrivateKey')}</SelectItem>
                <SelectItem value="agent">{t('form.authAgent')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {formState.authType === 'password' ? (
            <Field label={t('form.password')}>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <LockKeyhole className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={formState.password}
                    onChange={(event) => setField('password', event.target.value)}
                    placeholder={isEditing ? '••••••••' : t('form.passwordPlaceholder')}
                    type="password"
                    className="h-11 rounded-2xl border-border bg-card pl-11 pr-4 shadow-none"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 rounded-2xl border-border px-3 text-[0.78rem] text-foreground shadow-none hover:bg-accent"
                  onClick={() => void handleInstallPublicKey()}
                  disabled={!isEditing || installingKey}
                >
                  <KeyRound className="size-3.5" />
                  {t('form.installPublicKey')}
                </Button>
              </div>
            </Field>
          ) : null}

          {formState.authType === 'privateKey' ? (
            <>
              <Field label={t('form.privateKey')}>
                <div className="flex gap-2">
                  <Input
                    value={formState.privateKeyPath}
                    onChange={(event) => setField('privateKeyPath', event.target.value)}
                    placeholder={t('form.privateKeyPlaceholder')}
                    className="h-11 rounded-2xl border-border bg-card px-4 shadow-none"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 rounded-2xl border-border px-3 text-[0.78rem] text-foreground shadow-none hover:bg-accent"
                    onClick={() => void handleSelectKeyFile()}
                  >
                    <FolderOpen className="size-3.5" />
                    {t('form.selectKeyFile')}
                  </Button>
                </div>
              </Field>

              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Field
                  label={t('form.passphrase')}
                  hint={t('workspace.optional', { defaultValue: 'Optional' })}
                >
                  <Input
                    value={formState.passphrase}
                    onChange={(event) => setField('passphrase', event.target.value)}
                    placeholder={t('form.passphrasePlaceholder')}
                    type="password"
                    className="h-11 rounded-2xl border-border bg-card px-4 shadow-none"
                  />
                </Field>
                <div className="flex items-end">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 rounded-2xl border-border px-3 text-[0.78rem] text-foreground shadow-none hover:bg-accent"
                    onClick={() => void handleCopyPublicKey()}
                  >
                    <KeyRound className="size-3.5" />
                    {t('form.autoLoadPublicKey')}
                  </Button>
                </div>
              </div>
            </>
          ) : null}

          <Separator className="bg-border" />

          <Field
            label={t('form.startupCommand')}
            hint={t('workspace.optional', { defaultValue: 'Optional' })}
          >
            <Input
              value={formState.startupCommand}
              onChange={(event) => setField('startupCommand', event.target.value)}
              placeholder={t('form.startupCommandPlaceholder')}
              className="h-11 rounded-2xl border-border bg-card px-4 shadow-none"
            />
          </Field>
        </SectionCard>
      </div>

      <div className="border-t border-border bg-card/70 px-4 py-4">
        <div className="mb-3 flex items-center gap-2 rounded-[18px] bg-muted/70 px-3 py-2 text-[0.76rem] text-muted-foreground">
          <Server className="size-3.5 text-primary" />
          <span className="truncate">
            {formState.host.trim()
              ? `${formState.username || 'root'}@${formState.host}:${parseInt(formState.port, 10) || 22}`
              : t('workspace.hostPreview', { defaultValue: 'SSH host preview will appear here.' })}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-12 flex-1 rounded-2xl border-border bg-card text-[0.86rem] font-medium text-foreground shadow-none hover:bg-accent"
            onClick={() => void handleSave()}
            disabled={!canSubmit || saving || (!isDirty && isEditing)}
          >
            <Save className="size-4" />
            {t('form.save')}
          </Button>
          <Button
            size="sm"
            className={cn(
              'h-12 flex-[1.4] rounded-2xl bg-primary text-[0.9rem] font-semibold text-primary-foreground shadow-[0_16px_32px_-20px_color-mix(in_srgb,var(--primary)_32%,transparent)] hover:bg-primary/90',
              session?.status === 'connected' &&
                'bg-secondary text-secondary-foreground shadow-[0_12px_24px_-18px_color-mix(in_srgb,var(--secondary-foreground)_24%,transparent)] hover:bg-secondary/85'
            )}
            onClick={() => void handlePrimaryAction()}
            disabled={!canSubmit || saving}
          >
            {session?.status === 'connected' ? (
              <>
                <Terminal className="size-4" />
                {t('openTerminal')}
              </>
            ) : (
              <>
                <ArrowUpRight className="size-4" />
                {t('connect')}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
