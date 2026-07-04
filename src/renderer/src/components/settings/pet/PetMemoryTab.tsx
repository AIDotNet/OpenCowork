import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, FileText, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import {
  appendPetMemories,
  clearPetMemories,
  ensurePetMemoryFile,
  loadPetMemories,
  removePetMemory,
  type PetMemoryEntry
} from '@renderer/lib/pet/pet-memory'

export function PetMemoryTab(): React.JSX.Element {
  const { t } = useTranslation('pet')
  const [entries, setEntries] = useState<PetMemoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      setEntries(await loadPetMemories())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const add = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setEntries(await appendPetMemories([text]))
  }

  const remove = async (index: number): Promise<void> => {
    setEntries(await removePetMemory(index))
  }

  // Two-step clear: first click arms, second click within 3s wipes.
  const clearAll = async (): Promise<void> => {
    if (!confirmClear) {
      setConfirmClear(true)
      window.setTimeout(() => setConfirmClear(false), 3000)
      return
    }
    setConfirmClear(false)
    await clearPetMemories()
    setEntries([])
  }

  const openFile = async (): Promise<void> => {
    const path = await ensurePetMemoryFile()
    await ipcClient.invoke('shell:openPath', path)
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">{t('memory.desc')}</p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t('memory.count', { count: entries.length })}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => void refresh()}
          >
            {loading ? (
              <Loader2 className="mr-1 size-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 size-3" />
            )}
            {t('memory.refresh')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => void openFile()}
          >
            <FileText className="mr-1 size-3" />
            {t('memory.openFile')}
          </Button>
          <Button
            size="sm"
            variant={confirmClear ? 'destructive' : 'ghost'}
            className="h-7 text-xs"
            disabled={entries.length === 0}
            onClick={() => void clearAll()}
          >
            <Trash2 className="mr-1 size-3" />
            {t(confirmClear ? 'memory.clearConfirm' : 'memory.clear')}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
          placeholder={t('memory.addPlaceholder')}
          maxLength={120}
          className="h-8 text-sm"
        />
        <Button
          size="sm"
          variant="secondary"
          className="h-8 shrink-0"
          disabled={!draft.trim()}
          onClick={() => void add()}
        >
          <Plus className="mr-1 size-3.5" />
          {t('memory.add')}
        </Button>
      </div>

      {entries.length === 0 && !loading ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/70 px-4 py-8 text-center">
          <BookOpen className="size-5 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">{t('memory.empty')}</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {entries.map((entry, index) => (
            <div
              key={`${entry.date}-${index}`}
              className="group flex items-start gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2"
            >
              <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {entry.date}
              </span>
              <p className="min-w-0 flex-1 break-words text-xs leading-relaxed">{entry.text}</p>
              <button
                type="button"
                title={t('memory.delete')}
                onClick={() => void remove(index)}
                className="mt-0.5 hidden shrink-0 rounded-md p-0.5 text-muted-foreground group-hover:block hover:text-red-400"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
