import * as React from 'react'
import { cn } from '@renderer/lib/utils'
import {
  renderFileTypeIconSvg,
  renderIconSvg,
  type FileTypeIconNode
} from '@renderer/lib/file-type-icon'
import {
  editorDocumentToPlainText,
  type EditorDocumentNode,
  type EditorFileNode,
  type EditorPluginNode,
  type SelectedFileItem
} from '@renderer/lib/select-file-editor'

export interface EditorSelectionOffsets {
  start: number
  end: number
}

export interface EditorReferenceLabels {
  removeFile: string
  removePlugin: string
}

const DEFAULT_REFERENCE_LABELS: EditorReferenceLabels = {
  removeFile: 'Remove reference',
  removePlugin: 'Remove plugin reference'
}

const PLUGIN_ICON: FileTypeIconNode = [
  [
    'path',
    {
      d: 'M19.4 7.34 16.66 4.6a2 2 0 0 0-2.82 0l-1.08 1.08 5.56 5.56 1.08-1.08a2 2 0 0 0 0-2.82Z',
      key: 'p1'
    }
  ],
  ['path', { d: 'm14.5 7.5-8 8', key: 'p2' }],
  ['path', { d: 'm5 19 3.5-1 8-8L14 7.5l-8 8L5 19Z', key: 'p3' }]
]

const CLOSE_ICON: FileTypeIconNode = [
  ['path', { d: 'M18 6 6 18', key: 'x1' }],
  ['path', { d: 'm6 6 12 12', key: 'x2' }]
]

const CHIP_CLASS_NAME =
  'composer-file-ref group/file-ref mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md px-2 py-0.5 align-baseline text-[12px] font-medium'

interface FileAwareEditorProps {
  document: EditorDocumentNode[]
  files: SelectedFileItem[]
  disabled?: boolean
  placeholder?: string
  suggestionText?: string
  showSuggestion?: boolean
  referenceLabels?: Partial<EditorReferenceLabels>
  onDocumentChange: (document: EditorDocumentNode[]) => void
  onSelectionChange?: (selection: EditorSelectionOffsets) => void
  onFocus?: () => void
  onBlur?: () => void
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  onPaste?: React.ClipboardEventHandler<HTMLDivElement>
  onCompositionStart?: React.CompositionEventHandler<HTMLDivElement>
  onCompositionEnd?: React.CompositionEventHandler<HTMLDivElement>
  onReferencePreview?: (fileId: string) => void
  onReferenceDelete?: (nodeId: string) => void
  className?: string
}

export interface FileAwareEditorHandle {
  focus: () => void
  focusAtEnd: () => void
  setSelectionOffsets: (start: number, end?: number) => void
  getSelectionOffsets: () => EditorSelectionOffsets
  getDocumentSnapshot: () => EditorDocumentNode[]
  getScrollMetrics: () => { scrollHeight: number; clientHeight: number }
}

type ChipRenderProps = Pick<FileAwareEditorProps, 'onReferencePreview' | 'onReferenceDelete'> & {
  referenceLabels: EditorReferenceLabels
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

function getFileChipLabel(file: SelectedFileItem | undefined, fallbackText: string): string {
  if (file?.name) return file.name
  const normalized = fallbackText.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  return segments[segments.length - 1] || fallbackText
}

/** Chip actions must not steal focus from the contenteditable, hence the mousedown guard. */
function createChipAction(label: string, iconMarkup: string, onActivate: () => void): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className =
    'composer-file-ref-action inline-flex size-4 items-center justify-center rounded-sm'
  button.title = label
  button.setAttribute('aria-label', label)
  button.innerHTML = iconMarkup
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    onActivate()
  })
  return button
}

function createChipActionGroup(actions: HTMLElement[]): HTMLElement | null {
  if (actions.length === 0) return null
  const container = document.createElement('span')
  container.className = 'hidden items-center gap-0.5 group-hover/file-ref:inline-flex'
  container.append(...actions)
  return container
}

function createChipIcon(iconMarkup: string): HTMLElement {
  const icon = document.createElement('span')
  icon.className = 'pointer-events-none inline-flex shrink-0 items-center'
  icon.innerHTML = iconMarkup
  return icon
}

function createChipLabel(text: string): HTMLElement {
  const label = document.createElement('span')
  label.className = 'truncate max-w-[240px]'
  label.textContent = text
  return label
}

