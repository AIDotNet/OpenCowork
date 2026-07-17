import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { useSshStore } from '@renderer/stores/ssh-store'
import { Button } from '@renderer/components/ui/button'

import { SectionCard } from './ssh-workspace-shared'

export function SshLogsWorkspace(): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const connections = useSshStore((state) => state.connections)
  const sessions = useSshStore((state) => state.sessions)
  const transferTasks = useSshStore((state) => state.transferTasks)

  const liveSessions = useMemo(
    () =>
      Object.values(sessions)
        .map((session) => ({
          ...session,
          connection:
            connections.find((connection) => connection.id === session.connectionId) ?? null
        }))
        .sort((left, right) => left.connectionId.localeCompare(right.connectionId)),
    [connections, sessions]
  )

  const recentConnections = useMemo(
    () =>
      connections
        .filter((connection) => typeof connection.lastConnectedAt === 'number')
        .sort((left, right) => (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0))
        .slice(0, 8),
    [connections]
  )

  const recentUploads = useMemo(
    () =>
      Object.values(transferTasks)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 8),
    [transferTasks]
  )

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            className="size-10 rounded-[14px] border-border bg-card text-foreground shadow-none hover:bg-accent"
            onClick={() => void useSshStore.getState().loadAll()}
            title={t('list.refresh')}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[1.12rem] font-semibold text-foreground">
              {t('workspace.nav.logs', { defaultValue: 'Logs' })}
            </div>
            <div className="mt-1 text-[0.82rem] text-muted-foreground">
              {t('workspace.logs.subtitle', {
                defaultValue:
                  'View recent connections, session status and upload transfer activity.'
              })}
            </div>
          </div>
          <div className="rounded-full bg-card px-3 py-2 text-[0.76rem] font-medium text-muted-foreground shadow-[0_10px_24px_-18px_color-mix(in_srgb,var(--foreground)_18%,transparent)]">
            {liveSessions.length} {t('workspace.logs.live', { defaultValue: 'live sessions' })}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-3">
          <SectionCard title={t('workspace.logs.sessions', { defaultValue: 'Session status' })}>
            {liveSessions.length === 0 ? (
              <div className="text-[0.84rem] text-muted-foreground">
                {t('workspace.logs.noSessions', { defaultValue: 'No active sessions.' })}
              </div>
            ) : (
              liveSessions.map((session) => (
                <div
                  key={session.id}
                  className="rounded-[18px] border border-border bg-muted/45 px-3 py-3"
                >
                  <div className="text-[0.92rem] font-semibold text-foreground">
                    {session.connection?.name ?? session.connectionId}
                  </div>
                  <div className="mt-1 text-[0.8rem] text-muted-foreground">
                    {session.status}
                    {session.error ? ` · ${session.error}` : ''}
                  </div>
                </div>
              ))
            )}
          </SectionCard>

          <SectionCard
            title={t('workspace.logs.connections', { defaultValue: 'Recent connections' })}
          >
            {recentConnections.length === 0 ? (
              <div className="text-[0.84rem] text-muted-foreground">
                {t('workspace.logs.noConnections', { defaultValue: 'No connection history yet.' })}
              </div>
            ) : (
              recentConnections.map((connection) => (
                <div
                  key={connection.id}
                  className="rounded-[18px] border border-border bg-muted/45 px-3 py-3"
                >
                  <div className="text-[0.92rem] font-semibold text-foreground">
                    {connection.name}
                  </div>
                  <div className="mt-1 text-[0.8rem] text-muted-foreground">
                    {new Date(connection.lastConnectedAt ?? 0).toLocaleString()}
                  </div>
                </div>
              ))
            )}
          </SectionCard>

          <SectionCard title={t('workspace.logs.uploads', { defaultValue: 'Upload activity' })}>
            {recentUploads.length === 0 ? (
              <div className="text-[0.84rem] text-muted-foreground">
                {t('workspace.logs.noUploads', { defaultValue: 'No upload activity.' })}
              </div>
            ) : (
              recentUploads.map((task) => (
                <div
                  key={task.taskId}
                  className="rounded-[18px] border border-border bg-muted/45 px-3 py-3"
                >
                  <div className="text-[0.92rem] font-semibold text-foreground">{task.taskId}</div>
                  <div className="mt-1 text-[0.8rem] text-muted-foreground">
                    {task.stage}
                    {task.message ? ` · ${task.message}` : ''}
                  </div>
                </div>
              ))
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  )
}
