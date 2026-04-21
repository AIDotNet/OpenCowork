import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import { useTranslation } from 'react-i18next'
import {
  Bell,
  ChevronDown,
  FolderOpen,
  Loader2,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Terminal,
  Upload,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getSshChromePalette,
  resolveAppThemeMode,
  type SshChromePalette
} from '@renderer/lib/theme-presets'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useSshStore, type SshTab } from '@renderer/stores/ssh-store'
import { WindowControls } from '@renderer/components/layout/WindowControls'
import { Button } from '@renderer/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from '@renderer/components/ui/sheet'
import { SshConnectionList } from './SshConnectionList'
import { SshFileEditor } from './SshFileEditor'
import { SshTerminalThemePanel } from './SshTerminalThemePanel'
import { SshTerminal } from './SshTerminal'
import { SshTerminalStatusPanel } from './SshTerminalStatusPanel'

type ShellTone = 'library' | 'connect' | 'terminal'

function getShellTone(showTerminalView: boolean, connected: boolean): ShellTone {
  if (!showTerminalView) return 'library'
  if (connected) return 'terminal'
  return 'connect'
}

function getTitlebarStyle(tone: ShellTone, palette: SshChromePalette): React.CSSProperties {
  if (tone === 'terminal') {
    return {
      background: palette.terminalFrame,
      borderColor: palette.terminalBorder,
      color: palette.terminalText
    }
  }

  if (tone === 'connect') {
    return {
      background: palette.connectFrame,
      borderColor: palette.connectBorder,
      color: palette.connectText
    }
  }

  return {
    background: `linear-gradient(90deg, ${palette.libraryFrameStart} 0%, ${palette.libraryFrameEnd} 100%)`,
    borderColor: palette.libraryBorder,
    color: palette.libraryText
  }
}

function getChromePillStyle(
  tone: ShellTone,
  active: boolean,
  palette: SshChromePalette
): React.CSSProperties {
  if (tone === 'terminal') {
    return active
      ? {
          background: palette.terminalPillActive,
          color: palette.terminalPillActiveText,
          boxShadow: `inset 0 0 0 1px ${palette.panelBorder}`
        }
      : {
          background: palette.terminalPill,
          color: palette.terminalPillText
        }
  }

  if (tone === 'connect') {
    return active
      ? {
          background: palette.connectPillActive,
          color: palette.connectPillActiveText
        }
      : {
          background: palette.connectPill,
          color: palette.connectPillText
        }
  }

  return active
    ? {
        background: palette.libraryPillActive,
        color: palette.libraryPillActiveText,
        boxShadow: `inset 0 0 0 1px ${palette.panelBorder}`
      }
    : {
        background: palette.libraryPill,
        color: palette.libraryPillText
      }
}

function getToneIconButtonStyle(tone: ShellTone, palette: SshChromePalette): React.CSSProperties {
  if (tone === 'terminal') {
    return { color: palette.terminalPillText }
  }
  if (tone === 'connect') {
    return { color: palette.connectPillText }
  }
  return { color: palette.libraryPillText }
}

function ChromePill({
  active,
  tone,
  palette,
  children,
  className,
  onClick
}: {
  active?: boolean
  tone: ShellTone
  palette: SshChromePalette
  children: React.ReactNode
  className?: string
  onClick?: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'titlebar-no-drag inline-flex h-8 items-center gap-2 rounded-[12px] px-4 text-[0.88rem] font-medium transition-all hover:opacity-90',
        className
      )}
      style={getChromePillStyle(tone, !!active, palette)}
    >
      {children}
    </button>
  )
}

