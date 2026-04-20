import * as React from 'react'

type TooltipProviderProps = {
  children: React.ReactNode
  delayDuration?: number
}

type TooltipProps = {
  children: React.ReactNode
  delayDuration?: number
}

type TooltipTriggerProps = React.HTMLAttributes<HTMLElement> & {
  asChild?: boolean
  children: React.ReactNode
  title?: string
  tooltipLabel?: string
}

type TooltipContentProps = React.HTMLAttributes<HTMLDivElement> & {
  children: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
}

function extractTooltipText(node: React.ReactNode): string {
  const parts: string[] = []

  const visit = (value: React.ReactNode): void => {
    if (value == null || typeof value === 'boolean') return

    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim()
      if (text) parts.push(text)
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }

    if (React.isValidElement<{ children?: React.ReactNode }>(value)) {
      visit(value.props.children)
    }
  }

  visit(node)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function TooltipProvider({ children }: TooltipProviderProps): React.JSX.Element {
  return <>{children}</>
}

function Tooltip({ children }: TooltipProps): React.JSX.Element {
  let tooltipLabel = ''

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child) || child.type !== TooltipContent) return
    tooltipLabel = extractTooltipText(
      (child as React.ReactElement<TooltipContentProps>).props.children
    )
  })

  return (
    <>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child
        if (child.type === TooltipContent) return null
        if (child.type !== TooltipTrigger) return child
        return React.cloneElement(child as React.ReactElement<TooltipTriggerProps>, {
          tooltipLabel
        })
      })}
    </>
  )
}

function TooltipTrigger({
  asChild = false,
  children,
  tooltipLabel,
  title,
  ...props
}: TooltipTriggerProps): React.JSX.Element {
  const resolvedTitle = title ?? tooltipLabel

  if (asChild && React.isValidElement(children)) {
    const childProps = children.props as Record<string, unknown>
    const mergedTitle =
      typeof childProps.title === 'string' && childProps.title.trim().length > 0
        ? (childProps.title as string)
        : resolvedTitle

    return React.cloneElement(children, {
      ...props,
      ...(mergedTitle ? { title: mergedTitle } : {})
    })
  }

  return (
    <span
      {...props}
      data-slot="tooltip-trigger"
      title={resolvedTitle}
      className={typeof props.className === 'string' ? props.className : undefined}
    >
      {children}
    </span>
  )
}

function TooltipContent({ children }: TooltipContentProps): null {
  void children
  return null
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
