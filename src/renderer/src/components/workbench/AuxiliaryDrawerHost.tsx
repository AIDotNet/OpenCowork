import type React from 'react'
import { X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

interface AuxiliaryDrawerHostProps {
  open: boolean
  title?: string
  width?: number
  onClose?: () => void
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function AuxiliaryDrawerHost({
  open,
  title,
  width = 210,
  onClose,
  actions,
  children,
  className
}: AuxiliaryDrawerHostProps): React.JSX.Element | null {
  if (!open) return null

  return (
    <div
      className={cn(
        'relative flex h-full shrink-0 flex-col border-l border-border/60 bg-muted/20 backdrop-blur-sm select-none',
        className
      )}
      style={{ width }}
    >
      {(title || onClose || actions) && (
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-border/50 px-2 text-[11px] font-medium text-muted-foreground">
          <span className="truncate">{title}</span>
          <div className="flex items-center gap-1">
            {actions}
            {onClose && (
              <Button
                variant="ghost"
                size="icon"
                className="size-5 rounded p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={onClose}
              >
                <X className="size-3" />
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  )
}
