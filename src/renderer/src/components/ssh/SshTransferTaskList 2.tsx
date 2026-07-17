import { useTranslation } from 'react-i18next'
import { useSshStore } from '@renderer/stores/ssh-store'
import { Button } from '@renderer/components/ui/button'
export function UploadTaskList({
  tasks
}: {
  tasks: {
    taskId: string
    stage: string
    type?: string
    message?: string
    currentItem?: string
    request?: unknown
    progress?: {
      current?: number
      total?: number
      percent?: number
      currentBytes?: number
      totalBytes?: number
      processedItems?: number
      totalItems?: number
    }
  }[]
}): React.JSX.Element {
  const { t } = useTranslation('ssh')

  if (tasks.length === 0) {
    return (
      <div className="px-4 pb-4 text-sm text-muted-foreground">{t('workspace.logs.noUploads')}</div>
    )
  }

  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      {tasks.map((task) => {
        const percent = task.progress?.percent
        const canCancel =
          task.stage !== 'done' && task.stage !== 'error' && task.stage !== 'canceled'

        return (
          <div key={task.taskId} className="rounded-2xl border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{task.taskId}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {task.type ? `${task.type} · ` : ''}
                  {t(`workspace.uploads.stages.${task.stage}`, { defaultValue: task.stage })}
                  {task.message ? ` · ${task.message}` : ''}
                  {task.currentItem ? ` · ${task.currentItem}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {canCancel ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void useSshStore.getState().cancelTransfer(task.taskId)}
                  >
                    {t('workspace.uploads.cancel')}
                  </Button>
                ) : (
                  <>
                    {(task.stage === 'error' || task.stage === 'canceled') && task.request ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void useSshStore.getState().retryTransfer(task.taskId)}
                      >
                        {t('workspace.uploads.retry', { defaultValue: 'Retry' })}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => useSshStore.getState().clearTransferTask(task.taskId)}
                    >
                      {t('workspace.uploads.clear')}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <div className="mt-3">
              <div className="h-1.5 rounded-full bg-muted">
                <div
                  className="h-1.5 rounded-full bg-primary transition-all"
                  style={{ width: typeof percent === 'number' ? `${percent}%` : '0%' }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-[0.72rem] text-muted-foreground">
                <span>{typeof percent === 'number' ? `${percent}%` : ''}</span>
                <span>
                  {typeof task.progress?.processedItems === 'number'
                    ? `${task.progress.processedItems}`
                    : typeof task.progress?.current === 'number'
                      ? `${task.progress.current}`
                      : ''}
                  {typeof task.progress?.totalItems === 'number'
                    ? ` / ${task.progress.totalItems}`
                    : typeof task.progress?.total === 'number'
                      ? ` / ${task.progress.total}`
                      : ''}
                </span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
