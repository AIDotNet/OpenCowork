import * as React from 'react'
import { cn } from '@renderer/lib/utils'
import {
  editorDocumentToPlainText,
  type EditorDocumentNode,
  type EditorFileNode,
  type SelectedFileItem
} from '@renderer/lib/select-file-editor'

export interface EditorSelectionOffsets {
  start: number
  end: number
}

export interface FileAwareEditorHandle {
  focus: () => void
  focusAtEnd: () => void
  setSelectionOffsets: (start: number, end?: number) => void
  getSelectionOffsets: () => EditorSelectionOffsets
  scrollToReference: (fileId: string) => boolean
}

interface FileAwareEditorProps {
  document: EditorDocumentNode[]
  files: SelectedFileItem[]
  disabled?: boolean
  placeholder?: string
  suggestionText?: string
  showSuggestion?: boolean
  highlightedFileId?: string | null
  onDocumentChange: (document: EditorDocumentNode[]) => void
  onSelectionChange?: (selection: EditorSelectionOffsets) => void
  onFocus?: () => void
  onBlur?: () => void
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  onPaste?: React.ClipboardEventHandler<HTMLDivElement>
  onCompositionStart?: React.CompositionEventHandler<HTMLDivElement>
  onCompositionEnd?: React.CompositionEventHandler<HTMLDivElement>
  onReferencePreview?: (fileId: string) => void
  onReferenceLocate?: (fileId: string) => void
  onReferenceDelete?: (nodeId: string) => void
  className?: string
}

function appendTextContent(target: HTMLElement, text: string): void {
  const parts = text.split('\n')
  parts.forEach((part, index) => {
    if (part) {
      target.append(document.createTextNode(part))
    }
    if (index < parts.length - 1) {
      target.append(document.createElement('br'))
    }
  })
}

function buildFileChip(
  node: EditorFileNode,
  file: SelectedFileItem | undefined,
  handlers: Pick<
    FileAwareEditorProps,
    'onReferencePreview' | 'onReferenceLocate' | 'onReferenceDelete'
  >,
  highlightedFileId?: string | null
): HTMLElement {
  const wrapper = document.createElement('span')
  wrapper.setAttribute('data-file-ref', 'true')
  wrapper.setAttribute('data-node-id', node.id)
  wrapper.setAttribute('data-file-id', node.fileId)
  wrapper.setAttribute('data-fallback-text', node.fallbackText)
  wrapper.setAttribute('contenteditable', 'false')
  wrapper.className = cn(
    'group/file-ref mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 align-baseline text-[12px] font-medium text-blue-700 dark:text-blue-300',
    highlightedFileId && highlightedFileId === node.fileId
      ? 'ring-2 ring-blue-400/50 ring-offset-1 ring-offset-background'
      : ''
  )

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'inline-flex min-w-0 items-center gap-1'
  trigger.title = file?.previewPath || node.fallbackText
  trigger.addEventListener('mousedown', (event) => {
    event.preventDefault()
  })
  trigger.addEventListener('click', (event) => {
    event.preventDefault()
    handlers.onReferencePreview?.(node.fileId)
  })

  const icon = document.createElement('span')
  icon.className = 'pointer-events-none'
  const iconRoot = document.createElement('span')
  iconRoot.className = 'inline-flex items-center'
  icon.append(iconRoot)
  iconRoot.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>'
  const label = document.createElement('span')
  label.className = 'truncate max-w-[240px]'
  label.textContent = file?.sendPath || node.fallbackText
  trigger.append(icon, label)

  const actions = document.createElement('span')
  actions.className =
    'inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover/file-ref:opacity-100'

  const locateBtn = document.createElement('button')
  locateBtn.type = 'button'
  locateBtn.className =
    'inline-flex size-4 items-center justify-center rounded-sm hover:bg-blue-500/15'
  locateBtn.title = '定位到文件条'
  locateBtn.addEventListener('mousedown', (event) => {
    event.preventDefault()
  })
  locateBtn.addEventListener('click', (event) => {
    event.preventDefault()
    handlers.onReferenceLocate?.(node.fileId)
  })
  locateBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="1"></circle><line x1="12" y1="2" x2="12" y2="5"></line><line x1="12" y1="19" x2="12" y2="22"></line><line x1="2" y1="12" x2="5" y2="12"></line><line x1="19" y1="12" x2="22" y2="12"></line></svg>'

  const deleteBtn = document.createElement('button')
  deleteBtn.type = 'button'
  deleteBtn.className =
    'inline-flex size-4 items-center justify-center rounded-sm hover:bg-blue-500/15'
  deleteBtn.title = '删除引用'
  deleteBtn.addEventListener('mousedown', (event) => {
    event.preventDefault()
  })
  deleteBtn.addEventListener('click', (event) => {
    event.preventDefault()
    handlers.onReferenceDelete?.(node.id)
  })
  deleteBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>'

  actions.append(locateBtn, deleteBtn)
  wrapper.append(trigger, actions)
  return wrapper
}

