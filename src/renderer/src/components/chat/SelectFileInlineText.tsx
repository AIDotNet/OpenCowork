import * as React from 'react'
import { Icon, Puzzle } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'
import { getFileBaseName, resolveFileTypeIcon } from '@renderer/lib/file-type-icon'
import { parseSelectFileText, type SelectFileTextSegment } from '@renderer/lib/select-file-tags'

interface SelectFileInlineTextProps {
  text: string
  className?: string
  overlay?: boolean
}

const PLUGIN_BADGE_CLASS =
  'border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300'
const FILE_BADGE_CLASS = 'border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300'

function ReferenceIcon({ segment }: { segment: SelectFileTextSegment }): React.JSX.Element {
  if (segment.type === 'plugin') {
    return <Puzzle className="size-3 shrink-0" />
  }
  const { iconNode, className } = resolveFileTypeIcon(segment.text)
  return <Icon iconNode={iconNode} className={cn('size-3 shrink-0', className)} />
}

export function SelectFileInlineText({
  text,
  className,
  overlay = false
}: SelectFileInlineTextProps): React.JSX.Element {
  const segments = React.useMemo(() => parseSelectFileText(text), [text])

  return (
    <span className={cn('whitespace-pre-wrap break-words', className)}>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <React.Fragment key={`${segment.raw}-${index}`}>{segment.text}</React.Fragment>
        }

        const isPlugin = segment.type === 'plugin'
        // File references show the base name; the full path stays available as a tooltip.
        const displayText = isPlugin
          ? segment.text
          : (segment.label ?? getFileBaseName(segment.text))
        const badgeClassName = isPlugin ? PLUGIN_BADGE_CLASS : FILE_BADGE_CLASS

        if (overlay) {
          return (
            <span key={`${segment.raw}-${index}`} className="relative inline-block align-baseline">
              <span className="invisible">{isPlugin ? segment.text : segment.raw}</span>
              <Badge
                variant="secondary"
                title={segment.text}
                className={cn(
                  'absolute inset-0 inline-flex max-w-full items-center justify-start gap-1 overflow-hidden rounded-md border px-2 py-0 text-[12px] font-medium',
                  badgeClassName
                )}
              >
                <ReferenceIcon segment={segment} />
                <span className="truncate">{displayText}</span>
              </Badge>
            </span>
          )
        }

        return (
          <Badge
            key={`${segment.raw}-${index}`}
            variant="secondary"
            title={segment.text}
            className={cn(
              'mx-0.5 inline-flex max-w-full items-center gap-1 overflow-hidden rounded-md border align-baseline text-[12px] font-medium',
              badgeClassName
            )}
          >
            <ReferenceIcon segment={segment} />
            <span className="truncate">{displayText}</span>
          </Badge>
        )
      })}
    </span>
  )
}
