import { useTranslation } from 'react-i18next'
import { Server, Wifi, FolderOpen, Upload } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import type { SshConnection, SshSession, SshGroup, SshUploadTask } from '@renderer/stores/ssh-store'

interface SshDashboardStatsProps {
  connections: SshConnection[]
  sessions: Record<string, SshSession>
  groups: SshGroup[]
  uploadTasks: Record<string, SshUploadTask>
}

export function SshDashboardStats({
  connections,
  sessions,
  groups,
  uploadTasks
}: SshDashboardStatsProps): React.JSX.Element {
  const { t } = useTranslation('ssh')

  const onlineCount = connections.filter((c) =>
    Object.values(sessions).some((s) => s.connectionId === c.id && s.status === 'connected')
  ).length

  const activeUploadCount = Object.values(uploadTasks).filter(
    (task) => task.stage !== 'done' && task.stage !== 'error' && task.stage !== 'canceled'
  ).length

  const stats = [
    {
      label: t('dashboard.totalServers'),
      value: connections.length,
      icon: Server,
      accent: ''
    },
    {
      label: t('dashboard.onlineServers'),
      value: onlineCount,
      icon: Wifi,
      accent: onlineCount > 0 ? 'text-emerald-500' : ''
    },
    {
      label: t('dashboard.totalGroups'),
      value: groups.length,
      icon: FolderOpen,
      accent: ''
    },
    {
      label: t('dashboard.activeUploads'),
      value: activeUploadCount,
      icon: Upload,
      accent: activeUploadCount > 0 ? 'text-amber-500' : ''
    }
  ]

  return (
    <div className="grid grid-cols-4 gap-2 border-b px-3 py-2 shrink-0">
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-lg border border-border bg-muted/10 px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">{stat.label}</span>
            <stat.icon className="size-3.5 text-muted-foreground/40" />
          </div>
          <div className={cn('mt-1 text-lg font-semibold text-foreground', stat.accent)}>
            {stat.value}
          </div>
        </div>
      ))}
    </div>
  )
}