function ConnectionStage({
  connectionName,
  sessionStatus,
  sessionError,
  palette,
  onClose,
  onShowList,
  onRetry
}: {
  connectionName: string
  sessionStatus: 'connecting' | 'error' | 'disconnected' | null
  sessionError?: string
  palette: SshChromePalette
  onClose: () => void
  onShowList: () => void
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const [showLogs, setShowLogs] = useState(false)

  const isConnecting = sessionStatus === 'connecting'
  const steps = [
    {
      key: 'dial',
      active: isConnecting,
      done: !!sessionStatus
    },
    {
      key: 'auth',
      active: isConnecting,
      done: sessionStatus === 'connecting'
    },
    {
      key: 'shell',
      active: false,
      done: false
    }
  ]

  return (
    <div
      className="flex flex-1 items-start justify-center overflow-auto px-6 py-14"
      style={{ background: palette.canvas }}
    >
      <div className="w-full max-w-[700px]">
        <div className="mx-auto flex max-w-[380px] items-start justify-between gap-6">
          <div className="flex items-start gap-4">
            <div
              className="flex size-10 shrink-0 items-center justify-center rounded-[14px] text-white shadow-[0_14px_30px_rgba(15,138,166,0.22)]"
              style={{ background: palette.accent }}
            >
              <Terminal className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[1.1rem] font-semibold" style={{ color: palette.text }}>
                {connectionName}
              </div>
              <div className="mt-1 text-[0.82rem]" style={{ color: palette.muted }}>
                SSH {connectionName}:22
              </div>
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="h-10 rounded-2xl px-4 text-[0.85rem] font-semibold shadow-none hover:opacity-90"
            style={{
              borderColor: palette.panelBorder,
              background: palette.panel,
              color: palette.terminalText
            }}
            onClick={() => setShowLogs((current) => !current)}
          >
            {t('workspace.showLogs', { defaultValue: 'Show logs' })}
          </Button>
        </div>

        <div className="mx-auto mt-8 flex max-w-[380px] items-center gap-3">
          {steps.map((step, index) => (
            <div key={step.key} className="flex flex-1 items-center gap-3">
              <div
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-semibold text-white"
                style={{ background: step.done ? palette.accent : palette.muted }}
              >
                {index + 1}
              </div>
              {index < steps.length - 1 ? (
                <div
                  className="h-1 flex-1 rounded-full"
                  style={{ background: step.done ? palette.accent : palette.muted }}
                />
              ) : null}
            </div>
          ))}
        </div>

        <div className="mx-auto mt-12 max-w-[380px]">
          <h2
            className="text-[2rem] font-semibold tracking-[-0.03em]"
            style={{ color: palette.text }}
          >
            {sessionStatus === 'error'
              ? t('workspace.connectFailedTitle', {
                  defaultValue: 'Connection could not complete.'
                })
              : t('workspace.connectingTitle', {
                  defaultValue: 'Are you sure you want to connect?'
                })}
          </h2>
          <p className="mt-8 text-[1rem] leading-7" style={{ color: palette.text }}>
            {sessionStatus === 'error'
              ? sessionError ||
                t('workspace.connectFailedBody', {
                  defaultValue:
                    'The SSH client returned an error before the shell opened. You can review the logs or retry the connection.'
                })
              : t('workspace.connectingBody', {
                  defaultValue:
                    'OpenCowork is preparing the secure transport, authenticating your host profile, and waiting for the remote shell to become interactive.'
                })}
          </p>
          <p className="mt-6 text-[0.95rem] leading-7" style={{ color: palette.muted }}>
            {sessionStatus === 'error'
              ? t('workspace.connectFailedHint', {
                  defaultValue:
                    'Check the credentials, jump host, or server reachability and try again.'
                })
              : t('workspace.connectingHint', {
                  defaultValue:
                    'You can leave this screen open or return to the host list while the session finishes dialing.'
                })}
          </p>

          <div className="mt-10 flex flex-wrap gap-3">
            <Button
              variant="outline"
              size="sm"
              className="h-11 rounded-2xl px-5 text-[0.9rem] font-semibold shadow-none hover:opacity-90"
              style={{
                borderColor: palette.panelBorder,
                background: palette.panel,
                color: palette.terminalText
              }}
              onClick={onClose}
            >
              {t('workspace.close', { defaultValue: 'Close' })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-11 rounded-2xl px-5 text-[0.9rem] font-semibold shadow-none hover:opacity-90"
              style={{
                borderColor: palette.panelBorder,
                background: palette.panel,
                color: palette.terminalText
              }}
              onClick={onShowList}
            >
              {t('workspace.backToHosts', { defaultValue: 'Back to hosts' })}
            </Button>
            <Button
              size="sm"
              className="h-11 rounded-2xl px-5 text-[0.9rem] font-semibold text-white hover:opacity-90"
              style={{ background: palette.accent, color: palette.accentContrast }}
              onClick={onRetry}
            >
              {sessionStatus === 'error'
                ? t('terminal.reconnect')
                : t('workspace.keepWaiting', { defaultValue: 'Keep waiting' })}
            </Button>
          </div>

          {showLogs ? (
            <div
              className="mt-8 rounded-[24px] border p-5 shadow-[0_18px_42px_rgba(111,133,165,0.12)]"
              style={{ borderColor: palette.panelBorder, background: palette.surface }}
            >
              <div
                className="text-[0.8rem] font-semibold uppercase tracking-[0.2em]"
                style={{ color: palette.muted }}
              >
                {t('workspace.connectionLog', { defaultValue: 'Connection log' })}
              </div>
              <div
                className="mt-4 space-y-2 font-mono text-[0.8rem]"
                style={{ color: palette.text }}
              >
                <div>• resolving profile: {connectionName}</div>
                <div>• session state: {sessionStatus ?? 'idle'}</div>
                <div>• transport: ssh2</div>
                {sessionError ? <div>• error: {sessionError}</div> : <div>• waiting for shell</div>}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function SshPage(): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const { resolvedTheme } = useTheme()
  const isMac = /Mac/.test(navigator.userAgent)

  const themePreset = useSettingsStore((state) => state.themePreset)
  const openTabs = useSshStore((state) => state.openTabs)
  const activeTabId = useSshStore((state) => state.activeTabId)
  const sessions = useSshStore((state) => state.sessions)
  const connections = useSshStore((state) => state.connections)
  const workspaceSection = useSshStore((state) => state.workspaceSection)
  const setWorkspaceSection = useSshStore((state) => state.setWorkspaceSection)
  const loadAll = useSshStore((state) => state.loadAll)
  const loaded = useSshStore((state) => state._loaded)
  const transferTasks = useSshStore((state) => state.transferTasks)
  const setDetailConnectionId = useSshStore((state) => state.setDetailConnectionId)
  const setInspectorMode = useSshStore((state) => state.setInspectorMode)
  const [terminalStatusOpen, setTerminalStatusOpen] = useState(false)

  const uploadTaskList = Object.values(transferTasks).sort(
    (left, right) => right.updatedAt - left.updatedAt
  )
  const activeUploadCount = uploadTaskList.filter(
    (task) => task.stage !== 'done' && task.stage !== 'error' && task.stage !== 'canceled'
  ).length

  useEffect(() => {
    if (!loaded) void loadAll()
  }, [loaded, loadAll])

  const handleConnect = useCallback(
    async (connectionId: string) => {
      const store = useSshStore.getState()
      const connection = store.connections.find((item) => item.id === connectionId)
      if (!connection) return

      const existingTab = store.openTabs.find(
        (tab) => tab.connectionId === connectionId && tab.type === 'terminal'
      )
      if (existingTab) {
        store.setActiveTab(existingTab.id)
        return
      }

      const existingSession = Object.values(store.sessions).find(
        (session) => session.connectionId === connectionId && session.status === 'connected'
      )
      if (existingSession) {
        const tabId = `tab-${existingSession.id}`
        store.openTab({
          id: tabId,
          type: 'terminal',
          sessionId: existingSession.id,
          connectionId,
          connectionName: connection.name,
          title: connection.name
        })
        return
      }

      const pendingTabId = `pending-${connectionId}-${Date.now()}`
      store.openTab({
        id: pendingTabId,
        type: 'terminal',
        sessionId: null,
        connectionId,
        connectionName: connection.name,
        title: connection.name,
        status: 'connecting'
      })

      const sessionId = await store.connect(connectionId)
      if (!sessionId) {
        store.closeTab(pendingTabId)
        toast.error(t('connectionFailed'))
        return
      }

      const stillOpen = useSshStore.getState().openTabs.find((tab) => tab.id === pendingTabId)
      if (!stillOpen) {
        await store.disconnect(sessionId)
        return
      }

      const resolvedTabId = `tab-${sessionId}`
      const tab: SshTab = {
        id: resolvedTabId,
        type: 'terminal',
        sessionId,
        connectionId,
        connectionName: connection.name,
        title: connection.name
      }
      store.replaceTab(pendingTabId, tab)
    },
    [t]
  )

  const handleNewTerminal = useCallback(async () => {
    const store = useSshStore.getState()
    const activeTab = store.openTabs.find((tab) => tab.id === store.activeTabId)
    if (!activeTab) return

    const tabCount =
      store.openTabs.filter(
        (tab) => tab.connectionId === activeTab.connectionId && tab.type === 'terminal'
      ).length + 1

    const pendingTabId = `pending-${activeTab.connectionId}-${Date.now()}`
    store.openTab({
      id: pendingTabId,
      type: 'terminal',
      sessionId: null,
      connectionId: activeTab.connectionId,
      connectionName: activeTab.connectionName,
      title: `${activeTab.connectionName} (${tabCount})`,
      status: 'connecting'
    })

    const sessionId = await store.connect(activeTab.connectionId)
    if (!sessionId) {
      store.closeTab(pendingTabId)
      toast.error(t('connectionFailed'))
      return
    }

    const stillOpen = useSshStore.getState().openTabs.find((tab) => tab.id === pendingTabId)
    if (!stillOpen) {
      await store.disconnect(sessionId)
      return
    }

    store.replaceTab(pendingTabId, {
      id: `tab-${sessionId}`,
      type: 'terminal',
      sessionId,
      connectionId: activeTab.connectionId,
      connectionName: activeTab.connectionName,
      title: `${activeTab.connectionName} (${tabCount})`
    })
  }, [t])

  const handleCloseTab = useCallback((tabId: string) => {
    useSshStore.getState().closeTab(tabId)
  }, [])

  const handleShowList = useCallback(() => {
    setWorkspaceSection('hosts')
  }, [setWorkspaceSection])

  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null
  const activeSession =
    activeTab?.type === 'terminal' && activeTab.sessionId ? sessions[activeTab.sessionId] : null
  const showTerminalView = workspaceSection === 'terminal' && !!activeTabId && openTabs.length > 0
  const activeConnection = activeTab
    ? (connections.find((connection) => connection.id === activeTab.connectionId) ?? null)
    : null
  const terminalConnected = activeSession?.status === 'connected'
  const shellTone = getShellTone(showTerminalView, terminalConnected)
  const shellPalette = useMemo(
    () => getSshChromePalette(themePreset, resolveAppThemeMode(resolvedTheme)),
    [resolvedTheme, themePreset]
  )
  const stageStatus =
    activeSession?.status === 'connecting' ||
    activeSession?.status === 'error' ||
    activeSession?.status === 'disconnected'
      ? activeSession.status
      : activeTab?.status === 'connecting' || activeTab?.status === 'error'
        ? activeTab.status
        : null
  const effectiveTerminalStatusOpen = showTerminalView && terminalConnected && terminalStatusOpen

  const handlePrimaryPlus = useCallback(() => {
    if (showTerminalView) {
      void handleNewTerminal()
      return
    }

    setWorkspaceSection('hosts')
    setInspectorMode('create')
    setDetailConnectionId(null)
  }, [
    handleNewTerminal,
    setDetailConnectionId,
    setInspectorMode,
    setWorkspaceSection,
    showTerminalView
  ])

  const handleRetryActive = useCallback(() => {
    if (!activeConnection) return
    handleConnect(activeConnection.id)
  }, [activeConnection, handleConnect])

  const body = useMemo(() => {
    if (!showTerminalView) {
      return <SshConnectionList onConnect={(connectionId) => void handleConnect(connectionId)} />
    }

    if (!terminalConnected) {
      return (
        <ConnectionStage
          connectionName={activeConnection?.name ?? activeTab?.connectionName ?? 'SSH'}
          sessionStatus={stageStatus}
          sessionError={activeSession?.error ?? activeTab?.error}
          palette={shellPalette}
          onClose={() => {
            if (activeTab) handleCloseTab(activeTab.id)
          }}
          onShowList={handleShowList}
          onRetry={handleRetryActive}
        />
      )
    }

    return (
      <div
        className="flex flex-1 overflow-hidden"
        style={{ background: shellPalette.terminalCanvas }}
      >
        <div className="relative flex min-w-0 flex-1 flex-col">
          {openTabs.map((tab) => (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{ display: tab.id === activeTabId ? undefined : 'none' }}
            >
              {tab.type === 'file' ? (
                tab.filePath ? (
                  <SshFileEditor
                    connectionId={tab.connectionId}
                    filePath={tab.filePath}
                    sessionId={tab.sessionId ?? undefined}
                  />
                ) : null
              ) : tab.sessionId ? (
                <SshTerminal sessionId={tab.sessionId} connectionName={tab.connectionName} />
              ) : (
                <div className="flex h-full items-center justify-center text-white/70">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              )}
            </div>
          ))}
        </div>

        {activeConnection && effectiveTerminalStatusOpen ? (
          <SshTerminalStatusPanel
            connectionId={activeConnection.id}
            connectionName={activeConnection.name}
            host={activeConnection.host}
            onClose={() => setTerminalStatusOpen(false)}
          />
        ) : null}
      </div>
    )
  }, [
    activeConnection,
    activeSession?.error,
    activeTab,
    activeTabId,
    handleCloseTab,
    handleConnect,
    handleRetryActive,
    handleShowList,
    openTabs,
    showTerminalView,
    stageStatus,
    terminalConnected,
    effectiveTerminalStatusOpen,
    shellPalette
  ])

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{
        background: shellTone === 'terminal' ? shellPalette.terminalCanvas : shellPalette.canvas
      }}
    >
      <div
        className={cn(
          'titlebar-drag relative flex h-[52px] shrink-0 items-center gap-3 border-b px-3',
          isMac ? 'pl-[78px]' : 'pr-[132px]'
        )}
        style={{
          ...getTitlebarStyle(shellTone, shellPalette),
          paddingRight: isMac ? undefined : 'calc(132px + 0.75rem)'
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          <ChromePill
            tone={shellTone}
            palette={shellPalette}
            active={!showTerminalView && workspaceSection !== 'sftp'}
            onClick={() => setWorkspaceSection('hosts')}
          >
            <span>{t('workspace.vaults', { defaultValue: 'Vaults' })}</span>
            <ChevronDown className="size-3.5" />
          </ChromePill>

          <ChromePill
            tone={shellTone}
            palette={shellPalette}
            active={!showTerminalView && workspaceSection === 'sftp'}
            onClick={() => setWorkspaceSection('sftp')}
          >
            <FolderOpen className="size-3.5" />
            <span>SFTP</span>
          </ChromePill>

          {openTabs.map((tab) => {
            const active = showTerminalView && tab.id === activeTabId
            const session = tab.sessionId ? sessions[tab.sessionId] : null
            const isConnected = session?.status === 'connected'
            const isConnecting =
              tab.type === 'terminal' &&
              (tab.sessionId ? session?.status === 'connecting' : tab.status === 'connecting')

            return (
              <ChromePill
                key={tab.id}
                tone={shellTone}
                palette={shellPalette}
                active={active}
                className="max-w-[240px] pr-2"
                onClick={() => useSshStore.getState().setActiveTab(tab.id)}
              >
                <Terminal className="size-3.5 shrink-0" />
                <span className="truncate">{tab.title}</span>
                {isConnecting ? (
                  <Loader2 className="size-3 animate-spin shrink-0" />
                ) : isConnected ? (
                  <span className="size-2 shrink-0 rounded-full bg-current opacity-85" />
                ) : null}
                <span
                  className="rounded-full p-1 transition-opacity hover:opacity-75"
                  onClick={(event) => {
                    event.stopPropagation()
                    handleCloseTab(tab.id)
                  }}
                >
                  <X className="size-3" />
                </span>
              </ChromePill>
            )
          })}

          <button
            type="button"
            onClick={handlePrimaryPlus}
            className="titlebar-no-drag inline-flex size-8 items-center justify-center rounded-[12px] transition-opacity hover:opacity-80"
            style={getToneIconButtonStyle(shellTone, shellPalette)}
            title={showTerminalView ? t('terminal.newTab') : t('newConnection')}
          >
            <Plus className="size-4" />
          </button>
        </div>

        <div className="titlebar-no-drag flex items-center gap-1">
          {showTerminalView && terminalConnected ? (
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center rounded-[12px] transition-opacity hover:opacity-80"
              style={getToneIconButtonStyle(shellTone, shellPalette)}
              onClick={() => setTerminalStatusOpen((current) => !current)}
              title={t('workspace.terminalStatus.title', { defaultValue: 'Terminal status' })}
            >
              {effectiveTerminalStatusOpen ? (
                <PanelRightClose className="size-4" />
              ) : (
                <PanelRightOpen className="size-4" />
              )}
            </button>
          ) : null}

          <Sheet>
            <SheetTrigger asChild>
              <button
                type="button"
                className="inline-flex size-8 items-center justify-center rounded-[12px] transition-opacity hover:opacity-80"
                style={getToneIconButtonStyle(shellTone, shellPalette)}
                title={t('workspace.terminalTheme.title')}
              >
                <Palette className="size-4" />
              </button>
            </SheetTrigger>
            <SheetContent className="gap-0 sm:max-w-[460px]">
              <SheetHeader className="border-b border-border px-5 py-5 pr-12">
                <SheetTitle>{t('workspace.terminalTheme.title')}</SheetTitle>
                <SheetDescription>{t('workspace.terminalTheme.sheetDescription')}</SheetDescription>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto px-5 py-5">
                <SshTerminalThemePanel />
              </div>
            </SheetContent>
          </Sheet>

          <Sheet>
            <SheetTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-[12px] px-2.5 py-2 text-[0.78rem] font-medium transition-opacity hover:opacity-80"
                style={getToneIconButtonStyle(shellTone, shellPalette)}
                title={t('workspace.uploads.title')}
              >
                <Upload className="size-4" />
                {activeUploadCount > 0 ? (
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[0.68rem] font-semibold text-white"
                    style={{ background: shellPalette.badge }}
                  >
                    {activeUploadCount}
                  </span>
                ) : null}
              </button>
            </SheetTrigger>
            <SheetContent className="sm:max-w-md">
              <SheetHeader>
                <SheetTitle>{t('workspace.uploads.title')}</SheetTitle>
                <SheetDescription>{t('workspace.uploads.description')}</SheetDescription>
              </SheetHeader>
              <UploadTaskList tasks={uploadTaskList} />
            </SheetContent>
          </Sheet>

          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-[12px] transition-opacity hover:opacity-80"
            style={getToneIconButtonStyle(shellTone, shellPalette)}
            title={t('workspace.notifications', { defaultValue: 'Notifications' })}
          >
            <Bell className="size-4" />
          </button>
        </div>

        {!isMac ? (
          <div className="absolute right-0 top-0 z-10">
            <WindowControls />
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">{body}</div>
    </div>
  )
}

function UploadTaskList({
  tasks
}: {
  tasks: {
    taskId: string
    stage: string
    type?: string
    message?: string
    currentItem?: string
    progress?: {
      current?: number
      total?: number
      percent?: number
      currentBytes?: number
      totalBytes?: number
      processedItems?: number
      totalItems?: number
    }
  }[]
}): React.JSX.Element {
  const { t } = useTranslation('ssh')

  if (tasks.length === 0) {
    return (
      <div className="px-4 pb-4 text-sm text-muted-foreground">{t('workspace.logs.noUploads')}</div>
    )
  }

  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      {tasks.map((task) => {
        const percent = task.progress?.percent
        const canCancel =
          task.stage !== 'done' && task.stage !== 'error' && task.stage !== 'canceled'

        return (
          <div key={task.taskId} className="rounded-2xl border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{task.taskId}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {task.type ? `${task.type} · ` : ''}
                  {t(`workspace.uploads.stages.${task.stage}`, { defaultValue: task.stage })}
                  {task.message ? ` · ${task.message}` : ''}
                  {task.currentItem ? ` · ${task.currentItem}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {canCancel ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void useSshStore.getState().cancelTransfer(task.taskId)}
                  >
                    {t('workspace.uploads.cancel')}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => useSshStore.getState().clearTransferTask(task.taskId)}
                  >
                    {t('workspace.uploads.clear')}
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-3">
              <div className="h-1.5 rounded-full bg-muted">
                <div
                  className="h-1.5 rounded-full bg-primary transition-all"
                  style={{ width: typeof percent === 'number' ? `${percent}%` : '0%' }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-[0.72rem] text-muted-foreground">
                <span>{typeof percent === 'number' ? `${percent}%` : ''}</span>
                <span>
                  {typeof task.progress?.processedItems === 'number'
                    ? `${task.progress.processedItems}`
                    : typeof task.progress?.current === 'number'
                      ? `${task.progress.current}`
                      : ''}
                  {typeof task.progress?.totalItems === 'number'
                    ? ` / ${task.progress.totalItems}`
                    : typeof task.progress?.total === 'number'
                      ? ` / ${task.progress.total}`
                      : ''}
                </span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
