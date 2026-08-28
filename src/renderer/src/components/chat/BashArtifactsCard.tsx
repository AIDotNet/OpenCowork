import { useTranslation } from 'react-i18next'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

interface BashArtifact {
  path: string
  size: number
}

interface BashArtifactsCardProps {
  artifacts: BashArtifact[]
  truncated?: number
}

function prettySize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function splitPath(path: string): { base: string; dir: string } {
  const normalized = path.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return { base: normalized, dir: '' }
  return { base: normalized.slice(lastSlash + 1), dir: normalized.slice(0, lastSlash) }
}

export function BashArtifactsCard({
  artifacts,
  truncated
}: BashArtifactsCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')

  return (
    <div className="my-0 min-w-0 space-y-1.5 rounded-md border border-dashed px-2.5 py-2">
      <p className="text-xs font-medium text-muted-foreground">
        {t('artifacts.title', { defaultValue: 'Files created' })} · {artifacts.length}
      </p>
      <div className="space-y-1">
        {artifacts.map((artifact) => {
          const { base, dir } = splitPath(artifact.path)
          return (
            <div
              key={artifact.path}
              className="flex min-w-0 items-center gap-2 rounded-md bg-muted/20 px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[11px] text-foreground" title={artifact.path}>
                  {base}
                </p>
                <p className="truncate text-[9px] text-muted-foreground/60" title={dir}>
                  {dir} · {prettySize(artifact.size)}
                </p>
              </div>
              <button
                type="button"
                className="rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                onClick={() => void ipcClient.invoke('shell:showItemInFolder', artifact.path)}
              >
                {t('artifacts.reveal', { defaultValue: 'Reveal in Finder' })}
              </button>
              <button
                type="button"
                className="rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                onClick={() => void ipcClient.invoke('shell:openPath', artifact.path)}
              >
                {t('artifacts.open', { defaultValue: 'Open' })}
              </button>
            </div>
          )
        })}
      </div>
      {truncated ? (
        <p className="text-[10px] text-muted-foreground/60">
          {t('artifacts.more', { count: truncated, defaultValue: `+${truncated} more` })}
        </p>
      ) : null}
    </div>
  )
}