function renderDocument(
  root: HTMLDivElement,
  documentNodes: EditorDocumentNode[],
  files: SelectedFileItem[],
  props: Pick<
    FileAwareEditorProps,
    'onReferencePreview' | 'onReferenceLocate' | 'onReferenceDelete' | 'highlightedFileId'
  >
): void {
  root.replaceChildren()

  for (const node of documentNodes) {
    if (node.type === 'text') {
      appendTextContent(root, node.text)
      continue
    }

    const file = files.find((item) => item.id === node.fileId)
    root.append(
      buildFileChip(node, file, props, props.highlightedFileId),
      document.createTextNode('')
    )
  }

  if (documentNodes.length === 0) {
    root.append(document.createElement('br'))
  }
}

function collectTextContent(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || ''
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }

  const element = node as HTMLElement
  if (element.matches('[data-file-ref="true"]')) {
    return element.dataset.fallbackText || ''
  }

  if (element.tagName === 'BR') {
    return '\n'
  }

  return Array.from(element.childNodes).map(collectTextContent).join('')
}

function parseDomToDocument(root: HTMLDivElement): EditorDocumentNode[] {
  const nextDocument: EditorDocumentNode[] = []

  const appendText = (text: string): void => {
    if (!text) return
    const last = nextDocument[nextDocument.length - 1]
    if (last?.type === 'text') {
      last.text += text
      return
    }
    nextDocument.push({ type: 'text', id: crypto.randomUUID(), text })
  }

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent || '')
      return
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return

    const element = node as HTMLElement
    if (element.matches('[data-file-ref="true"]')) {
      const fileId = element.dataset.fileId
      const nodeId = element.dataset.nodeId
      const fallbackText = element.dataset.fallbackText || ''
      if (fileId && nodeId) {
        nextDocument.push({
          type: 'file',
          id: nodeId,
          fileId,
          fallbackText
        })
      }
      return
    }

    if (element.tagName === 'BR') {
      appendText('\n')
      return
    }

    Array.from(element.childNodes).forEach(visit)
    if (element !== root && /^(DIV|P|LI)$/.test(element.tagName)) {
      appendText('\n')
    }
  }

  Array.from(root.childNodes).forEach(visit)

  return nextDocument.filter((node) => node.type === 'file' || node.text.length > 0)
}

function getSelectionOffsets(
  root: HTMLDivElement,
  files: SelectedFileItem[]
): EditorSelectionOffsets {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    const plainText = editorDocumentToPlainText(parseDomToDocument(root), files)
    return { start: plainText.length, end: plainText.length }
  }

  const range = selection.getRangeAt(0)
  const toOffset = (container: Node, offset: number): number => {
    const tempRange = document.createRange()
    tempRange.selectNodeContents(root)
    tempRange.setEnd(container, offset)
    return collectTextContent(tempRange.cloneContents()).length
  }

  return {
    start: toOffset(range.startContainer, range.startOffset),
    end: toOffset(range.endContainer, range.endOffset)
  }
}

function setSelectionOffsets(root: HTMLDivElement, start: number, end: number): void {
  const selection = window.getSelection()
  if (!selection) return

  const locate = (
    target: number
  ): {
    container: Node
    offset: number
  } => {
    let cursor = 0
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL)
    let current = walker.nextNode()

    while (current) {
      if (current.nodeType === Node.TEXT_NODE) {
        const text = current.textContent || ''
        const nextCursor = cursor + text.length
        if (target <= nextCursor) {
          return { container: current, offset: Math.max(0, target - cursor) }
        }
        cursor = nextCursor
      } else if (current.nodeType === Node.ELEMENT_NODE) {
        const element = current as HTMLElement
        if (element.matches('[data-file-ref="true"]')) {
          const fallbackText = element.dataset.fallbackText || ''
          const nextCursor = cursor + fallbackText.length
          const parent = element.parentNode || root
          const index = Array.from(parent.childNodes).indexOf(element)
          if (target <= nextCursor) {
            const offset = target - cursor <= fallbackText.length / 2 ? index : index + 1
            return { container: parent, offset }
          }
          cursor = nextCursor
        } else if (element.tagName === 'BR') {
          const nextCursor = cursor + 1
          if (target <= nextCursor) {
            const parent = element.parentNode || root
            const index = Array.from(parent.childNodes).indexOf(element)
            return { container: parent, offset: index + 1 }
          }
          cursor = nextCursor
        }
      }
      current = walker.nextNode()
    }

    return { container: root, offset: root.childNodes.length }
  }

  const startPoint = locate(start)
  const endPoint = locate(end)
  const range = document.createRange()
  range.setStart(startPoint.container, startPoint.offset)
  range.setEnd(endPoint.container, endPoint.offset)
  selection.removeAllRanges()
  selection.addRange(range)
}

