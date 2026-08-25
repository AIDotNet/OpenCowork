type FrozenStyle = {
  contain: string
  flexGrow: string
  flexShrink: string
  maxWidth: string
  minWidth: string
  width: string
}

const frozenElements = new Map<HTMLElement, FrozenStyle>()

export function freezeWorkspaceSplitSurfaces(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-resize-freeze]').forEach((element) => {
    if (frozenElements.has(element)) return
    frozenElements.set(element, {
      contain: element.style.contain,
      flexGrow: element.style.flexGrow,
      flexShrink: element.style.flexShrink,
      maxWidth: element.style.maxWidth,
      minWidth: element.style.minWidth,
      width: element.style.width
    })
    const width = `${Math.round(element.getBoundingClientRect().width)}px`
    element.style.contain = 'layout'
    element.style.flexGrow = '0'
    element.style.flexShrink = '0'
    element.style.maxWidth = width
    element.style.minWidth = width
    element.style.width = width
  })
}

export function isWorkspaceSplitResizing(): boolean {
  return frozenElements.size > 0
}

export function unfreezeWorkspaceSplitSurfaces(): void {
  for (const [element, previous] of frozenElements) {
    element.style.contain = previous.contain
    element.style.flexGrow = previous.flexGrow
    element.style.flexShrink = previous.flexShrink
    element.style.maxWidth = previous.maxWidth
    element.style.minWidth = previous.minWidth
    element.style.width = previous.width
  }
  frozenElements.clear()
}
