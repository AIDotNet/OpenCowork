import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpRight,
  Boxes,
  FolderOpen,
  KeyRound,
  Link2,
  LockKeyhole,
  Network,
  Plus,
  Save,
  Server,
  Settings2,
  Terminal,
  Trash2,
  UserCircle2,
  Wrench
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

interface SshConnectionInspectorProps {
  mode: 'create' | 'edit'
  draftKey: number
  connection: SshConnection | null
  groups: SshGroup[]
  session: SshSession | undefined
  showHeader?: boolean
  onCancel?: () => void
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

type InspectorPanel = 'basic' | 'auth' | 'jump' | 'proxy' | 'other' | 'init'

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

function PanelShell({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-[14px] border border-[#414141] bg-[#252525]">
      <div className="border-b border-[#3a3a3a] px-4 py-3">
        <div className="text-[0.98rem] font-semibold text-[#f5f5f5]">{title}</div>
        {description ? (
          <div className="mt-1 text-[0.74rem] text-[#9ca3af]">{description}</div>
        ) : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function SidebarButton({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-[10px] px-3 py-3 text-left text-[0.86rem] transition-colors',
        active
          ? 'bg-[#313131] text-[#f5f5f5]'
          : 'text-[#b6b6b6] hover:bg-[#2b2b2b] hover:text-[#f5f5f5]'
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

export function SshConnectionInspector({
  mode,
  draftKey,
  connection,
  groups,
  session,
  showHeader = true,
  onCancel,
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
  const [activePanel, setActivePanel] = useState<InspectorPanel>('basic')

  useEffect(() => {
    setFormState(createInitialState(connection))
    setActivePanel('basic')
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
  const connectionAddress = connection
    ? `${connection.username}@${connection.host}:${connection.port}`
    : null

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

  const handleTestCurrent = async (): Promise<void> => {
    const id = await persistConnection()
    if (!id) return

    const result = await useSshStore.getState().testConnection(id)
    if (result.success) {
      toast.success(t('connectionSuccess'))
      return
    }

    toast.error(result.error || t('connectionFailed'))
  }

  const navItems: Array<{ key: InspectorPanel; label: string; icon: React.ReactNode }> = [
    { key: 'basic', label: t('workspace.basicInfo', { defaultValue: '基本信息' }), icon: <Link2 className="size-4" /> },
    { key: 'auth', label: t('workspace.connectionSettings', { defaultValue: '连接设置' }), icon: <Server className="size-4" /> },
    { key: 'jump', label: t('workspace.jumpHost', { defaultValue: '跳板机' }), icon: <ArrowUpRight className="size-4" /> },
    { key: 'proxy', label: t('workspace.proxySettings', { defaultValue: '代理设置' }), icon: <Network className="size-4" /> },
    { key: 'other', label: t('workspace.otherSettings', { defaultValue: '其他设置' }), icon: <Settings2 className="size-4" /> },
    { key: 'init', label: t('workspace.initialize', { defaultValue: '初始化' }), icon: <Wrench className="size-4" /> }
  ]

  const authSummary =
    formState.authType === 'password'
      ? t('form.authPassword')
      : formState.authType === 'privateKey'
        ? t('form.authPrivateKey')
        : t('form.authAgent')

  return (
    <div className="flex h-full flex-col bg-[#262626] text-[#f5f5f5]">
      {showHeader ? (
        <div className="border-b border-[#3a3a3a] px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-[1.1rem] font-semibold text-[#f5f5f5]">
                {isEditing && connection
                  ? connection.name
                  : t('dashboard.serverDetails', { defaultValue: 'Host Details' })}
              </div>
              <div className="mt-1 truncate text-[0.78rem] text-[#9ca3af]">
                {isEditing && connectionAddress
                  ? connectionAddress
                  : t('workspace.newHostHint', { defaultValue: 'Create a new SSH host profile' })}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isEditing && connection ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full text-[#9ca3af] hover:bg-[#313131] hover:text-[#f5f5f5]"
                  onClick={() => onDelete(connection)}
                  title={t('deleteConnection')}
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex flex-1 overflow-hidden">
        <aside className="w-[160px] shrink-0 border-r border-[#3a3a3a] bg-[#262626] px-4 py-4">
          <div className="space-y-2">
            {navItems.map((item) => (
              <SidebarButton
                key={item.key}
                active={activePanel === item.key}
                icon={item.icon}
                label={item.label}
                onClick={() => setActivePanel(item.key)}
              />
            ))}
          </div>
        </aside>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#262626] px-4 py-4">
          <div className="space-y-4">
            {activePanel === 'basic' ? (
              <>
                <PanelShell title={t('workspace.basicInfo', { defaultValue: '基本信息' })}>
                  <div className="space-y-4">
                    <Field label={t('form.name')}>
                      <Input
                        value={formState.name}
                        onChange={(event) => setField('name', event.target.value)}
                        placeholder={t('form.namePlaceholder')}
                        className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none placeholder:text-[#71717a]"
                      />
                    </Field>

                    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                      <Field label={t('form.group')}>
                        <Select
                          value={formState.groupId}
                          onValueChange={(value) => setField('groupId', value)}
                        >
                          <SelectTrigger className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none">
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
                          className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none hover:bg-[#353535]"
                          onClick={onManageGroups}
                        >
                          <Plus className="size-3.5" />
                          {t('list.addGroup')}
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_96px]">
                      <Field
                        label={t('workspace.addressTitle', { defaultValue: '地址' })}
                        hint={t('workspace.addressHint', {
                          defaultValue: '填写目标 SSH 地址和端口。'
                        })}
                      >
                        <Input
                          value={formState.host}
                          onChange={(event) => setField('host', event.target.value)}
                          placeholder={t('form.hostPlaceholder')}
                          className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none placeholder:text-[#71717a]"
                        />
                      </Field>
                      <Field label={t('form.port')}>
                        <Input
                          value={formState.port}
                          onChange={(event) => setField('port', event.target.value)}
                          inputMode="numeric"
                          className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none"
                        />
                      </Field>
                    </div>
                  </div>
                </PanelShell>

                <PanelShell
                  title={t('workspace.otherSettings', { defaultValue: '主机备注' })}
                  description={t('workspace.hostMemoHint', {
                    defaultValue: '可填写默认目录或用途说明，方便后续识别。'
                  })}
                >
                  <textarea
                    value={formState.defaultDirectory}
                    onChange={(event) => setField('defaultDirectory', event.target.value)}
                    placeholder="/home/ubuntu/project"
                    className="min-h-[104px] w-full rounded-[10px] border border-[#525252] bg-[#2d2d2d] px-3 py-3 text-[14px] text-[#f5f5f5] outline-none placeholder:text-[#71717a]"
                  />
                </PanelShell>
              </>
            ) : null}

            {activePanel === 'auth' ? (
              <PanelShell
                title={t('workspace.connectionSettings', { defaultValue: '连接设置' })}
                description={t('workspace.credentialsHint', {
                  defaultValue: '使用登录用户和认证方式完成连接。'
                })}
              >
                <div className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
                    <Field label={t('form.username')}>
                      <div className="relative">
                        <UserCircle2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#8b8b8b]" />
                        <Input
                          value={formState.username}
                          onChange={(event) => setField('username', event.target.value)}
                          placeholder={t('form.usernamePlaceholder')}
                          className="h-11 border-[#525252] bg-[#2d2d2d] pl-10 text-[#f5f5f5] shadow-none placeholder:text-[#71717a]"
                        />
                      </div>
                    </Field>

                    <Field label={t('form.authType')}>
                      <Select
                        value={formState.authType}
                        onValueChange={(value) =>
                          setField('authType', value as SshConnection['authType'])
                        }
                      >
                        <SelectTrigger className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="password">{t('form.authPassword')}</SelectItem>
                          <SelectItem value="privateKey">{t('form.authPrivateKey')}</SelectItem>
                          <SelectItem value="agent">{t('form.authAgent')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>

                  {formState.authType === 'password' ? (
                    <Field label={t('form.password')}>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <LockKeyhole className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#8b8b8b]" />
                          <Input
                            value={formState.password}
                            onChange={(event) => setField('password', event.target.value)}
                            placeholder={isEditing ? '••••••••' : t('form.passwordPlaceholder')}
                            type="password"
                            className="h-11 border-[#525252] bg-[#2d2d2d] pl-10 text-[#f5f5f5] shadow-none placeholder:text-[#71717a]"
                          />
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none hover:bg-[#353535]"
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
                            className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none placeholder:text-[#71717a]"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none hover:bg-[#353535]"
                            onClick={() => void handleSelectKeyFile()}
                          >
                            <FolderOpen className="size-3.5" />
                            {t('form.selectKeyFile')}
                          </Button>
                        </div>
                      </Field>

                      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                        <Field label={t('form.passphrase')}>
                          <Input
                            value={formState.passphrase}
                            onChange={(event) => setField('passphrase', event.target.value)}
                            placeholder={t('form.passphrasePlaceholder')}
                            type="password"
                            className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none placeholder:text-[#71717a]"
                          />
                        </Field>
                        <div className="flex items-end">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none hover:bg-[#353535]"
                            onClick={() => void handleCopyPublicKey()}
                          >
                            <KeyRound className="size-3.5" />
                            {t('form.autoLoadPublicKey')}
                          </Button>
                        </div>
                      </div>
                    </>
                  ) : null}

                  {formState.authType === 'agent' ? (
                    <div className="rounded-[10px] border border-[#3d3d3d] bg-[#2b2b2b] px-3 py-3 text-[13px] text-[#b6b6b6]">
                      {t('workspace.agentAuthHint', {
                        defaultValue: '当前连接会直接使用本机 SSH Agent 完成认证。'
                      })}
                    </div>
                  ) : null}

                  <div className="rounded-[10px] border border-[#3d3d3d] bg-[#2b2b2b] px-3 py-3 text-[13px]">
                    <div className="text-[#8b8b8b]">{t('workspace.authSummary', { defaultValue: '认证摘要' })}</div>
                    <div className="mt-1 text-[#f5f5f5]">
                      {formState.username || 'root'} / {authSummary}
                    </div>
                  </div>
                </div>
              </PanelShell>
            ) : null}

            {activePanel === 'jump' ? (
              <PanelShell
                title={t('workspace.jumpHost', { defaultValue: '跳板机' })}
                description={t('workspace.jumpHostHint', {
                  defaultValue: '需要通过中间主机接入时，请填写 ProxyJump。'
                })}
              >
                <Field label={t('form.proxyJump')}>
                  <Input
                    value={formState.proxyJump}
                    onChange={(event) => setField('proxyJump', event.target.value)}
                    placeholder={t('form.proxyJumpPlaceholder')}
                    className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none placeholder:text-[#71717a]"
                  />
                </Field>
              </PanelShell>
            ) : null}

            {activePanel === 'proxy' ? (
              <PanelShell
                title={t('workspace.proxySettings', { defaultValue: '代理设置' })}
                description={t('workspace.proxySettingsHint', {
                  defaultValue: '这里先保留连接稳定性相关设置。'
                })}
              >
                <Field label={t('form.keepAlive')}>
                  <Input
                    value={formState.keepAliveInterval}
                    onChange={(event) => setField('keepAliveInterval', event.target.value)}
                    inputMode="numeric"
                    className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none"
                  />
                </Field>
              </PanelShell>
            ) : null}

            {activePanel === 'other' ? (
              <>
                <PanelShell title={t('workspace.otherSettings', { defaultValue: '其他设置' })}>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t('form.defaultDirectory')}>
                      <Input
                        value={formState.defaultDirectory}
                        onChange={(event) => setField('defaultDirectory', event.target.value)}
                        placeholder="~/"
                        className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none placeholder:text-[#71717a]"
                      />
                    </Field>
                    <Field label={t('workspace.runtimeShell', { defaultValue: '初始化执行' })}>
                      <Input
                        value={formState.startupCommand}
                        onChange={(event) => setField('startupCommand', event.target.value)}
                        placeholder="#!/bin/bash"
                        className="h-11 border-[#525252] bg-[#2d2d2d] text-[#f5f5f5] shadow-none placeholder:text-[#71717a]"
                      />
                    </Field>
                  </div>
                </PanelShell>

                <PanelShell
                  title={t('workspace.advancedCompatibility', { defaultValue: '高级兼容性' })}
                  description={t('workspace.advancedCompatibilityHint', {
                    defaultValue: '后续可继续扩展 X11、Cipher、Kex 等高级选项。'
                  })}
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-[10px] border border-[#3d3d3d] bg-[#2b2b2b] px-3 py-3 text-[13px] text-[#8b8b8b]">
                      X11 Forwarding
                    </div>
                    <div className="rounded-[10px] border border-[#3d3d3d] bg-[#2b2b2b] px-3 py-3 text-[13px] text-[#8b8b8b]">
                      Cipher / Kex
                    </div>
                  </div>
                </PanelShell>
              </>
            ) : null}

            {activePanel === 'init' ? (
              <PanelShell
                title={t('workspace.initialize', { defaultValue: '初始化' })}
                description={t('workspace.initializeHint', {
                  defaultValue: '保存后可直接连接，也可以先测试连接。'
                })}
              >
                <div className="space-y-4">
                  <div className="rounded-[10px] border border-[#3d3d3d] bg-[#2b2b2b] px-3 py-3 text-[13px] text-[#b6b6b6]">
                    {formState.host.trim()
                      ? `${formState.username || 'root'}@${formState.host}:${parseInt(formState.port, 10) || 22}`
                      : t('workspace.hostPreview', {
                          defaultValue: 'SSH host preview will appear here.'
                        })}
                  </div>
                  <div className="rounded-[10px] border border-[#3d3d3d] bg-[#2b2b2b] px-3 py-3 text-[13px] text-[#b6b6b6]">
                    {formState.startupCommand.trim() ||
                      t('workspace.initCommandHint', {
                        defaultValue: '未设置初始化命令，连接后将直接进入默认 shell。'
                      })}
                  </div>
                </div>
              </PanelShell>
            ) : null}
          </div>
        </div>
      </div>

      <div className="border-t border-[#3a3a3a] bg-[#262626] px-4 py-4">
        <div className="mb-3 flex items-center gap-2 rounded-[12px] border border-[#3b3b3b] bg-[#2b2b2b] px-3 py-2 text-[0.76rem] text-[#9ca3af]">
          <Boxes className="size-3.5 text-[#6ee787]" />
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
            className="h-11 rounded-[10px] border-[#525252] bg-[#1f1f1f] px-4 text-[0.84rem] font-medium text-[#f5f5f5] shadow-none hover:bg-[#353535]"
            onClick={() => void handleTestCurrent()}
            disabled={!canSubmit || saving}
          >
            {t('testConnection')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-11 rounded-[10px] border-[#525252] bg-[#1f1f1f] px-6 text-[0.84rem] font-medium text-[#f5f5f5] shadow-none hover:bg-[#353535]"
            onClick={() => onCancel?.()}
          >
            {t('form.cancel')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-11 rounded-[10px] border-[#2d7d48] bg-[#38b768] px-6 text-[0.84rem] font-semibold text-white shadow-none hover:bg-[#45c874]"
            onClick={() => void handleSave()}
            disabled={!canSubmit || saving || (!isDirty && isEditing)}
          >
            <Save className="size-4" />
            {isEditing ? t('form.save') : t('groupDialog.create', { defaultValue: '创建' })}
          </Button>
          <Button
            size="sm"
            className={cn(
              'h-11 rounded-[10px] bg-[#38b768] px-6 text-[0.84rem] font-semibold text-white shadow-none hover:bg-[#45c874]',
              session?.status === 'connected' && 'bg-[#2f9d58] hover:bg-[#39b564]'
            )}
            onClick={() => void handlePrimaryAction()}
            disabled={!canSubmit || saving}
          >
            {session?.status === 'connected' ? <Terminal className="size-4" /> : <ArrowUpRight className="size-4" />}
            {session?.status === 'connected' ? t('openTerminal') : t('connect')}
          </Button>
        </div>
      </div>
    </div>
  )
}