function buildFileChip(
  node: EditorFileNode,
  file: SelectedFileItem | undefined,
  props: ChipRenderProps
): HTMLElement {
  const chipLabel = getFileChipLabel(file, node.fallbackText)
  const fullPath = file?.previewPath || file?.originalPath || node.fallbackText

  const wrapper = document.createElement('span')
  wrapper.setAttribute('data-file-ref', 'true')
  wrapper.setAttribute('data-node-id', node.id)
  wrapper.setAttribute('data-file-id', node.fileId)
  wrapper.setAttribute('data-fallback-text', node.fallbackText)
  wrapper.setAttribute('contenteditable', 'false')
  wrapper.className = CHIP_CLASS_NAME

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'inline-flex min-w-0 items-center gap-1'
  trigger.title = fullPath
  trigger.setAttribute('aria-label', chipLabel)
  trigger.addEventListener('mousedown', (event) => {
    event.preventDefault()
  })
  trigger.addEventListener('click', (event) => {
    event.preventDefault()
    props.onReferencePreview?.(node.fileId)
  })
  trigger.append(
    createChipIcon(renderFileTypeIconSvg(file?.name || node.fallbackText)),
    createChipLabel(chipLabel)
  )

  wrapper.append(trigger)

  const actions: HTMLElement[] = []
  if (props.onReferenceDelete) {
    actions.push(
      createChipAction(props.referenceLabels.removeFile, renderIconSvg(CLOSE_ICON, 'size-3'), () =>
        props.onReferenceDelete?.(node.id)
      )
    )
  }

  const actionGroup = createChipActionGroup(actions)
  if (actionGroup) wrapper.append(actionGroup)

  return wrapper
}

function buildPluginChip(node: EditorPluginNode, props: ChipRenderProps): HTMLElement {
  const chipLabel = node.label || node.pluginId

  const wrapper = document.createElement('span')
  wrapper.setAttribute('data-plugin-ref', 'true')
  wrapper.setAttribute('data-node-id', node.id)
  wrapper.setAttribute('data-plugin-id', node.pluginId)
  wrapper.setAttribute('data-label', node.label)
  wrapper.setAttribute('data-prompt', node.prompt)
  wrapper.setAttribute('data-fallback-text', chipLabel)
  wrapper.setAttribute('contenteditable', 'false')
  wrapper.className = CHIP_CLASS_NAME
  wrapper.title = node.prompt

  wrapper.append(
    createChipIcon(renderIconSvg(PLUGIN_ICON, 'size-3.5 text-violet-500 dark:text-violet-400')),
    createChipLabel(chipLabel)
  )

  if (props.onReferenceDelete) {
    const actionGroup = createChipActionGroup([
      createChipAction(
        props.referenceLabels.removePlugin,
        renderIconSvg(CLOSE_ICON, 'size-3'),
        () => props.onReferenceDelete?.(node.id)
      )
    ])
    if (actionGroup) wrapper.append(actionGroup)
  }

  return wrapper
}

function renderDocument(
  root: HTMLDivElement,
  documentNodes: EditorDocumentNode[],
  files: SelectedFileItem[],
  props: ChipRenderProps
): void {
  root.replaceChildren()

  for (const node of documentNodes) {
    if (node.type === 'text') {
      appendTextContent(root, node.text)
      continue
    }

    if (node.type === 'file') {
      const file = files.find((item) => item.id === node.fileId)
      root.append(buildFileChip(node, file, props), document.createTextNode(''))
      continue
    }

    root.append(buildPluginChip(node, props), document.createTextNode(''))
  }

  if (documentNodes.length === 0) {
    root.append(document.createElement('br'))
  }
}

function collectTextContent(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || ''
  }

  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    return Array.from(node.childNodes).map(collectTextContent).join('')
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }

  const element = node as HTMLElement
  if (element.matches('[data-file-ref="true"]')) {
    return element.dataset.fallbackText || ''
  }

  if (element.matches('[data-plugin-ref="true"]')) {
    return element.dataset.fallbackText || ''
  }

  if (element.tagName === 'BR') {
    return '\n'
  }

  return Array.from(element.childNodes).map(collectTextContent).join('')
}

