import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useUIStore } from '@renderer/stores/ui-store'

import { Separator } from '@renderer/components/ui/separator'

const shortcutGroups = [
  {
    label: 'General',
    items: [
      { keys: 'Ctrl+N', description: 'New conversation' },
      { keys: 'Ctrl+Shift+N', description: 'New session (next mode)' },
      { keys: 'Ctrl+D', description: 'Duplicate session' },
      { keys: 'Ctrl+P', description: 'Pin/unpin session' },
      { keys: 'Ctrl+,', description: 'Open settings' },
      { keys: 'Ctrl+/', description: 'Keyboard shortcuts' },
      { keys: 'Ctrl+Shift+A', description: 'Toggle auto-approve' },
      { keys: 'Ctrl+Shift+Del', description: 'Delete all sessions' },
      { keys: 'Ctrl+Shift+D', description: 'Toggle dark/light theme' },
      { keys: 'Ctrl+Shift+S', description: 'Backup all sessions (JSON)' },
      { keys: 'Ctrl+Shift+O', description: 'Import sessions from JSON' },
    ],
  },
  {
    label: 'Navigation',
    items: [
      { keys: 'Ctrl+B', description: 'Toggle sidebar' },
      { keys: 'Ctrl+Shift+B', description: 'Toggle right panel' },
      { keys: 'Ctrl+K', description: 'Command Palette' },
      { keys: 'Ctrl+↑/↓', description: 'Previous/next session' },
      { keys: 'Ctrl+1/2/3', description: 'Switch mode (Chat/Cowork/Code)' },
      { keys: 'Ctrl+Home/End', description: 'Scroll to top/bottom' },
      { keys: 'Ctrl+Shift+T', description: 'Cycle right panel tab' },
    ],
  },
  {
    label: 'Chat',
    items: [
      { keys: 'Enter', description: 'Send message' },
      { keys: 'Ctrl+Enter', description: 'Send message (alt)' },
      { keys: 'Shift+Enter', description: 'New line' },
      { keys: 'Escape', description: 'Stop streaming' },
      { keys: 'Ctrl+L', description: 'Clear conversation' },
      { keys: 'Ctrl+Shift+E', description: 'Export conversation' },
      { keys: 'Ctrl+Shift+C', description: 'Copy conversation' },
    ],
  },
  {
    label: 'Tool Permissions',
    items: [
      { keys: 'Y', description: 'Allow tool execution' },
      { keys: 'N / Esc', description: 'Deny tool execution' },
    ],
  },
]

export function KeyboardShortcutsDialog(): React.JSX.Element {
  const open = useUIStore((s) => s.shortcutsOpen)
  const setOpen = useUIStore((s) => s.setShortcutsOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>Quick actions available throughout the app</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {shortcutGroups.map((group, gi) => (
            <div key={group.label}>
              {gi > 0 && <Separator className="mb-3" />}
              <p className="mb-1 px-2 text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map((s) => (
                  <div
                    key={s.keys}
                    className="flex items-center justify-between rounded-md px-2 py-1 text-sm hover:bg-muted/50"
                  >
                    <span className="text-muted-foreground">{s.description}</span>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground">
                      {s.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
