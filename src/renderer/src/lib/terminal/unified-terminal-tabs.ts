import { MonitorSmartphone, SquareTerminal, type LucideIcon } from 'lucide-react'
import type { SshConnection, SshSession, SshTab } from '@renderer/stores/ssh-store'
import type { LocalTerminalTab } from '@renderer/stores/terminal-store'

export type UnifiedTerminalTab =
  | {
      id: string
      type: 'local'
      title: string
      badge: 'LOCAL'
      icon: LucideIcon
      status: 'running' | 'exited' | 'error'
      cwd: string
      shell: string
      exitCode?: number
      meta: string
      localTabId: string
    }
  | {
      id: string
      type: 'ssh'
      title: string
      badge: 'SSH'
      icon: LucideIcon
      status: 'connecting' | 'connected' | 'disconnected' | 'error'
      cwd: string
      shell: string
      meta: string
      sessionId: string | null
      connectionId: string
      connectionName: string
      sshTabId: string
    }

export function buildSshTerminalTitle(
  connection?: Pick<SshConnection, 'username' | 'host'> | null,
  fallbackTitle?: string
): string {
  const username = connection?.username?.trim() ?? ''
  const host = connection?.host?.trim() ?? ''

  if (!username && !host) return fallbackTitle?.trim() || 'SSH'
  if (!username) return host
  if (!host) return username
  return `${username}@${host}`
}

export function buildUnifiedTerminalTabs({
  localTabs,
  sshOpenTabs,
  sshConnections,
  sshSessions
}: {
  localTabs: LocalTerminalTab[]
  sshOpenTabs: SshTab[]
  sshConnections: SshConnection[]
  sshSessions: Record<string, SshSession>
}): UnifiedTerminalTab[] {
  const localUnifiedTabs: UnifiedTerminalTab[] = localTabs.map((tab) => ({
    id: `local:${tab.id}`,
    type: 'local',
    title: tab.title,
    badge: 'LOCAL',
    icon: SquareTerminal,
    status: tab.status,
    cwd: tab.cwd,
    shell: tab.shell,
    exitCode: tab.exitCode,
    meta: tab.cwd || tab.shell || '-',
    localTabId: tab.id
  }))

  const sshUnifiedTabs: UnifiedTerminalTab[] = sshOpenTabs
    .filter((tab) => tab.type === 'terminal')
    .map((tab) => {
      const connection = sshConnections.find((item) => item.id === tab.connectionId)
      const session = tab.sessionId ? sshSessions[tab.sessionId] : null

      return {
        id: `ssh:${tab.id}`,
        type: 'ssh',
        title: buildSshTerminalTitle(connection, tab.title || tab.connectionName),
        badge: 'SSH',
        icon: MonitorSmartphone,
        status: tab.sessionId ? (session?.status ?? 'connecting') : (tab.status ?? 'connecting'),
        cwd: connection?.defaultDirectory || '',
        shell: connection ? `${connection.host}:${connection.port}` : '',
        meta: connection?.name || connection?.host || tab.connectionName,
        sessionId: tab.sessionId,
        connectionId: tab.connectionId,
        connectionName: tab.connectionName,
        sshTabId: tab.id
      }
    })

  return [...localUnifiedTabs, ...sshUnifiedTabs]
}

export function getUnifiedActiveTerminalTabId(
  tabs: UnifiedTerminalTab[],
  localActiveTabId: string | null,
  sshActiveTabId: string | null
): string | null {
  if (sshActiveTabId) {
    const sshUnifiedId = `ssh:${sshActiveTabId}`
    if (tabs.some((tab) => tab.id === sshUnifiedId)) return sshUnifiedId
  }

  if (localActiveTabId) {
    const localUnifiedId = `local:${localActiveTabId}`
    if (tabs.some((tab) => tab.id === localUnifiedId)) return localUnifiedId
  }

  return tabs[0]?.id ?? null
}
