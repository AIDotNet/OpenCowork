import { useEffect, useState } from 'react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

/** Tracks and toggles whether the desktop pet window is currently shown. */
export function usePetWindowOpen(): {
  open: boolean
  busy: boolean
  toggle: (next: boolean) => Promise<void>
} {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let disposed = false
    void ipcClient
      .invoke('pet-window:status')
      .then((result) => {
        if (disposed) return
        setOpen((result as { open?: boolean } | null)?.open === true)
      })
      .catch(() => {})
    const off = ipcClient.on('pet-window:changed', (payload) => {
      setOpen((payload as { open?: boolean } | null)?.open === true)
    })
    return () => {
      disposed = true
      off()
    }
  }, [])

  const toggle = async (next: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await ipcClient.invoke(next ? 'pet-window:open' : 'pet-window:close')
      setOpen(next)
    } finally {
      setBusy(false)
    }
  }

  return { open, busy, toggle }
}
