import { useTranslation } from 'react-i18next'
import { Activity, Copy, Loader2, Pencil } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { type SshConnection, type SshGroup, type SshSession } from '@renderer/stores/ssh-store'
import { Button } from '@renderer/components/ui/button'

import { SshOsBadge, inferSshOsKind } from './ssh-host-list-helpers'

export function HostRow({
  connection,
  group,
  session,
  isSelected,
  isTesting,
  testOk,
  onEdit,
  onConnect,
  onTest
}: {
  connection: SshConnection
  group: SshGroup | undefined
  session: SshSession | undefined
  isSelected: boolean
  isTesting: boolean
  testOk: boolean | undefined
  onEdit: () => void
  onConnect: () => void
  onTest: () => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const sessionBusy = session?.status === 'connecting' || session?.status === 'reconnecting'
  const statusTone =
    session?.status === 'connected'
      ? 'text-[var(--ssh-success)]'
      : sessionBusy || isTesting
        ? 'text-[var(--ssh-warning)]'
        : testOk === false
          ? 'text-[var(--ssh-danger)]'
          : 'text-[var(--ssh-muted)]'
  const statusText =
    session?.status === 'connected'
      ? t('list.online')
      : sessionBusy
        ? t('connecting')
        : isTesting
          ? t('testing')
          : testOk === false
            ? t('list.unreachable')
            : t('list.offline')
  const osKind = inferSshOsKind(connection)
  const openActionLabel = t('list.open', { defaultValue: 'Open' })
  const badges = [
    group?.name ?? t('ungrouped'),
    t(`migration.auth.${connection.authType}`),
    `${connection.port} 端口`,
    connection.keepAliveInterval ? `${connection.keepAliveInterval}s 心跳` : null
  ].filter(Boolean) as string[]

  return (
    <div
      className={cn(
        'grid min-w-[940px] grid-cols-[76px_96px_minmax(170px,1fr)_220px_minmax(230px,280px)_144px] items-center border-b border-[#2c2c2c] bg-[#151515] px-2 text-[13px] text-[#e5e7eb] transition-colors hover:bg-[#1b1b1b]',
        isSelected && 'bg-[#1f1f1f]'
      )}
    >
      <div className="flex items-center gap-2">
        <SshOsBadge kind={osKind} />
      </div>

      <div className="flex items-center gap-2">
        <span className={cn('inline-flex items-center gap-1 text-[12px]', statusTone)}>
          <span className="size-2 rounded-full bg-current" />
          {statusText}
        </span>
      </div>

      <div className="truncate text-left font-medium">{connection.name}</div>

      <div className="flex items-center gap-2 font-mono text-[12px] text-[#d4d4d8]">
        <span className="truncate">{connection.host}</span>
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded-[6px] text-[#6ee787] hover:bg-[#222]"
          onClick={() => {
            void navigator.clipboard.writeText(connection.host)
          }}
          title="Copy host"
        >
          <Copy className="size-3" />
        </button>
      </div>

      <div className="flex flex-wrap gap-2 py-3">
        {badges.map((badge) => (
          <span
            key={badge}
            className="rounded-[6px] border border-[#3b3b3b] bg-[#2a2a2a] px-2 py-1 text-[11px] text-[#c4c4c4]"
          >
            {badge}
          </span>
        ))}
      </div>

      <div
        className="flex items-center justify-end gap-1.5 whitespace-nowrap"
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          size="sm"
          className="h-8 min-w-14 rounded-[7px] bg-[#38b768] px-3 text-[12px] font-semibold text-white shadow-none hover:bg-[#45c874]"
          onClick={onConnect}
          title={session?.status === 'connected' ? t('openTerminal') : t('connect')}
        >
          {session?.status === 'connected' ? openActionLabel : t('connect')}
        </Button>
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-[7px] border border-[#343434] bg-[#1d1d1d] text-[#b8b8b8] transition-colors hover:border-[#454545] hover:bg-[#262626] hover:text-white"
          onClick={onEdit}
          title={t('editConnection')}
          aria-label={t('editConnection')}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-[7px] border border-[#343434] bg-[#1d1d1d] text-[#b8b8b8] transition-colors hover:border-[#454545] hover:bg-[#262626] hover:text-white"
          onClick={onTest}
          title={t('testConnection')}
          aria-label={t('testConnection')}
        >
          {isTesting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Activity className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  )
}
