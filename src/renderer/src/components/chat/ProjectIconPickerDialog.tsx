import { useMemo, useRef, useState, type ChangeEvent, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { DynamicIcon } from 'lucide-react/dynamic'
import { Folder, Search, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { SESSION_ICONS } from '@renderer/lib/constants/session-icons'
import { cn } from '@renderer/lib/utils'
import { isProjectImageIcon, ProjectIcon } from './ProjectIcon'

const MAX_PROJECT_ICON_BYTES = 1024 * 1024

interface ProjectIconPickerDialogProps {
  open: boolean
  projectName: string
  currentIcon?: string | null
  sshConnectionId?: string | null
  onOpenChange: (open: boolean) => void
  onSelect: (icon: string | null) => void
}

export function ProjectIconPickerDialog({
  open,
  projectName,
  currentIcon,
  sshConnectionId,
  onOpenChange,
  onSelect
}: ProjectIconPickerDialogProps): JSX.Element {
  const { t } = useTranslation('layout')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')

  const filteredIcons = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return SESSION_ICONS
    return SESSION_ICONS.filter((name) => {
      const compact = name.replace(/-/gu, ' ')
      return name.includes(normalized) || compact.includes(normalized)
    })
  }, [query])

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) setQuery('')
    onOpenChange(nextOpen)
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error(
        t('sidebar_toast.projectIconInvalidType', { defaultValue: 'Please select an image file' })
      )
      return
    }
    if (file.size > MAX_PROJECT_ICON_BYTES) {
      toast.error(
        t('sidebar_toast.projectIconTooLarge', {
          defaultValue: 'The icon must be smaller than 1 MB'
        })
      )
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        toast.error(
          t('sidebar_toast.projectIconUploadFailed', {
            defaultValue: 'Could not read the selected icon'
          })
        )
        return
      }
      onSelect(reader.result)
      handleOpenChange(false)
    }
    reader.onerror = () =>
      toast.error(
        t('sidebar_toast.projectIconUploadFailed', {
          defaultValue: 'Could not read the selected icon'
        })
      )
    reader.readAsDataURL(file)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-3 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t('sidebar.projectIconDialogTitle', { defaultValue: 'Change project icon' })}
          </DialogTitle>
          <DialogDescription>
            {t('sidebar.projectIconDialogDescription', {
              projectName,
              defaultValue: 'Choose an icon for “{{projectName}}”, or upload your own image.'
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 rounded-xl border bg-muted/20 p-3">
          <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-background">
            <ProjectIcon
              icon={currentIcon}
              sshConnectionId={sshConnectionId}
              expanded
              className="size-6"
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{projectName}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                className="hidden"
                onChange={handleFileChange}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="size-3.5" />
                {currentIcon && isProjectImageIcon(currentIcon)
                  ? t('sidebar.projectIconReplace', { defaultValue: 'Replace image' })
                  : t('sidebar.projectIconUpload', { defaultValue: 'Upload image' })}
              </Button>
              {currentIcon ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                  onClick={() => {
                    onSelect(null)
                    handleOpenChange(false)
                  }}
                >
                  <X className="size-3.5" />
                  {t('sidebar.projectIconReset', { defaultValue: 'Reset to default' })}
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('sidebar.projectIconSearch', { defaultValue: 'Search icons' })}
            className="h-8 pl-8 text-xs"
          />
        </div>

        <div className="max-h-[min(360px,50vh)] overflow-y-auto pr-1">
          <div className="grid grid-cols-8 gap-1">
            <button
              type="button"
              className={cn(
                'flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                !currentIcon && 'bg-muted text-foreground ring-1 ring-ring/40'
              )}
              title={t('sidebar.projectIconDefault', { defaultValue: 'Default folder' })}
              onClick={() => {
                onSelect(null)
                handleOpenChange(false)
              }}
            >
              <Folder className="size-4" />
            </button>
            {filteredIcons.map((name) => {
              const selected = currentIcon === name
              return (
                <button
                  key={name}
                  type="button"
                  className={cn(
                    'flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                    selected && 'bg-muted text-foreground ring-1 ring-ring/40'
                  )}
                  title={name}
                  onClick={() => {
                    onSelect(name)
                    handleOpenChange(false)
                  }}
                >
                  <DynamicIcon name={name as never} className="size-4" />
                </button>
              )
            })}
          </div>
          {filteredIcons.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t('sidebar.noMatches')}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
