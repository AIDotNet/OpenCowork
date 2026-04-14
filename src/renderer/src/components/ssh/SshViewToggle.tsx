import { useTranslation } from 'react-i18next'
import { LayoutGrid, List } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

interface SshViewToggleProps {
  mode: 'table' | 'card'
  onChange: (mode: 'table' | 'card') => void
}

export function SshViewToggle({ mode, onChange }: SshViewToggleProps): React.JSX.Element {
  const { t } = useTranslation('ssh')

  return (
    <div className="flex items-center rounded-md border border-border">
      <button
        className={cn(
          'flex items-center justify-center rounded-l-md p-1.5 transition-colors',
          mode === 'table'
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground/50 hover:text-foreground'
        )}
        onClick={() => onChange('table')}
        title={t('list.viewTable')}
      >
        <List className="size-3.5" />
      </button>
      <button
        className={cn(
          'flex items-center justify-center rounded-r-md p-1.5 transition-colors',
          mode === 'card'
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground/50 hover:text-foreground'
        )}
        onClick={() => onChange('card')}
        title={t('list.viewCard')}
      >
        <LayoutGrid className="size-3.5" />
      </button>
    </div>
  )
}
