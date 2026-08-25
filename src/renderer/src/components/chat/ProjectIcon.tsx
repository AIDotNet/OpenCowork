import type { JSX } from 'react'
import { Folder, FolderOpen, Server } from 'lucide-react'
import { DynamicIcon } from 'lucide-react/dynamic'
import { cn } from '@renderer/lib/utils'
import { SESSION_ICONS } from '@renderer/lib/constants/session-icons'

const LUCIDE_PROJECT_ICONS = new Set<string>(SESSION_ICONS)

export function isProjectImageIcon(icon: string): boolean {
  return icon.startsWith('data:image/')
}

export function isLucideProjectIcon(icon: string): boolean {
  return LUCIDE_PROJECT_ICONS.has(icon)
}

export function ProjectIcon({
  icon,
  sshConnectionId,
  expanded = false,
  className
}: {
  icon?: string | null
  sshConnectionId?: string | null
  expanded?: boolean
  className?: string
}): JSX.Element {
  const classes = cn('size-4 shrink-0', className)

  if (icon && isProjectImageIcon(icon)) {
    return (
      <img
        src={icon}
        alt=""
        draggable={false}
        className={cn(classes, 'rounded-[3px] object-cover')}
      />
    )
  }

  if (icon && isLucideProjectIcon(icon)) {
    return <DynamicIcon name={icon as never} className={classes} />
  }

  if (sshConnectionId) {
    return <Server className={classes} />
  }

  return expanded ? <FolderOpen className={classes} /> : <Folder className={classes} />
}
