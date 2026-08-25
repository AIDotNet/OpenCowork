import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { useTheme } from 'next-themes'
import {
  FileCode2,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Server,
  Terminal,
  Upload,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getSshChromePalette,
  getThemePresetDefinition,
  resolveAppThemeMode
} from '@renderer/lib/theme-presets'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useSshStore, type SshTab } from '@renderer/stores/ssh-store'
import { DevPerfOverlayReserve } from '@renderer/components/layout/DevPerfOverlay'
import { WindowControls } from '@renderer/components/layout/WindowControls'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from '@renderer/components/ui/sheet'
import { SshConnectionList } from './SshConnectionList'
import { SshConnectedWorkspace } from './SshConnectedWorkspace'
import {
  getShellTone,
  getTitlebarStyle,
  getToneIconButtonStyle,
  createSshWorkspaceStyle,
  ChromePill
} from './ssh-chrome'
import { ConnectionStage } from './SshConnectionStage'
import { UploadTaskList } from './SshTransferTaskList'

export function SshPage(): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const { t: tSettings } = useTranslation('settings')
  const { resolvedTheme } = useTheme()
  const isMac = /Mac/.test(navigator.userAgent)

  const theme = useSettingsStore((state) => state.theme)
  const themePreset = useSettingsStore((state) => state.themePreset)
  const sshTerminalThemePreset = useSettingsStore((state) => state.sshTerminalThemePreset)
  const animationsEnabled = useSettingsStore((state) => state.animationsEnabled)
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

  // The library is a pinned tab: clicking it restores the last non-terminal
  // section so terminal tabs stay open in the strip instead of taking over
  // the whole page (three-mode exclusivity removed in the M3b redesign).
  const lastLibrarySectionRef = useRef<Exclude<typeof workspaceSection, 'terminal'>>('hosts')
  useEffect(() => {
    if (workspaceSection !== 'terminal') {
      lastLibrarySectionRef.current = workspaceSection
    }
  }, [workspaceSection])

  const handleShowList = useCallback(() => {
    setWorkspaceSection(lastLibrarySectionRef.current)
  }, [setWorkspaceSection])

  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null
  const activeSession = activeTab?.sessionId ? (sessions[activeTab.sessionId] ?? null) : null
  const workspaceSession =
    activeSession ??
    (activeTab
      ? (Object.values(sessions).find(
          (session) =>
            session.connectionId === activeTab.connectionId &&
            (session.status === 'connected' || session.status === 'reconnecting')
        ) ?? null)
      : null)
  const showTerminalView = workspaceSection === 'terminal' && !!activeTabId && openTabs.length > 0
  const activeConnection = activeTab
    ? (connections.find((connection) => connection.id === activeTab.connectionId) ?? null)
    : null
  // A reconnecting session keeps the terminal workspace mounted so scrollback
  // survives the automatic retry loop.
  const terminalConnected =
    !!workspaceSession &&
    (workspaceSession.status === 'connected' || workspaceSession.status === 'reconnecting')
  const activeConnectionAddress = activeConnection
    ? `${activeConnection.username}@${activeConnection.host}:${activeConnection.port}`
    : null
  const shellTone = getShellTone(showTerminalView, terminalConnected)
  const resolvedThemeMode = useMemo(
    () => resolveAppThemeMode(theme === 'system' ? resolvedTheme : theme),
    [resolvedTheme, theme]
  )
  const activeChromePreset = shellTone === 'library' ? themePreset : sshTerminalThemePreset
  const activeChromeThemeTitle = tSettings(getThemePresetDefinition(activeChromePreset).labelKey)
  const activeChromeThemeScope =
    shellTone === 'library'
      ? t('workspace.chrome.interfaceTheme', { defaultValue: 'Interface palette' })
      : t('workspace.chrome.terminalTheme', { defaultValue: 'Terminal palette' })
  const activeChromeThemeBadge = t('workspace.chrome.themeBadge', {
    defaultValue: '{{scope}} · {{theme}}',
    scope: activeChromeThemeScope,
    theme: activeChromeThemeTitle
  })
  const shellPalette = useMemo(
    () => getSshChromePalette(activeChromePreset, resolvedThemeMode),
    [activeChromePreset, resolvedThemeMode]
  )
  const sshWorkspaceStyle = useMemo(
    () => createSshWorkspaceStyle(shellPalette, shellTone),
    [shellPalette, shellTone]
  )
  const stageStatus =
    activeTab?.type === 'terminal' &&
    (activeSession?.status === 'connecting' ||
      activeSession?.status === 'error' ||
      activeSession?.status === 'disconnected')
      ? activeSession.status
      : activeTab?.status === 'connecting' || activeTab?.status === 'error'
        ? activeTab.status
        : null
  const effectiveTerminalStatusOpen = showTerminalView && terminalConnected && terminalStatusOpen
  const chromeEyebrow = showTerminalView
    ? t('workspace.chrome.terminalEyebrow', { defaultValue: 'SSH Terminal' })
    : workspaceSection === 'sftp'
      ? t('workspace.chrome.sftpEyebrow', { defaultValue: 'SSH Files' })
      : t('workspace.chrome.hostsEyebrow', { defaultValue: 'SSH Workspace' })
  const chromeTitle = showTerminalView
    ? stageStatus === 'connecting'
      ? t('workspace.chrome.connectingTitle', { defaultValue: 'Connecting' })
      : stageStatus === 'error'
        ? t('workspace.chrome.errorTitle', { defaultValue: 'Connection failed' })
        : stageStatus === 'disconnected'
          ? t('workspace.chrome.disconnectedTitle', { defaultValue: 'Session closed' })
          : (activeConnection?.name ?? activeTab?.connectionName ?? t('terminalLabel'))
    : workspaceSection === 'sftp'
      ? t('workspace.chrome.sftpTitle', { defaultValue: 'SFTP Workspace' })
      : t('workspace.chrome.hostsTitle', { defaultValue: 'Host Console' })
  const chromeMeta = showTerminalView
    ? (activeConnectionAddress ??
      t('workspace.currentSession', { defaultValue: 'Terminal session' }))
    : workspaceSection === 'sftp'
      ? t('workspace.chrome.sftpMeta', { defaultValue: 'Remote files and transfers' })
      : t('workspace.chrome.hostsMeta', { defaultValue: 'Hosts, credentials, and tunnels' })

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

    if (activeTab?.type === 'terminal' && !terminalConnected) {
      return (
        <ConnectionStage
          connectionId={activeTab.connectionId}
          connectionName={activeConnection?.name ?? activeTab?.connectionName ?? 'SSH'}
          connectionAddress={activeConnectionAddress ?? activeTab?.connectionName ?? 'SSH'}
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
        {activeConnection && activeTab ? (
          <SshConnectedWorkspace
            connection={activeConnection}
            sessionId={workspaceSession?.id ?? ''}
            activeTab={activeTab}
            showStatusPanel={effectiveTerminalStatusOpen}
            onCloseStatus={() => setTerminalStatusOpen(false)}
          />
        ) : (
          <div
            className="flex h-full items-center justify-center"
            style={{ color: shellPalette.terminalText }}
          >
            <Loader2 className="size-5 animate-spin" />
          </div>
        )}
      </div>
    )
  }, [
    activeConnection,
    activeConnectionAddress,
    activeSession?.error,
    activeSession?.id,
    activeSession?.status,
    activeTab,
    activeTabId,
    workspaceSession?.id,
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
    <div className="flex h-full flex-col overflow-hidden" style={sshWorkspaceStyle}>
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
        <div
          className="min-w-[190px] max-w-[280px] shrink-0 overflow-hidden"
          title={`${chromeEyebrow} · ${chromeTitle} · ${activeChromeThemeBadge} · ${chromeMeta}`}
        >
          <div className="truncate text-[0.62rem] font-semibold uppercase tracking-[0.22em] opacity-65">
            {chromeEyebrow}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <span className="truncate text-[0.86rem] font-semibold">{chromeTitle}</span>
            <span
              className="max-w-[150px] shrink-0 truncate rounded-full px-1.5 py-0.5 text-[0.56rem] font-semibold uppercase tracking-[0.12em]"
              style={
                shellTone === 'terminal'
                  ? {
                      background: shellPalette.terminalPillActive,
                      color: shellPalette.terminalPillActiveText
                    }
                  : shellTone === 'connect'
                    ? {
                        background: shellPalette.connectPillActive,
                        color: shellPalette.connectPillActiveText
                      }
                    : {
                        background: shellPalette.libraryPillActive,
                        color: shellPalette.libraryPillActiveText
                      }
              }
            >
              {activeChromeThemeBadge}
            </span>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
            <ChromePill
              tone={shellTone}
              palette={shellPalette}
              active={!showTerminalView}
              className="shrink-0"
              onClick={handleShowList}
            >
              <Server className="size-3.5 shrink-0" />
              <span className="truncate">
                {t('workspace.libraryTab', { defaultValue: 'Hosts' })}
              </span>
            </ChromePill>
            <AnimatePresence initial={false}>
              {openTabs.map((tab) => {
                const active = showTerminalView && tab.id === activeTabId
                const session = tab.sessionId ? sessions[tab.sessionId] : null
                const isConnected = session?.status === 'connected'
                const isConnecting =
                  tab.type === 'terminal' &&
                  (tab.sessionId ? session?.status === 'connecting' : tab.status === 'connecting')

                return (
                  <motion.div
                    key={tab.id}
                    layout={animationsEnabled ? 'position' : false}
                    initial={animationsEnabled ? { opacity: 0, scale: 0.95 } : false}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={animationsEnabled ? { opacity: 0, scale: 0.95 } : undefined}
                    transition={
                      animationsEnabled
                        ? { type: 'spring', stiffness: 400, damping: 30 }
                        : { duration: 0 }
                    }
                    className="flex"
                  >
                    <ChromePill
                      tone={shellTone}
                      palette={shellPalette}
                      active={active}
                      className="max-w-[220px] min-w-[118px] pr-2"
                      onClick={() => useSshStore.getState().setActiveTab(tab.id)}
                    >
                      {tab.type === 'file' ? (
                        <FileCode2 className="size-3.5 shrink-0" />
                      ) : (
                        <Terminal className="size-3.5 shrink-0" />
                      )}
                      <span className="truncate">{tab.title}</span>
                      <AnimatePresence mode="wait" initial={false}>
                        {isConnecting ? (
                          <motion.span
                            key="connecting"
                            initial={animationsEnabled ? { opacity: 0 } : false}
                            animate={{ opacity: 1 }}
                            exit={animationsEnabled ? { opacity: 0 } : undefined}
                            transition={{ duration: animationsEnabled ? 0.12 : 0 }}
                            className="flex shrink-0"
                          >
                            <Loader2 className="size-3 animate-spin" />
                          </motion.span>
                        ) : isConnected ? (
                          <motion.span
                            key="connected"
                            initial={animationsEnabled ? { opacity: 0 } : false}
                            animate={{ opacity: 0.85 }}
                            exit={animationsEnabled ? { opacity: 0 } : undefined}
                            transition={{ duration: animationsEnabled ? 0.12 : 0 }}
                            className="size-2 shrink-0 rounded-full bg-current"
                          />
                        ) : null}
                      </AnimatePresence>
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
                  </motion.div>
                )
              })}
            </AnimatePresence>
          </div>

          <button
            type="button"
            onClick={handlePrimaryPlus}
            className="titlebar-no-drag inline-flex size-8 shrink-0 items-center justify-center rounded-[12px] transition-opacity hover:opacity-80"
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
                className="inline-flex items-center gap-1 rounded-[12px] px-2.5 py-2 text-[0.78rem] font-medium transition-opacity hover:opacity-80"
                style={getToneIconButtonStyle(shellTone, shellPalette)}
                title={t('workspace.uploads.title')}
              >
                <Upload className="size-4" />
                {activeUploadCount > 0 ? (
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[0.68rem] font-semibold"
                    style={{
                      background: shellPalette.badge,
                      color: shellPalette.accentContrast
                    }}
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
        </div>

        <DevPerfOverlayReserve />
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
