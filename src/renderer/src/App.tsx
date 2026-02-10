import { useEffect } from 'react'
import { Layout } from './components/layout/Layout'
import { Toaster } from './components/ui/sonner'
import { ThemeProvider } from './components/theme-provider'
import { ErrorBoundary } from './components/error-boundary'
import { useSettingsStore } from './stores/settings-store'
import { registerAllTools } from './lib/tools'
import { registerAllProviders } from './lib/api'
import { registerAllViewers } from './lib/preview/register-viewers'
import { toast } from 'sonner'

// Register all built-in tools, API providers, and viewers at startup
registerAllTools()
registerAllProviders()
registerAllViewers()

function App(): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme)

  // Load API key from secure main process storage on startup
  useEffect(() => {
    window.electron.ipcRenderer
      .invoke('settings:get', 'apiKey')
      .then((key) => {
        if (typeof key === 'string' && key) {
          useSettingsStore.getState().updateSettings({ apiKey: key })
        }
      })
      .catch(() => {
        // Ignore — main process may not have a stored key yet
      })
  }, [])

  // Global unhandled promise rejection handler
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent): void => {
      console.error('[Unhandled Rejection]', e.reason)
      toast.error('Unhandled Error', {
        description: e.reason?.message || String(e.reason),
      })
    }
    window.addEventListener('unhandledrejection', handler)
    return () => window.removeEventListener('unhandledrejection', handler)
  }, [])

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme={theme}>
        <Layout />
        <Toaster position="bottom-right" theme="system" richColors />
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