export const FileAwareEditor = React.forwardRef<FileAwareEditorHandle, FileAwareEditorProps>(
  function FileAwareEditor(
    {
      document,
      files,
      disabled = false,
      placeholder,
      suggestionText,
      showSuggestion = false,
      highlightedFileId,
      onDocumentChange,
      onSelectionChange,
      onFocus,
      onBlur,
      onKeyDown,
      onPaste,
      onCompositionStart,
      onCompositionEnd,
      onReferencePreview,
      onReferenceLocate,
      onReferenceDelete,
      className
    },
    ref
  ) {
    const editorRef = React.useRef<HTMLDivElement>(null)

    const syncSelection = React.useCallback(() => {
      const root = editorRef.current
      if (!root) return { start: 0, end: 0 }
      const selection = getSelectionOffsets(root, files)
      onSelectionChange?.(selection)
      return selection
    }, [files, onSelectionChange])

    React.useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          editorRef.current?.focus()
        },
        focusAtEnd: () => {
          const root = editorRef.current
          if (!root) return
          root.focus()
          const plainText = editorDocumentToPlainText(document, files)
          setSelectionOffsets(root, plainText.length, plainText.length)
          onSelectionChange?.({ start: plainText.length, end: plainText.length })
        },
        setSelectionOffsets: (start, end = start) => {
          const root = editorRef.current
          if (!root) return
          setSelectionOffsets(root, start, end)
          onSelectionChange?.({ start, end })
        },
        getSelectionOffsets: () => {
          const root = editorRef.current
          if (!root) return { start: 0, end: 0 }
          return getSelectionOffsets(root, files)
        },
        scrollToReference: (fileId: string) => {
          const root = editorRef.current
          if (!root) return false
          const target = root.querySelector(
            `[data-file-id="${CSS.escape(fileId)}"]`
          ) as HTMLElement | null
          if (!target) return false
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          return true
        }
      }),
      [document, files, onSelectionChange]
    )

    React.useLayoutEffect(() => {
      const root = editorRef.current
      if (!root) return
      const selection = getSelectionOffsets(root, files)
      renderDocument(root, document, files, {
        onReferencePreview,
        onReferenceLocate,
        onReferenceDelete,
        highlightedFileId
      })
      setSelectionOffsets(root, selection.start, selection.end)
    }, [
      document,
      files,
      highlightedFileId,
      onReferenceDelete,
      onReferenceLocate,
      onReferencePreview
    ])

    const handleInput = React.useCallback(() => {
      const root = editorRef.current
      if (!root) return
      const nextDocument = parseDomToDocument(root)
      onDocumentChange(nextDocument)
      syncSelection()
    }, [onDocumentChange, syncSelection])

    const plainText = React.useMemo(
      () => editorDocumentToPlainText(document, files),
      [document, files]
    )
    const hasContent = document.length > 0 && plainText.length > 0

    return (
      <div className={cn('relative h-full min-h-[60px]', className)}>
        {!hasContent && placeholder && (
          <div className="pointer-events-none absolute inset-0 p-1 text-base text-muted-foreground md:text-sm">
            {placeholder}
          </div>
        )}
        {showSuggestion && suggestionText && plainText.length > 0 && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words p-1 text-base text-muted-foreground/45 md:text-sm">
            <span className="invisible">{plainText}</span>
            <span>{suggestionText}</span>
          </div>
        )}
        <div
          ref={editorRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          className="relative z-10 h-full min-h-[60px] overflow-y-auto whitespace-pre-wrap break-words p-1 text-base outline-none md:text-sm"
          onInput={handleInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => {
            onFocus?.()
            syncSelection()
          }}
          onBlur={onBlur}
          onClick={() => {
            syncSelection()
          }}
          onKeyUp={() => {
            syncSelection()
          }}
          onMouseUp={() => {
            syncSelection()
          }}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={(event) => {
            onCompositionEnd?.(event)
            syncSelection()
          }}
          role="textbox"
          aria-multiline="true"
        />
      </div>
    )
  }
)
