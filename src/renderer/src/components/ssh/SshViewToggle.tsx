import { useTranslation } from 'react-i18next'
import { LayoutGrid, List } from 'lucide-react'
import { motion } from 'motion/react'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings-store'

interface SshViewToggleProps {
  mode: 'table' | 'card'
  onChange: (mode: 'table' | 'card') => void
}

export function SshViewToggle({ mode, onChange }: SshViewToggleProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)

  const options = [
    { value: 'table' as const, icon: List, title: t('list.viewTable'), rounded: 'rounded-l-md' },
    { value: 'card' as const, icon: LayoutGrid, title: t('list.viewCard'), rounded: 'rounded-r-md' }
  ]

  return (
    <div className="flex items-center rounded-md border border-border">
      {options.map(({ value, icon: Icon, title, rounded }) => (
        <button
          key={value}
          className={cn(
            'relative flex items-center justify-center p-1.5 transition-colors',
            rounded,
            mode === value ? 'text-foreground' : 'text-muted-foreground/50 hover:text-foreground'
          )}
          onClick={() => onChange(value)}
          title={title}
        >
          {mode === value && (
            <motion.span
              layoutId={animationsEnabled ? 'ssh-view-toggle-pill' : undefined}
              transition={
                animationsEnabled
                  ? { type: 'spring', stiffness: 400, damping: 32 }
                  : { duration: 0 }
              }
              className="absolute inset-0.5 rounded bg-muted"
            />
          )}
          <Icon className="relative z-10 size-3.5" />
        </button>
      ))}
    </div>
  )
}
