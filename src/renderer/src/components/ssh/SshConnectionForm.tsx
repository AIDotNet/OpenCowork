import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Save, X, ChevronDown, ChevronRight, FolderOpen, KeyRound } from 'lucide-react'
import { useSshStore, type SshConnection, type SshGroup } from '@renderer/stores/ssh-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
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
import { toast } from 'sonner'

interface SshConnectionFormProps {
  connection: SshConnection | null
  groups: SshGroup[]
  onClose: () => void
  onSaved: () => void
}

export function SshConnectionForm({
  connection,
  groups,
  onClose,
  onSaved
}: SshConnectionFormProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const isEditing = !!connection

  const [name, setName] = useState(connection?.name ?? '')
  const [host, setHost] = useState(connection?.host ?? '')
  const [port, setPort] = useState(String(connection?.port ?? 22))
  const [username, setUsername] = useState(connection?.username ?? '')
  const [authType, setAuthType] = useState<string>(connection?.authType ?? 'password')
  const [password, setPassword] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState(connection?.privateKeyPath ?? '')
  const [passphrase, setPassphrase] = useState('')
  const [groupId, setGroupId] = useState<string>(connection?.groupId ?? '__none__')
  const initialDefaultDirectory = connection?.defaultDirectory ?? ''
  const [defaultDirectory, setDefaultDirectory] = useState(initialDefaultDirectory)
  const [startupCommand, setStartupCommand] = useState(connection?.startupCommand ?? '')
  const [proxyJump, setProxyJump] = useState(connection?.proxyJump ?? '')
  const [keepAliveInterval, setKeepAliveInterval] = useState(
    String(connection?.keepAliveInterval ?? 60)
  )
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)

  const loadDefaultPublicKey = async (): Promise<
    { pubPath: string; pubContent: string; privateKeyPath?: string } | { error: string }
  > => {
    const homeResult = await ipcClient.invoke(IPC.APP_HOMEDIR)
    const homeDir =
      homeResult && typeof homeResult === 'object' && 'path' in homeResult
        ? String((homeResult as { path?: string }).path ?? '')
        : String(homeResult ?? '')
    if (!homeDir) return { error: 'Failed to resolve home directory' }

    const sshDir = `${homeDir}\\.ssh`
    const candidates = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa', 'identity']

    for (const base of candidates) {
      const pubPath = `${sshDir}\\${base}.pub`
      const doc = await ipcClient.invoke(IPC.FS_READ_DOCUMENT, { path: pubPath })
      if (
        doc &&
        typeof doc === 'object' &&
        'content' in doc &&
        (doc as { content?: string }).content
      ) {
        const pubContent = String((doc as { content: string }).content)
        const privateKeyPath = `${sshDir}\\${base}`
        return { pubPath, pubContent, privateKeyPath }
      }
    }

    return { error: 'No public key found under ~/.ssh' }
  }

  const handleSelectKeyFile = async (): Promise<void> => {
    const result = await ipcClient.invoke(IPC.FS_SELECT_FILE)
    if (!result || typeof result !== 'object') return
    if ((result as { canceled?: boolean }).canceled) return
    const filePath = (result as { path?: string }).path
    if (filePath) setPrivateKeyPath(filePath)
  }

  const handleAutoLoadPublicKey = async (): Promise<void> => {
    try {
      const result = await loadDefaultPublicKey()
      if ('error' in result) {
        toast.error(t('form.publicKeyLoadFailed'))
        return
      }

      await navigator.clipboard.writeText(result.pubContent)
      toast.success(t('form.publicKeyCopied'))

      if (!privateKeyPath && result.privateKeyPath) {
        setPrivateKeyPath(result.privateKeyPath)
      }
    } catch (err) {
      toast.error(String(err))
    }
  }

  const handleInstallPublicKeyToRemote = async (): Promise<void> => {
    if (!connection?.id) {
      toast.error(t('form.saveBeforeInstallKey'))
      return
    }
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
        toast.error(String((installResult as { error?: string }).error ?? 'Install failed'))
        return
      }

      toast.success(t('form.publicKeyInstalled'))
      if (result.privateKeyPath) {
        setAuthType('privateKey')
        if (!privateKeyPath) setPrivateKeyPath(result.privateKeyPath)
      }
    } catch (err) {
      toast.error(String(err))
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!name.trim() || !host.trim() || !username.trim()) return

    setSaving(true)
    try {
      const data = {
        name: name.trim(),
        host: host.trim(),
        port: parseInt(port, 10) || 22,
        username: username.trim(),
        authType,
        password: password || undefined,
        privateKeyPath: privateKeyPath || undefined,
        passphrase: passphrase || undefined,
        groupId: groupId === '__none__' ? undefined : groupId,
        defaultDirectory: defaultDirectory || undefined,
        startupCommand: startupCommand || undefined,
        proxyJump: proxyJump || undefined,
        keepAliveInterval: parseInt(keepAliveInterval, 10) || 60
      }

      if (isEditing) {
        await useSshStore.getState().updateConnection(connection.id, {
          ...data,
          groupId: groupId === '__none__' ? null : groupId,
          password: password || null,
          privateKeyPath: privateKeyPath || null,
          passphrase: passphrase || null,
          defaultDirectory: defaultDirectory || null,
          startupCommand: startupCommand || null,
          proxyJump: proxyJump || null
        })
      } else {
        await useSshStore.getState().createConnection(data)
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <span className="text-sm font-medium">
          {isEditing ? t('editConnection') : t('newConnection')}
        </span>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {/* Name */}
        <Field label={t('form.name')}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('form.namePlaceholder')}
            className="h-8 text-xs"
          />
        </Field>

        {/* Host + Port */}
        <div className="flex gap-2">
          <Field label={t('form.host')} className="flex-1">
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={t('form.hostPlaceholder')}
              className="h-8 text-xs"
            />
          </Field>
          <Field label={t('form.port')} className="w-20">
            <Input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="22"
              className="h-8 text-xs"
              type="number"
            />
          </Field>
        </div>

        {/* Username */}
        <Field label={t('form.username')}>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t('form.usernamePlaceholder')}
            className="h-8 text-xs"
          />
        </Field>

        {/* Auth Type */}
        <Field label={t('form.authType')}>
          <Select value={authType} onValueChange={setAuthType}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="password">{t('form.authPassword')}</SelectItem>
              <SelectItem value="privateKey">{t('form.authPrivateKey')}</SelectItem>
              <SelectItem value="agent">{t('form.authAgent')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {/* Password */}
        {authType === 'password' && (
          <Field label={t('form.password')}>
            <div className="flex gap-1.5">
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isEditing ? '••••••••' : t('form.passwordPlaceholder')}
                className="h-8 text-xs flex-1"
                type="password"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 text-xs shrink-0"
                onClick={() => void handleInstallPublicKeyToRemote()}
              >
                <KeyRound className="size-3" />
                {t('form.installPublicKey')}
              </Button>
            </div>
          </Field>
        )}

        {/* Private Key */}
        {authType === 'privateKey' && (
          <>
            <Field label={t('form.privateKey')}>
              <div className="flex gap-1.5">
                <Input
                  value={privateKeyPath}
                  onChange={(e) => setPrivateKeyPath(e.target.value)}
                  placeholder={t('form.privateKeyPlaceholder')}
                  className="h-8 text-xs flex-1"
                  readOnly
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1 text-xs shrink-0"
                  onClick={() => void handleSelectKeyFile()}
                >
                  <FolderOpen className="size-3" />
                  {t('form.selectKeyFile')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1 text-xs shrink-0"
                  onClick={() => void handleAutoLoadPublicKey()}
                >
                  <KeyRound className="size-3" />
                  {t('form.autoLoadPublicKey')}
                </Button>
              </div>
            </Field>
            <Field label={t('form.passphrase')}>
              <Input
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t('form.passphrasePlaceholder')}
                className="h-8 text-xs"
                type="password"
              />
            </Field>
          </>
        )}

        {/* Group */}
        <Field label={t('form.group')}>
          <Select value={groupId} onValueChange={setGroupId}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t('form.groupNone')}</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* Advanced */}
        <Separator />
        <button
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {t('form.advanced')}
        </button>

        {showAdvanced && (
          <div className="space-y-3 pl-1">
            <Field label={t('form.defaultDirectory')}>
              <Input
                value={defaultDirectory}
                onChange={(e) => setDefaultDirectory(e.target.value)}
                placeholder="/home/username/workspace"
                className="h-8 text-xs"
              />
              <p className="mt-1 text-[10px] text-muted-foreground/70">
                {t('form.defaultDirectoryHint')}
              </p>
            </Field>
            <Field label={t('form.startupCommand')}>
              <Input
                value={startupCommand}
                onChange={(e) => setStartupCommand(e.target.value)}
                placeholder={t('form.startupCommandPlaceholder')}
                className="h-8 text-xs"
              />
            </Field>
            <Field label={t('form.proxyJump')}>
              <Input
                value={proxyJump}
                onChange={(e) => setProxyJump(e.target.value)}
                placeholder={t('form.proxyJumpPlaceholder')}
                className="h-8 text-xs"
              />
            </Field>
            <Field label={t('form.keepAlive')}>
              <Input
                value={keepAliveInterval}
                onChange={(e) => setKeepAliveInterval(e.target.value)}
                placeholder="60"
                className="h-8 text-xs w-24"
                type="number"
              />
            </Field>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 px-4 py-2 border-t">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onClose}>
          {t('form.cancel')}
        </Button>
        <Button
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => void handleSave()}
          disabled={saving || !name.trim() || !host.trim() || !username.trim()}
        >
          <Save className="size-3" />
          {t('form.save')}
        </Button>
      </div>
    </div>
  )
}

function Field({
  label,
  className,
  children
}: {
  label: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={className}>
      <label className="mb-1 block text-[10px] font-medium text-muted-foreground/70">{label}</label>
      {children}
    </div>
  )
}
