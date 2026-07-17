import { type SshChromePalette } from '@renderer/lib/theme-presets'
import { cn } from '@renderer/lib/utils'
// Titlebar chrome: tones, pill styles and the workspace CSS variable set.

export type ShellTone = 'library' | 'connect' | 'terminal'

export function getShellTone(showTerminalView: boolean, connected: boolean): ShellTone {
  if (!showTerminalView) return 'library'
  if (connected) return 'terminal'
  return 'connect'
}

export function getTitlebarStyle(tone: ShellTone, palette: SshChromePalette): React.CSSProperties {
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

export function getChromePillStyle(
  tone: ShellTone,
  active: boolean,
  palette: SshChromePalette
): React.CSSProperties {
  if (tone === 'terminal') {
    return active
      ? {
          background: palette.terminalPillActive,
          color: palette.terminalPillActiveText,
          boxShadow: `inset 0 0 0 1px ${palette.terminalBorder}`
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
        boxShadow: `inset 0 0 0 1px ${palette.libraryBorder}`
      }
    : {
        background: palette.libraryPill,
        color: palette.libraryPillText
      }
}

export function getToneIconButtonStyle(
  tone: ShellTone,
  palette: SshChromePalette
): React.CSSProperties {
  if (tone === 'terminal') {
    return { color: palette.terminalPillText }
  }
  if (tone === 'connect') {
    return { color: palette.connectPillText }
  }
  return { color: palette.libraryPillText }
}

export type SshWorkspaceStyle = React.CSSProperties & Record<`--${string}`, string>

export function createSshWorkspaceStyle(
  palette: SshChromePalette,
  shellTone: ShellTone
): SshWorkspaceStyle {
  const rootBackground = shellTone === 'terminal' ? palette.terminalCanvas : palette.canvas

  return {
    background: rootBackground,
    '--background': palette.canvas,
    '--foreground': palette.text,
    '--card': palette.surface,
    '--card-foreground': palette.text,
    '--popover': palette.surface,
    '--popover-foreground': palette.text,
    '--primary': palette.accent,
    '--primary-foreground': palette.accentContrast,
    '--secondary': palette.accentSoft,
    '--secondary-foreground': palette.text,
    '--muted': palette.canvasSubtle,
    '--muted-foreground': palette.muted,
    '--accent': palette.accentSoft,
    '--accent-foreground': palette.text,
    '--border': palette.libraryBorder,
    '--input': palette.libraryBorder,
    '--ring': palette.accent,
    '--sidebar': palette.panel,
    '--sidebar-foreground': palette.terminalText,
    '--sidebar-accent': palette.terminalPill,
    '--sidebar-accent-foreground': palette.terminalText,
    '--sidebar-border': palette.panelBorder,
    '--ssh-canvas': palette.canvas,
    '--ssh-canvas-subtle': palette.canvasSubtle,
    '--ssh-surface': palette.surface,
    '--ssh-surface-strong': palette.surfaceStrong,
    '--ssh-border': palette.libraryBorder,
    '--ssh-border-strong': palette.panelBorder,
    '--ssh-text': palette.text,
    '--ssh-muted': palette.muted,
    '--ssh-accent': palette.accent,
    '--ssh-accent-soft': palette.accentSoft,
    '--ssh-accent-contrast': palette.accentContrast,
    '--ssh-success': palette.success,
    '--ssh-success-soft': palette.successSoft,
    '--ssh-warning': palette.warning,
    '--ssh-warning-soft': palette.warningSoft,
    '--ssh-danger': palette.danger,
    '--ssh-danger-soft': palette.dangerSoft,
    '--ssh-panel': palette.panel,
    '--ssh-panel-strong': palette.panelStrong,
    '--ssh-panel-border': palette.panelBorder,
    '--ssh-panel-text': palette.terminalText,
    '--ssh-panel-muted': palette.terminalPillText,
    '--ssh-panel-hover': palette.terminalPill,
    '--ssh-pill': palette.libraryPill,
    '--ssh-pill-active': palette.libraryPillActive,
    '--ssh-pill-text': palette.libraryPillText,
    '--ssh-pill-active-text': palette.libraryPillActiveText
  }
}

export function ChromePill({
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
