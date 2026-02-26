import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSshStore, type SshGroup } from '@renderer/stores/ssh-store'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { toast } from 'sonner'

interface SshGroupDialogProps {
  open: boolean
  group: SshGroup | null
  onClose: () => void
}

export function SshGroupDialog({ open, group, onClose }: SshGroupDialogProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const isEditing = !!group
  const [name, setName] = useState('')

  useEffect(() => {
    if (open) {
      setName(group?.name ?? '')
    }
  }, [open, group])

  const handleSubmit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return

    if (isEditing) {
      await useSshStore.getState().updateGroup(group.id, trimmed)
      toast.success(t('groupRenamed'))
    } else {
      await useSshStore.getState().createGroup(trimmed)
      toast.success(t('groupCreated'))
    }
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-sm p-4">
        <DialogHeader>
          <DialogTitle className="text-sm">{t('groupDialog.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-1">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('groupDialog.placeholder')}
            className="h-8 text-xs"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                void handleSubmit()
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onClose}>
              {t('form.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => void handleSubmit()}
              disabled={!name.trim()}
            >
              {isEditing ? t('groupDialog.rename') : t('groupDialog.create')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
