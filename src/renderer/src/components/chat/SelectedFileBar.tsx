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
    <div className="px-3 pt-3 pb-1">
      <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2 shadow-sm">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <FileCode2 className="size-3.5 shrink-0 text-blue-500" />
            <span className="truncate">已选文件</span>
            <span className="rounded-full border border-border/60 bg-background/80 px-1.5 py-0.5 text-[10px]">
              {files.length}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {files.length > COLLAPSED_VISIBLE_COUNT && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[10px]"
                onClick={() => setExpanded((prev) => !prev)}
              >
                {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                {expanded ? '收起' : `展开 ${hiddenCount}`}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[10px] text-muted-foreground hover:text-destructive"
              onClick={onClear}
            >
              <Trash2 className="size-3" />
              清空
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {visibleFiles.map((file) => {
            const isHighlighted = highlightedFileId === file.id
            return (
              <div
                key={file.id}
                id={`selected-file-bar-item-${file.id}`}
                className={cn(
                  'group/file-item flex max-w-full items-center gap-1 rounded-lg border border-blue-500/20 bg-blue-500/10 px-2 py-1 text-xs text-blue-700 shadow-sm dark:text-blue-300',
                  isHighlighted && 'ring-2 ring-blue-400/50 ring-offset-1 ring-offset-background'
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1"
                  onClick={() => onPreview(file)}
                  title={file.previewPath}
                >
                  <FileCode2 className="size-3.5 shrink-0" />
                  <span className="truncate max-w-[220px]">{file.sendPath}</span>
                </button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex size-5 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-blue-500/15 group-hover/file-item:opacity-100"
                      onClick={() => onLocate(file.id)}
                    >
                      <LocateFixed className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>定位正文引用</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex size-5 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-blue-500/15 group-hover/file-item:opacity-100"
                      onClick={() => onRemove(file.id)}
                    >
                      <X className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>移除文件</TooltipContent>
                </Tooltip>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
