import { useEffect } from 'react'
import i18n from '../../locales'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { usePetStore } from '@renderer/stores/pet-store'
import { usePetSkinStore } from '@renderer/stores/pet-skin-store'
import { usePetAgentStore } from '@renderer/stores/pet-agent-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { ThemeProvider } from '../theme-provider'
import { ErrorBoundary } from '../error-boundary'
import { PetView } from './PetView'

/**
 * Standalone root for the transparent desktop-pet window (?appView=pet).
 * Deliberately does not mount the full App tree.
 */
export function PetWindow(): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme)
  const language = useSettingsStore((s) => s.language)

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    const root = document.getElementById('root')
    if (root) root.style.background = 'transparent'
  }, [])

  useEffect(() => {
    if (i18n.language !== language) {
      void i18n.changeLanguage(language)
    }
  }, [language])

  // Apply skin/profile changes broadcast from the settings window.
  useEffect(() => {
    return ipcClient.on('pet:sync-event', (payload) => {
      const event = payload as { kind?: string; payload?: unknown } | null
      if (event?.kind === 'skin') {
        // Prefer the id carried in the broadcast: re-reading storage here
        // races with the sender's async persist write and lags one change
        // behind. scan() then refreshes the pose file list from disk.
        const detail = event.payload as { activeSkinId?: string | null } | undefined
        if (detail && 'activeSkinId' in detail) {
          usePetSkinStore.setState({ activeSkinId: detail.activeSkinId ?? null })
          void usePetSkinStore.getState().scan()
        } else {
          void Promise.resolve(usePetSkinStore.persist.rehydrate()).then(() =>
            usePetSkinStore.getState().scan()
          )
        }
      } else if (event?.kind === 'agent-config') {
        void usePetAgentStore.persist.rehydrate()
      } else if (event?.kind === 'profile') {
        const name = (event.payload as { name?: string } | undefined)?.name
        if (typeof name === 'string' && name.trim()) {
          usePetStore.setState({ name: name.trim() })
        }
      }
    })
  }, [])

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme={theme}>
        <PetView />
      </ThemeProvider>
    </ErrorBoundary>
  )
}