function isSameDocument(left: EditorDocumentNode[], right: EditorDocumentNode[]): boolean {
  if (left.length !== right.length) return false

  for (let index = 0; index < left.length; index += 1) {
    const leftNode = left[index]
    const rightNode = right[index]
    if (leftNode?.type !== rightNode?.type) return false

    if (leftNode?.type === 'text' && rightNode?.type === 'text') {
      if (leftNode.text !== rightNode.text) return false
      continue
    }

    if (leftNode?.type === 'file' && rightNode?.type === 'file') {
      if (
        leftNode.id !== rightNode.id ||
        leftNode.fileId !== rightNode.fileId ||
        leftNode.fallbackText !== rightNode.fallbackText
      ) {
        return false
      }
    }

    if (leftNode?.type === 'plugin' && rightNode?.type === 'plugin') {
      if (
        leftNode.id !== rightNode.id ||
        leftNode.pluginId !== rightNode.pluginId ||
        leftNode.label !== rightNode.label ||
        leftNode.prompt !== rightNode.prompt
      ) {
        return false
      }
    }
  }

  return true
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

    if (element.matches('[data-plugin-ref="true"]')) {
      const nodeId = element.dataset.nodeId
      const pluginId = element.dataset.pluginId
      const label = element.dataset.label || pluginId || ''
      const prompt = element.dataset.prompt || ''
      if (nodeId && pluginId && prompt) {
        nextDocument.push({
          type: 'plugin',
          id: nodeId,
          pluginId,
          label,
          prompt
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

  return nextDocument.filter((node) => node.type !== 'text' || node.text.length > 0)
}

function getSelectionOffsets(
  root: HTMLDivElement,
  files: SelectedFileItem[],
  fallback?: EditorSelectionOffsets
): EditorSelectionOffsets {
  const plainText = editorDocumentToPlainText(parseDomToDocument(root), files)
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return fallback ?? { start: plainText.length, end: plainText.length }
  }

  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return fallback ?? { start: plainText.length, end: plainText.length }
  }

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

function setSelectionFromPoint(root: HTMLDivElement, clientX: number, clientY: number): boolean {
  const doc = root.ownerDocument
  const anyDoc = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }

  let container: Node | null = null
  let offset = 0

  const caretPosition = anyDoc.caretPositionFromPoint?.(clientX, clientY)
  if (caretPosition) {
    container = caretPosition.offsetNode
    offset = caretPosition.offset
  } else {
    const caretRange = anyDoc.caretRangeFromPoint?.(clientX, clientY)
    if (caretRange) {
      container = caretRange.startContainer
      offset = caretRange.startOffset
    }
  }

  if (!container || !root.contains(container)) return false

  const selection = doc.getSelection()
  if (!selection) return false

  const range = doc.createRange()
  range.setStart(container, offset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
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
    let current: Node | null = walker.nextNode()

    while (current) {
      if (current.nodeType === Node.TEXT_NODE) {
        const text = current.textContent || ''
        const nextCursor = cursor + text.length
        if (target <= nextCursor) {
          return { container: current, offset: Math.max(0, target - cursor) }
        }
        cursor = nextCursor
        current = walker.nextNode()
        continue
      }

      if (current.nodeType === Node.ELEMENT_NODE) {
        const element = current as HTMLElement
        if (element.matches('[data-file-ref="true"], [data-plugin-ref="true"]')) {
          const fallbackText = element.dataset.fallbackText || ''
          const nextCursor = cursor + fallbackText.length
          const parent = element.parentNode || root
          const index = Array.from(parent.childNodes).indexOf(element)
          if (target <= nextCursor) {
            const offset = target - cursor <= fallbackText.length / 2 ? index : index + 1
            return { container: parent, offset }
          }
          cursor = nextCursor
          current = walker.nextSibling()
          continue
        }

        if (element.tagName === 'BR') {
          const nextCursor = cursor + 1
          if (target <= nextCursor) {
            const parent = element.parentNode || root
            const index = Array.from(parent.childNodes).indexOf(element)
            return { container: parent, offset: index + 1 }
          }
          cursor = nextCursor
          current = walker.nextSibling()
          continue
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
      referenceLabels,
      onDocumentChange,
      onSelectionChange,
      onFocus,
      onBlur,
      onKeyDown,
      onPaste,
      onCompositionStart,
      onCompositionEnd,
      onReferencePreview,
      onReferenceDelete,
      className
    },
    ref
  ) {
    const editorRef = React.useRef<HTMLDivElement>(null)
    const suggestionOverlayRef = React.useRef<HTMLDivElement>(null)
    const selectionRef = React.useRef<EditorSelectionOffsets>({ start: 0, end: 0 })
    const focusedRef = React.useRef(false)
    const selectionSyncFrameRef = React.useRef<number | null>(null)
    const documentSyncFrameRef = React.useRef<number | null>(null)
    const isComposingRef = React.useRef(false)
    const pendingRenderAfterCompositionRef = React.useRef(false)
    const [compositionRenderVersion, bumpCompositionRenderVersion] = React.useReducer(
      (version: number) => version + 1,
      0
    )
    // Chips are built inside a layout effect, which runs before passive effects — so these refs are
    // assigned during render to guarantee the first paint already has handlers and labels.
    const handlersRef = React.useRef<
      Pick<FileAwareEditorProps, 'onReferencePreview' | 'onReferenceDelete'>
    >({})
    handlersRef.current = { onReferencePreview, onReferenceDelete }

    const referenceLabelsRef = React.useRef<EditorReferenceLabels>(DEFAULT_REFERENCE_LABELS)
    referenceLabelsRef.current = { ...DEFAULT_REFERENCE_LABELS, ...referenceLabels }

    const syncSelection = React.useCallback(() => {
      const root = editorRef.current
      if (!root) return selectionRef.current
      const selection = getSelectionOffsets(root, files, selectionRef.current)
      selectionRef.current = selection
      onSelectionChange?.(selection)
      return selection
    }, [files, onSelectionChange])

    const scheduleSelectionSync = React.useCallback(() => {
      if (selectionSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionSyncFrameRef.current)
      }
      selectionSyncFrameRef.current = window.requestAnimationFrame(() => {
        selectionSyncFrameRef.current = null
        syncSelection()
      })
    }, [syncSelection])

    React.useEffect(() => {
      const handleSelectionChange = (): void => {
        const root = editorRef.current
        const selection = window.getSelection()
        if (!root || !selection || selection.rangeCount === 0) return
        const range = selection.getRangeAt(0)
        if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return
        scheduleSelectionSync()
      }

      window.document.addEventListener('selectionchange', handleSelectionChange)
      return () => {
        window.document.removeEventListener('selectionchange', handleSelectionChange)
        if (selectionSyncFrameRef.current !== null) {
          window.cancelAnimationFrame(selectionSyncFrameRef.current)
        }
        if (documentSyncFrameRef.current !== null) {
          window.cancelAnimationFrame(documentSyncFrameRef.current)
        }
      }
    }, [scheduleSelectionSync])

    React.useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          const root = editorRef.current
          if (!root) return
          root.focus()
          focusedRef.current = true
          const selection = window.getSelection()
          const hasEditorSelection =
            selection &&
            selection.rangeCount > 0 &&
            root.contains(selection.getRangeAt(0).startContainer) &&
            root.contains(selection.getRangeAt(0).endContainer)
          if (!hasEditorSelection) {
            setSelectionOffsets(root, selectionRef.current.start, selectionRef.current.end)
          }
        },
        focusAtEnd: () => {
          const root = editorRef.current
          if (!root) return
          root.focus()
          focusedRef.current = true
          const plainText = editorDocumentToPlainText(document, files)
          selectionRef.current = { start: plainText.length, end: plainText.length }
          setSelectionOffsets(root, plainText.length, plainText.length)
          onSelectionChange?.(selectionRef.current)
        },
        setSelectionOffsets: (start, end = start) => {
          const root = editorRef.current
          if (!root) return
          selectionRef.current = { start, end }
          setSelectionOffsets(root, start, end)
          onSelectionChange?.(selectionRef.current)
        },
        getSelectionOffsets: () => {
          const root = editorRef.current
          if (!root) return selectionRef.current
          return getSelectionOffsets(root, files, selectionRef.current)
        },
        getDocumentSnapshot: () => {
          const root = editorRef.current
          if (!root) return document
          return parseDomToDocument(root)
        },
        getScrollMetrics: () => {
          const root = editorRef.current
          return {
            scrollHeight: root?.scrollHeight ?? 0,
            clientHeight: root?.clientHeight ?? 0
          }
        }
      }),
      [document, files, onSelectionChange]
    )

    React.useLayoutEffect(() => {
      const root = editorRef.current
      if (!root) return

      if (isComposingRef.current) {
        pendingRenderAfterCompositionRef.current = true
        return
      }

      const currentDocument = parseDomToDocument(root)
      if (isSameDocument(currentDocument, document)) {
        return
      }

      renderDocument(root, document, files, {
        ...handlersRef.current,
        referenceLabels: referenceLabelsRef.current
      })

      if (!focusedRef.current) return
      const selection = selectionRef.current
      setSelectionOffsets(root, selection.start, selection.end)
    }, [compositionRenderVersion, document, files])

    const flushDocumentSync = React.useCallback(() => {
      const root = editorRef.current
      if (!root) return
      const nextDocument = parseDomToDocument(root)
      if (!isSameDocument(nextDocument, document)) {
        onDocumentChange(nextDocument)
      }
    }, [document, onDocumentChange])

    const handleInput = React.useCallback(
      (event: React.FormEvent<HTMLDivElement>) => {
        const nativeEvent = event.nativeEvent as Event & { isComposing?: boolean }
        if (isComposingRef.current || nativeEvent.isComposing) {
          return
        }

        syncSelection()
        if (documentSyncFrameRef.current !== null) {
          window.cancelAnimationFrame(documentSyncFrameRef.current)
          documentSyncFrameRef.current = null
        }
        flushDocumentSync()
      },
      [flushDocumentSync, syncSelection]
    )

    const handleCompositionStartInternal = React.useCallback(
      (event: React.CompositionEvent<HTMLDivElement>) => {
        isComposingRef.current = true
        if (documentSyncFrameRef.current !== null) {
          window.cancelAnimationFrame(documentSyncFrameRef.current)
          documentSyncFrameRef.current = null
        }
        onCompositionStart?.(event)
      },
      [onCompositionStart]
    )

    const handleCompositionUpdateInternal = React.useCallback(() => {
      pendingRenderAfterCompositionRef.current = true
    }, [])

    const handleCompositionEndInternal = React.useCallback(
      (event: React.CompositionEvent<HTMLDivElement>) => {
        isComposingRef.current = false
        onCompositionEnd?.(event)
        if (documentSyncFrameRef.current !== null) {
          window.cancelAnimationFrame(documentSyncFrameRef.current)
          documentSyncFrameRef.current = null
        }
        flushDocumentSync()
        scheduleSelectionSync()
        if (pendingRenderAfterCompositionRef.current) {
          pendingRenderAfterCompositionRef.current = false
          bumpCompositionRenderVersion()
        }
      },
      [flushDocumentSync, onCompositionEnd, scheduleSelectionSync]
    )

    const plainText = React.useMemo(
      () => editorDocumentToPlainText(document, files),
      [document, files]
    )
    const hasContent = document.length > 0 && plainText.length > 0

    return (
      <div className={cn('relative flex min-h-0 min-w-0 flex-col overflow-hidden', className)}>
        {!hasContent && placeholder && (
          <div className="composer-editor-placeholder pointer-events-none absolute inset-0 p-2 pb-12 pr-3 text-base md:text-sm">
            {placeholder}
          </div>
        )}
        {showSuggestion && suggestionText && plainText.length > 0 && (
          <div
            ref={suggestionOverlayRef}
            className="composer-editor-suggestion pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words p-2 pb-12 pr-3 text-base md:text-sm"
          >
            <span className="invisible">{plainText}</span>
            <span>{suggestionText}</span>
          </div>
        )}
        <div
          ref={editorRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck={false}
          data-gramm="false"
          className="composer-editor-content block min-h-[60px] min-w-0 max-h-full flex-1 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words p-2 pb-12 pr-3 text-base outline-none md:text-sm"
          style={{ scrollbarGutter: 'stable' }}
          onInput={handleInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => {
            focusedRef.current = true
            onFocus?.()
            scheduleSelectionSync()
          }}
          onBlur={() => {
            focusedRef.current = false
            isComposingRef.current = false
            onBlur?.()
          }}
          onClick={() => {
            scheduleSelectionSync()
          }}
          onKeyUp={() => {
            scheduleSelectionSync()
          }}
          onMouseDown={(event) => {
            if (event.button !== 2) return
            setSelectionFromPoint(event.currentTarget, event.clientX, event.clientY)
            scheduleSelectionSync()
          }}
          onDragOver={(event) => {
            if (disabled) return
            if (setSelectionFromPoint(event.currentTarget, event.clientX, event.clientY)) {
              syncSelection()
            }
          }}
          onDrop={(event) => {
            if (disabled) return
            if (setSelectionFromPoint(event.currentTarget, event.clientX, event.clientY)) {
              syncSelection()
            }
          }}
          onMouseUp={() => {
            scheduleSelectionSync()
          }}
          onContextMenu={(event) => {
            setSelectionFromPoint(event.currentTarget, event.clientX, event.clientY)
            scheduleSelectionSync()
          }}
          onScroll={(event) => {
            if (!suggestionOverlayRef.current) return
            suggestionOverlayRef.current.scrollTop = event.currentTarget.scrollTop
            suggestionOverlayRef.current.scrollLeft = event.currentTarget.scrollLeft
          }}
          onCompositionStart={handleCompositionStartInternal}
          onCompositionUpdate={handleCompositionUpdateInternal}
          onCompositionEnd={handleCompositionEndInternal}
          role="textbox"
          aria-multiline="true"
        />
      </div>
    )
  }
)
