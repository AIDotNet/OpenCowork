import * as React from 'react'
import { ChevronDown, ChevronUp, FileCode2, LocateFixed, Trash2, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import type { SelectedFileItem } from '@renderer/lib/select-file-editor'

interface SelectedFileBarProps {
  files: SelectedFileItem[]
  highlightedFileId?: string | null
  onPreview: (file: SelectedFileItem) => void
  onLocate: (fileId: string) => void
  onRemove: (fileId: string) => void
  onClear: () => void
}

const COLLAPSED_VISIBLE_COUNT = 3

export function SelectedFileBar({
  files,
  highlightedFileId,
  onPreview,
  onLocate,
  onRemove,
  onClear
}: SelectedFileBarProps): React.JSX.Element | null {
  const [expanded, setExpanded] = React.useState(false)

  React.useEffect(() => {
    if (files.length <= COLLAPSED_VISIBLE_COUNT) {
      setExpanded(false)
    }
  }, [files.length])

  if (files.length === 0) return null

  const collapsed = files.length > COLLAPSED_VISIBLE_COUNT && !expanded
  const visibleFiles = collapsed ? files.slice(0, COLLAPSED_VISIBLE_COUNT) : files
  const hiddenCount = Math.max(0, files.length - visibleFiles.length)

  return (
    <div className="px-1 pb-2">
      <div className="overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-b from-blue-500/6 to-background shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-xl border border-blue-500/20 bg-blue-500/10">
              <FileCode2 className="size-3.5 text-blue-500" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-foreground">已选文件</div>
              <div className="text-[10px] text-muted-foreground">拖入输入框后会以内联文件组件展示</div>
            </div>
            <span className="rounded-full border border-border/60 bg-background/90 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {files.length}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {files.length > COLLAPSED_VISIBLE_COUNT && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 rounded-lg px-2 text-[10px]"
                onClick={() => setExpanded((prev) => !prev)}
              >
                {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                {expanded ? '收起' : `更多 ${hiddenCount}`}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 rounded-lg px-2 text-[10px] text-muted-foreground hover:text-destructive"
              onClick={onClear}
            >
              <Trash2 className="size-3" />
              清空
            </Button>
          </div>
        </div>

        <div className="grid gap-2 p-2">
          {visibleFiles.map((file) => {
            const isHighlighted = highlightedFileId === file.id
            return (
              <div
                key={file.id}
                id={`selected-file-bar-item-${file.id}`}
                className={cn(
                  'group/file-item flex items-center gap-2 rounded-xl border px-2.5 py-2 transition-all',
                  isHighlighted
                    ? 'border-blue-500/25 bg-blue-500/10 ring-2 ring-blue-400/30 ring-offset-1 ring-offset-background'
                    : 'border-border/50 bg-background/80 hover:border-blue-500/20 hover:bg-blue-500/5'
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => onPreview(file)}
                  title={file.previewPath}
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-blue-500/15 bg-blue-500/8 text-blue-600 dark:text-blue-300">
                    <FileCode2 className="size-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-foreground">{file.name}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {file.sendPath}
                    </div>
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-blue-500/10 hover:text-blue-600"
                        onClick={() => onLocate(file.id)}
                      >
                        <LocateFixed className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>定位正文引用</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => onRemove(file.id)}
                      >
                        <X className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>移除文件</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
