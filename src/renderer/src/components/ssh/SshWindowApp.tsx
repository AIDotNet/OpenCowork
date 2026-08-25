import { ConfirmDialogProvider } from '@renderer/components/ui/confirm-dialog'
import { ErrorBoundary } from '@renderer/components/error-boundary'
import { NotifyToastContainer } from '@renderer/components/notify/NotifyWindow'
import { DevPerfOverlay } from '@renderer/components/layout/DevPerfOverlay'
import { ThemeProvider } from '@renderer/components/theme-provider'
import { ThemeRuntimeSync } from '@renderer/components/theme-runtime-sync'
import { Toaster } from '@renderer/components/ui/sonner'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { SshPage } from './SshPage'

/**
 * The SSH window is intentionally isolated from App. Importing App also starts the
 * chat/agent/tool runtime, which is unrelated to SSH and made every SSH window pay
 * the full main-renderer startup cost.
 */
export function SshWindowApp(): React.JSX.Element {
  const theme = useSettingsStore((state) => state.theme)

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme={theme}>
        <ThemeRuntimeSync />
        <SshPage />
        <DevPerfOverlay />
        <Toaster position="bottom-left" theme="system" richColors />
        <ConfirmDialogProvider />
        <NotifyToastContainer />
      </ThemeProvider>
    </ErrorBoundary>
  )
}
