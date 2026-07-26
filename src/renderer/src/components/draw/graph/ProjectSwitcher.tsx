import { useState } from 'react'
import { Check, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@renderer/lib/utils'
import type { DrawProjectsApi } from './use-draw-projects'

export function ProjectSwitcher({ api }: { api: DrawProjectsApi }): React.JSX.Element {
  const { t } = useTranslation('layout')
  const { projects, activeProjectId, newProject, switchProject, renameProject, removeProject } = api
  const active = projects.find((p) => p.id === activeProjectId)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [operationError, setOperationError] = useState('')

  const saveRename = async (): Promise<void> => {
    if (!renaming || busy) return
    setBusy(true)
    setOperationError('')
    try {
      await renameProject(renaming.id, renaming.name)
      setRenaming(null)
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget || busy) return
    setBusy(true)
    setOperationError('')
    try {
      await removeProject(deleteTarget.id)
      setDeleteTarget(null)
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="max-w-48 gap-1.5">
            <span className="truncate">
              {active?.name ?? t('drawPage.untitledProject', { defaultValue: 'Untitled' })}
            </span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          {projects.map((p) => (
            <DropdownMenuItem
              key={p.id}
              className="group/pi gap-2"
              onSelect={() => switchProject(p.id)}
            >
              <Check
                className={cn(
                  'size-4 shrink-0',
                  p.id === activeProjectId ? 'opacity-100' : 'opacity-0'
                )}
              />
              <span className="flex-1 truncate">{p.name}</span>
              <span className="flex items-center gap-0.5 opacity-0 group-hover/pi:opacity-100">
                <button
                  type="button"
                  className="grid size-6 place-items-center rounded text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setOperationError('')
                    setRenaming({ id: p.id, name: p.name })
                  }}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="grid size-6 place-items-center rounded text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setOperationError('')
                    setDeleteTarget({ id: p.id, name: p.name })
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void newProject()}>
            <Plus className="size-4" />
            {t('drawPage.newProject', { defaultValue: 'New canvas' })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={!!renaming} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t('drawPage.renameProject', { defaultValue: 'Rename canvas' })}
            </DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renaming?.name ?? ''}
            onChange={(e) => setRenaming((r) => (r ? { ...r, name: e.target.value } : r))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renaming) {
                void saveRename()
              }
            }}
          />
          {operationError && <p className="text-sm text-destructive">{operationError}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRenaming(null)}>
              {t('action.cancel', { ns: 'common', defaultValue: 'Cancel' })}
            </Button>
            <Button disabled={busy} onClick={() => void saveRename()}>
              {t('action.save', { ns: 'common', defaultValue: 'Save' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteTarget(null)
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t('drawPage.deleteProject', { defaultValue: 'Delete canvas' })}
            </DialogTitle>
            <DialogDescription>
              {t('drawPage.deleteProjectConfirm', {
                defaultValue:
                  'Delete “{{name}}”? Its Agent workspace will be moved to the system trash.',
                name: deleteTarget?.name ?? ''
              })}
            </DialogDescription>
          </DialogHeader>
          {operationError && <p className="text-sm text-destructive">{operationError}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>
              {t('action.cancel', { ns: 'common', defaultValue: 'Cancel' })}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>
              {t('action.delete', { ns: 'common', defaultValue: 'Delete' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
