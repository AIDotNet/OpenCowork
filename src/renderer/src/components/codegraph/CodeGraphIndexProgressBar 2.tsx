import { useTranslation } from 'react-i18next'
import type { CgIndexProgress } from '@renderer/stores/codegraph-store'

// Determinate when the worker reports a file total (scan/extract/resolve phases),
// otherwise an indeterminate sweep (sync + the brief phases that report 0 total).
export function CodeGraphIndexProgressBar({
  progress,
  className
}: {
  progress: CgIndexProgress
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const total = progress.filesTotal
  const done = progress.filesDone
  const determinate = total > 0 && !progress.done
  const percent = determinate ? Math.min(100, Math.round((done / total) * 100)) : 100
  const phaseLabel = t(`codegraphPage.progress.${progress.phase}`, {
    defaultValue: t('codegraphPage.progress.indexing')
  })

  return (
    <div className={className}>
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-amber-600">{phaseLabel}</span>
        {determinate ? (
          <span className="text-muted-foreground">
            {t('codegraphPage.progress.files', { done, total })}
          </span>
        ) : null}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={
            determinate
              ? 'h-full rounded-full bg-amber-500 transition-all duration-300'
              : 'h-full w-full rounded-full bg-amber-500 animate-pulse'
          }
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
    </div>
  )
}
