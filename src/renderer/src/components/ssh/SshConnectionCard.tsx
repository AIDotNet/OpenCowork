import { useTranslation } from 'react-i18next'
import { Server, Play, Square, Loader2, CheckCircle2, Pencil, Trash2 } from 'lucide-react'
import type { SshConnection, SshSession, SshGroup } from '@renderer/stores/ssh-store'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { cn } from '@renderer/lib/utils'

interface SshConnectionCardProps {
  connection: SshConnection
  session: SshSession | undefined
  group: SshGroup | undefined
  isChecked: boolean
  isDetailSelected: boolean
  isTesting: boolean
  testFresh: boolean
  testOk: boolean | undefined
  onConnect: (id: string) => void
  onOpenTerminal: (id: string) => void
  onDisconnect: (sessionId: string) => void
  onTest: (id: string) => void
  onEdit: (conn: SshConnection) => void
  onDelete: (conn: SshConnection) => void
  onCheck: (id: string, checked: boolean) => void
  onDetailClick: (id: string) => void
}

export function SshConnectionCard({
  connection,
  session,
  group,
  isChecked,
  isDetailSelected,
  isTesting,
  testFresh,
  testOk,
  onConnect,
  onOpenTerminal,
  onDisconnect,
  onTest,
  onEdit,
  onDelete,
  onCheck,
  onDetailClick
}: SshConnectionCardProps): React.JSX.Element {
  const { t } = useTranslation('ssh')

  const isConnected = session?.status === 'connected'
  const isConnecting = session?.status === 'connecting'
  const isReachable = !isConnected && !isConnecting && testFresh && !!testOk
  const isUnreachable = !isConnected && !isConnecting && testFresh && testOk === false

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-lg border border-border bg-background p-3 transition-all cursor-pointer hover:border-primary/30 hover:shadow-sm',
        isDetailSelected && 'border-primary/50 ring-1 ring-primary/20',
        isChecked && 'bg-primary/5'
      )}
      onClick={() => onDetailClick(connection.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="relative shrink-0">
            <div className="flex size-9 items-center justify-center rounded-lg bg-muted/40">
              <Server className="size-4 text-muted-foreground" />
            </div>
            {isConnected && (
              <div className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-emerald-500" />
            )}
            {isConnecting && (
              <div className="absolute -top-0.5 -right-0.5 size-2.5 animate-pulse rounded-full border-2 border-background bg-amber-500" />
            )}
            {isReachable && (
              <div className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-emerald-400" />
            )}
            {isUnreachable && (
              <div className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-destructive" />
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{connection.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {connection.username}@{connection.host}:{connection.port}
            </div>
          </div>
        </div>
        <Checkbox
          className="opacity-0 group-hover:opacity-100 data-[state=checked]:opacity-100 shrink-0"
          checked={isChecked}
          onCheckedChange={(checked) => {
            onCheck(connection.id, !!checked)
          }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {group && (
          <Badge variant="outline" className="text-[10px]">
            {group.name}
          </Badge>
        )}
        <Badge variant="outline" className="text-[10px]">
          {t(`migration.auth.${connection.authType}`)}
        </Badge>
        {connection.proxyJump && (
          <Badge variant="outline" className="text-[10px]">
            ProxyJump
          </Badge>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <div>
          {isConnected ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500">
              <div className="size-1.5 rounded-full bg-emerald-500" />
              {t('list.online')}
            </span>
          ) : isConnecting ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-500">
              <Loader2 className="size-3 animate-spin" />
              {t('connecting')}
            </span>
          ) : isReachable ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500">
              <div className="size-1.5 rounded-full bg-emerald-500" />
              {t('list.reachable')}
            </span>
          ) : isUnreachable ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-destructive">
              <div className="size-1.5 rounded-full bg-destructive" />
              {t('list.unreachable')}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground/60">{t('list.offline')}</span>
          )}
        </div>
        <div
          className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          {isConnected && session ? (
            <>
              <Button
                variant="default"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => onOpenTerminal(connection.id)}
              >
                {t('openTerminal')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
                onClick={() => onDisconnect(session.id)}
              >
                <Square className="size-2.5" />
              </Button>
            </>
          ) : (
            <Button
              variant="default"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => onConnect(connection.id)}
              disabled={isConnecting}
            >
              {isConnecting ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <>
                  <Play className="mr-1 size-2.5" />
                  {t('connect')}
                </>
              )}
            </Button>
          )}
          {isTesting ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground/50" />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => onTest(connection.id)}
            >
              <CheckCircle2 className="size-3 text-muted-foreground/50" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => onEdit(connection)}
          >
            <Pencil className="size-3 text-muted-foreground/50" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-destructive/50 hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onDelete(connection)}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
    </div>
  )
}
