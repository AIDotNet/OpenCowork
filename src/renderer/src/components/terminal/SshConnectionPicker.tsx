import { useMemo, useState } from 'react'
import { Loader2, Monitor, Plus, Search, Server } from 'lucide-react'
import { type SshConnection } from '@renderer/stores/ssh-store'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@renderer/components/ui/command'
import { Badge } from '@renderer/components/ui/badge'

interface SshConnectionPickerProps {
  open: boolean
  loading: boolean
  connections: SshConnection[]
  onOpenChange: (open: boolean) => void
  onSelect: (connectionId: string) => void
  onOpenManagePage?: () => void
}

export function SshConnectionPicker({
  open,
  loading,
  connections,
  onOpenChange,
  onSelect,
  onOpenManagePage
}: SshConnectionPickerProps): React.JSX.Element {
  const [query, setQuery] = useState('')

  const filteredConnections = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return connections
    return connections.filter((connection) => {
      const searchText = [connection.name, connection.host, connection.username, String(connection.port)]
        .join(' ')
        .toLowerCase()
      return searchText.includes(keyword)
    })
  }, [connections, query])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0" showCloseButton={false}>
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-base">新建 SSH 终端</DialogTitle>
          <DialogDescription>选择一个已保存的 SSH 连接，立即在终端面板中打开新会话。</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-52 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在加载 SSH 连接...
          </div>
        ) : connections.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <Monitor className="size-10 text-muted-foreground/40" />
            <div className="space-y-1">
              <div className="text-sm font-medium">暂无 SSH 连接</div>
              <div className="text-xs text-muted-foreground">先去 SSH 管理页新增一个连接，再回来新建 SSH 终端。</div>
            </div>
            <Button
              size="sm"
              className="h-8 gap-1 text-xs"
              onClick={() => {
                onOpenChange(false)
                onOpenManagePage?.()
              }}
            >
              <Plus className="size-3.5" />
              打开 SSH 管理页
            </Button>
          </div>
        ) : (
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="搜索名称 / 主机 / 用户名 / 端口"
            />
            <CommandList className="max-h-[360px]">
              <CommandEmpty>
                <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
                  <Search className="size-4" />
                  <span>没有匹配的 SSH 连接</span>
                </div>
              </CommandEmpty>
              <CommandGroup heading={`已保存连接 ${filteredConnections.length}`}>
                {filteredConnections.map((connection) => (
                  <CommandItem
                    key={connection.id}
                    value={`${connection.name} ${connection.host} ${connection.username} ${connection.port}`}
                    className="items-start gap-3 px-3 py-3"
                    onSelect={() => onSelect(connection.id)}
                  >
                    <Server className="mt-0.5 size-4 text-muted-foreground" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{connection.name}</span>
                        <Badge variant="outline" className="h-5 px-1.5 text-[10px] uppercase tracking-wide">
                          SSH
                        </Badge>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {connection.username}@{connection.host}:{connection.port}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </DialogContent>
    </Dialog>
  )
}
