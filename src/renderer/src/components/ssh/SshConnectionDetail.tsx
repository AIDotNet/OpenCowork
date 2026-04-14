import { useTranslation } from 'react-i18next'
import { Server, Play, Terminal, CheckCircle2, Pencil, Trash2, X } from 'lucide-react'
import type { SshConnection, SshSession, SshGroup } from '@renderer/stores/ssh-store'
import { Button } from '@renderer/components/ui/button'

interface SshConnectionDetailProps {
  connection: SshConnection
  session: SshSession | undefined
  group: SshGroup | undefined
  onConnect: (id: string) => void
  onOpenTerminal: (id: string) => void
  onTest: (id: string) => void
  onEdit: (conn: SshConnection) => void
  onDelete: (conn: SshConnection) => void
  onClose: () => void
}

function DetailField({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <span className="text-[10px] text-muted-foreground/60">{label}</span>
      <div className="mt-0.5 truncate text-foreground">{value}</div>
    </div>
  )
}

export function SshConnectionDetail({
  connection,
  session,
  group,
  onConnect,
  onOpenTerminal,
  onTest,
  onEdit,
  onDelete,
  onClose
}: SshConnectionDetailProps): React.JSX.Element {
  const { t } = useTranslation('ssh')

  const isConnected = session?.status === 'connected'

  return (
    <div className="flex flex-col border-t bg-muted/5 shrink-0 max-h-48 overflow-y-auto">
      <div className="flex items-center justify-between border-b px-4 py-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Server className="size-4 text-primary shrink-0" />
          <span className="text-sm font-medium truncate">{connection.name}</span>
          {isConnected ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-500 shrink-0">
              <div className="size-1.5 rounded-full bg-emerald-500" />
              {t('list.online')}
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground/60 shrink-0">
              {t('list.offline')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isConnected && session ? (
            <Button
              variant="default"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={() => onOpenTerminal(connection.id)}
            >
              <Terminal className="size-3" />
              {t('openTerminal')}
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={() => onConnect(connection.id)}
            >
              <Play className="size-3" />
              {t('dashboard.quickConnect')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onTest(connection.id)}
            title={t('testConnection')}
          >
            <CheckCircle2 className="size-3 text-muted-foreground/50" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onEdit(connection)}
            title={t('editConnection')}
          >
            <Pencil className="size-3 text-muted-foreground/50" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-destructive/50 hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onDelete(connection)}
            title={t('deleteConnection')}
          >
            <Trash2 className="size-3" />
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          <button onClick={onClose} className="rounded p-1 hover:bg-muted/50 transition-colors">
            <X className="size-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-8 gap-y-2 px-4 py-3 text-xs lg:grid-cols-3">
        <DetailField label={t('form.host')} value={`${connection.host}:${connection.port}`} />
        <DetailField label={t('form.username')} value={connection.username} />
        <DetailField
          label={t('form.authType')}
          value={t(`migration.auth.${connection.authType}`)}
        />
        <DetailField label={t('form.keepAlive')} value={`${connection.keepAliveInterval}s`} />
        <DetailField label={t('form.group')} value={group?.name ?? t('form.groupNone')} />
        {connection.proxyJump && (
          <DetailField label={t('form.proxyJump')} value={connection.proxyJump} />
        )}
        {connection.defaultDirectory && (
          <DetailField label={t('form.defaultDirectory')} value={connection.defaultDirectory} />
        )}
        {connection.startupCommand && (
          <DetailField label={t('form.startupCommand')} value={connection.startupCommand} />
        )}
        <DetailField
          label={t('dashboard.lastConnected')}
          value={
            connection.lastConnectedAt
              ? new Date(connection.lastConnectedAt).toLocaleString()
              : t('dashboard.never')
          }
        />
        <DetailField
          label={t('dashboard.createdAt')}
          value={new Date(connection.createdAt).toLocaleString()}
        />
      </div>
    </div>
  )
}
