import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Camera,
  FileText,
  Globe2,
  Keyboard,
  Loader2,
  Monitor,
  MousePointerClick,
  ScrollText,
  TriangleAlert
} from 'lucide-react'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ImageBlock, TextBlock, ToolResultContent } from '@renderer/lib/api/types'
import {
  BROWSER_CLICK_TOOL_NAME,
  BROWSER_GET_CONTENT_TOOL_NAME,
  BROWSER_NAVIGATE_TOOL_NAME,
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_SCROLL_TOOL_NAME,
  BROWSER_SNAPSHOT_TOOL_NAME,
  BROWSER_TYPE_TOOL_NAME
} from '@renderer/lib/app-plugin/types'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import type { CompactToolHeaderModel } from './CompactToolCallHeader'
import { CompactToolCallHeader } from './CompactToolCallHeader'
import { ImagePreview } from './ImagePreview'

interface BrowserToolCardProps {
  name: string
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  error?: string
  forceOpen?: boolean
}

const CONTENT_TRANSITION = {
  duration: 0.18,
  ease: 'easeOut' as const
}

const PREVIEW_LIMIT = 12000

function parseStructuredOutput(
  output: ToolResultContent | undefined
): Record<string, unknown> | null {
  if (typeof output !== 'string') return null
  const parsed = decodeStructuredToolResult(output)
  return parsed && !Array.isArray(parsed) ? parsed : null
}

function parseErrorMessage(output: ToolResultContent | undefined): string | null {
  if (typeof output !== 'string') return null
  const parsed = decodeStructuredToolResult(output)
  if (parsed && !Array.isArray(parsed) && typeof parsed.error === 'string' && parsed.error.trim()) {
    return parsed.error
  }
  return output.trim() || null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function compactText(value: string, limit = 96): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 1).trimEnd()}...`
}

function compactUrl(value: string): string {
  if (!value) return ''
  try {
    const parsed = new URL(value)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.hostname}${path}` || value
  } catch {
    return value
  }
}

function previewText(value: string): { text: string; truncated: boolean } {
  if (value.length <= PREVIEW_LIMIT) return { text: value, truncated: false }
  return { text: value.slice(0, PREVIEW_LIMIT), truncated: true }
}

function lineCount(value: string): number {
  if (!value) return 0
  return value.split(/\r\n|\r|\n/).length
}

function getToolIcon(name: string): React.JSX.Element {
  if (name === BROWSER_SCREENSHOT_TOOL_NAME) return <Camera className="size-3.5" />
  if (name === BROWSER_SNAPSHOT_TOOL_NAME) return <Monitor className="size-3.5" />
  if (name === BROWSER_CLICK_TOOL_NAME) return <MousePointerClick className="size-3.5" />
  if (name === BROWSER_TYPE_TOOL_NAME) return <Keyboard className="size-3.5" />
  if (name === BROWSER_SCROLL_TOOL_NAME) return <ScrollText className="size-3.5" />
  if (name === BROWSER_GET_CONTENT_TOOL_NAME) return <FileText className="size-3.5" />
  return <Globe2 className="size-3.5" />
}

function fallbackTitle(name: string): string {
  if (name === BROWSER_NAVIGATE_TOOL_NAME) return 'Browser Navigate'
  if (name === BROWSER_GET_CONTENT_TOOL_NAME) return 'Browser Content'
  if (name === BROWSER_SCREENSHOT_TOOL_NAME) return 'Browser Screenshot'
  if (name === BROWSER_SNAPSHOT_TOOL_NAME) return 'Browser Snapshot'
  if (name === BROWSER_CLICK_TOOL_NAME) return 'Browser Click'
  if (name === BROWSER_TYPE_TOOL_NAME) return 'Browser Type'
  if (name === BROWSER_SCROLL_TOOL_NAME) return 'Browser Scroll'
  return name
}

function buildSummary(
  name: string,
  input: Record<string, unknown>,
  jsonOutput: Record<string, unknown> | null,
  notes: TextBlock[],
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (name === BROWSER_NAVIGATE_TOOL_NAME) {
    const action = stringValue(input.action) || 'goto'
    const url = stringValue(jsonOutput?.url) || stringValue(input.url)
    return url ? `${action}: ${compactUrl(url)}` : action
  }

  if (name === BROWSER_GET_CONTENT_TOOL_NAME) {
    const content = stringValue(jsonOutput?.content)
    const type = stringValue(jsonOutput?.type) || stringValue(input.type) || 'markdown'
    return content
      ? t('toolCall.browser.summary.content', {
          type,
          count: content.length,
          defaultValue: `${type} · ${content.length} chars`
        })
      : type
  }

  if (name === BROWSER_SCREENSHOT_TOOL_NAME) {
    const match = notes[0]?.text.match(/(\d+)x(\d+)px/)
    return match
      ? t('toolCall.browser.summary.screenshot', {
          width: match[1],
          height: match[2],
          defaultValue: `${match[1]} × ${match[2]}`
        })
      : t('toolCall.browser.summary.image', { defaultValue: 'image' })
  }

  if (name === BROWSER_SNAPSHOT_TOOL_NAME) {
    const count = numberValue(jsonOutput?.elementCount)
    return count !== null
      ? t('toolCall.browser.summary.elements', {
          count,
          defaultValue: `${count} elements`
        })
      : t('toolCall.browser.summary.snapshot', { defaultValue: 'interactive elements' })
  }

  if (name === BROWSER_CLICK_TOOL_NAME) {
    return compactText(stringValue(jsonOutput?.clicked) || stringValue(input.selector) || name)
  }

  if (name === BROWSER_TYPE_TOOL_NAME) {
    const selector = compactText(stringValue(input.selector))
    const submit = input.submit === true
    return submit
      ? t('toolCall.browser.summary.typeSubmit', {
          selector,
          defaultValue: selector ? `${selector} · submit` : 'submit'
        })
      : selector || t('toolCall.browser.summary.type', { defaultValue: 'type text' })
  }

  if (name === BROWSER_SCROLL_TOOL_NAME) {
    const scrollY = numberValue(jsonOutput?.scrollY)
    if (scrollY !== null) {
      return t('toolCall.browser.summary.scrollY', {
        value: scrollY,
        defaultValue: `Y ${scrollY}`
      })
    }
    const direction = stringValue(input.direction) || 'down'
    const amount = numberValue(input.amount)
    return amount !== null ? `${direction} ${amount}px` : direction
  }

  return name
}

function getMainPreview(
  name: string,
  jsonOutput: Record<string, unknown> | null
): { labelKey: string; fallbackLabel: string; content: string; truncated: boolean } | null {
  if (!jsonOutput) return null

  if (name === BROWSER_GET_CONTENT_TOOL_NAME) {
    const content = stringValue(jsonOutput.content)
    if (!content) return null
    const preview = previewText(content)
    return {
      labelKey: 'toolCall.browser.contentPreview',
      fallbackLabel: 'Content preview',
      content: preview.text,
      truncated: preview.truncated
    }
  }

  if (name === BROWSER_SNAPSHOT_TOOL_NAME) {
    const elements = stringValue(jsonOutput.elements)
    if (!elements) return null
    const preview = previewText(elements)
    return {
      labelKey: 'toolCall.browser.elementsPreview',
      fallbackLabel: 'Elements',
      content: preview.text,
      truncated: preview.truncated
    }
  }

  return null
}

function getResultRows(
  name: string,
  jsonOutput: Record<string, unknown> | null
): Array<{ labelKey: string; fallbackLabel: string; value: string }> {
  if (!jsonOutput) return []
  const rows: Array<{ labelKey: string; fallbackLabel: string; value: string }> = []

  const add = (labelKey: string, fallbackLabel: string, value: unknown): void => {
    const text =
      typeof value === 'number'
        ? String(value)
        : typeof value === 'boolean'
          ? String(value)
          : stringValue(value)
    if (text) rows.push({ labelKey, fallbackLabel, value: text })
  }

  if (name === BROWSER_NAVIGATE_TOOL_NAME || name === BROWSER_GET_CONTENT_TOOL_NAME) {
    add('toolCall.browser.fields.title', 'Title', jsonOutput.title)
    add('toolCall.browser.fields.url', 'URL', jsonOutput.url)
    add('toolCall.browser.fields.type', 'Type', jsonOutput.type)
  } else if (name === BROWSER_CLICK_TOOL_NAME) {
    add('toolCall.browser.fields.clicked', 'Clicked', jsonOutput.clicked)
  } else if (name === BROWSER_TYPE_TOOL_NAME) {
    add('toolCall.browser.fields.element', 'Element', jsonOutput.element)
    add('toolCall.browser.fields.value', 'Value', jsonOutput.value)
  } else if (name === BROWSER_SCROLL_TOOL_NAME) {
    add('toolCall.browser.fields.scrollY', 'Scroll Y', jsonOutput.scrollY)
    add('toolCall.browser.fields.scrollHeight', 'Scroll Height', jsonOutput.scrollHeight)
    add('toolCall.browser.fields.viewport', 'Viewport', jsonOutput.viewportHeight)
  } else if (name === BROWSER_SNAPSHOT_TOOL_NAME) {
    add('toolCall.browser.fields.title', 'Title', jsonOutput.title)
    add('toolCall.browser.fields.url', 'URL', jsonOutput.url)
    add('toolCall.browser.fields.elements', 'Elements', jsonOutput.elementCount)
  }

  return rows
}

function statusLabel(
  status: ToolCallStatus | 'completed',
  t: (key: string, options?: Record<string, unknown>) => string
): string | null {
  if (status === 'streaming') return t('toolCall.receivingArgs')
  if (status === 'running') return t('toolCall.executing')
  if (status === 'pending_approval') return t('permission.title')
  if (status === 'error') return t('error.label')
  if (status === 'canceled') return t('toolCall.canceled', { defaultValue: 'Canceled' })
  return null
}

export function BrowserToolCard({
  name,
  input,
  output,
  status,
  error,
  forceOpen = false
}: BrowserToolCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const jsonOutput = parseStructuredOutput(output)
  const canceledMessage =
    status === 'canceled'
      ? t('toolCall.noResult', { defaultValue: 'No tool result available' })
      : null
  const parsedError = error || parseErrorMessage(output) || canceledMessage
  const isRunning = status === 'streaming' || status === 'pending_approval' || status === 'running'
  const hasError = status === 'error' || status === 'canceled' || Boolean(parsedError)

  const { images, notes } = useMemo(() => {
    if (!Array.isArray(output)) {
      return { images: [] as ImageBlock[], notes: [] as TextBlock[] }
    }

    return {
      images: output.filter((block): block is ImageBlock => block.type === 'image'),
      notes: output.filter((block): block is TextBlock => block.type === 'text')
    }
  }, [output])

  const autoOpenKey = `${isRunning ? 'active' : 'idle'}:${images.length}`
  const [openState, setOpenState] = useState<{ key: string; open: boolean }>(() => ({
    key: autoOpenKey,
    open: forceOpen || isRunning || images.length > 0
  }))
  const open =
    forceOpen || (openState.key === autoOpenKey ? openState.open : isRunning || images.length > 0)

  const summary = buildSummary(name, input, jsonOutput, notes, t)
  const mainPreview = getMainPreview(name, jsonOutput)
  const resultRows = getResultRows(name, jsonOutput)
  const rawOutput = typeof output === 'string' && !jsonOutput && !parsedError ? output : ''
  const title = t(`toolCall.browser.${name}.title`, { defaultValue: fallbackTitle(name) })
  const badges: CompactToolHeaderModel['badges'] = []

  if (images.length > 0) {
    badges.push({ label: t('toolCall.imageFile'), tone: 'blue' })
  }
  if (mainPreview) {
    badges.push({
      label: t('toolCall.lineCount', { count: lineCount(mainPreview.content) }),
      tone: 'blue'
    })
  }

  const model: CompactToolHeaderModel = {
    icon: getToolIcon(name),
    primary: summary || title,
    secondary: summary ? title : undefined,
    badges,
    title: [title, summary].filter(Boolean).join('\n')
  }

  return (
    <div className="my-0 min-w-0 overflow-hidden">
      <button
        type="button"
        onClick={() => {
          if (forceOpen) return
          setOpenState({
            key: autoOpenKey,
            open: !open
          })
        }}
        className="group w-full rounded-md px-2 py-0.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-accent/50"
      >
        <CompactToolCallHeader
          model={model}
          status={status}
          statusLabel={statusLabel(status, t)}
          hasError={hasError}
          errorTitle={parsedError}
          elapsed={null}
          open={open}
        />
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={CONTENT_TRANSITION}
            className="mt-0.5 overflow-hidden pl-4"
          >
            <div className="space-y-2 pb-0.5">
              {isRunning ? (
                <div className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>
                    {t('toolCall.browser.executing', {
                      defaultValue: 'Executing browser action...'
                    })}
                  </span>
                </div>
              ) : null}

              {hasError ? (
                <div className="rounded-md border border-destructive/25 bg-destructive/[0.035] px-2.5 py-2 text-xs text-destructive">
                  <div className="flex items-start gap-2">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span className="break-words">{parsedError}</span>
                  </div>
                </div>
              ) : null}

              {images.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('toolCall.browser.screenshotPreview', {
                      defaultValue: 'Screenshot preview'
                    })}
                  </p>
                  {images.map((image, index) => {
                    const src =
                      image.source.type === 'base64' && image.source.data
                        ? `data:${image.source.mediaType || 'image/png'};base64,${image.source.data}`
                        : (image.source.url ?? '')
                    if (!src && !image.source.filePath) return null
                    return (
                      <ImagePreview
                        key={`${image.source.filePath ?? src}-${index}`}
                        src={src}
                        alt={`Browser screenshot ${index + 1}`}
                        filePath={image.source.filePath}
                      />
                    )
                  })}
                </div>
              ) : null}

              {resultRows.length > 0 ? (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {resultRows.map((row) => (
                    <div key={row.labelKey} className="min-w-0 rounded-md bg-muted/20 px-2 py-1.5">
                      <p className="text-[9px] font-medium uppercase text-muted-foreground/60">
                        {t(row.labelKey, { defaultValue: row.fallbackLabel })}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-foreground" title={row.value}>
                        {row.value}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}

              {mainPreview ? (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t(mainPreview.labelKey, { defaultValue: mainPreview.fallbackLabel })}
                    </p>
                    {mainPreview.truncated ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground/65">
                        {t('toolCall.browser.previewTruncated', {
                          count: PREVIEW_LIMIT,
                          defaultValue: `first ${PREVIEW_LIMIT} chars`
                        })}
                      </span>
                    ) : null}
                  </div>
                  <pre className="max-h-56 overflow-auto rounded-md bg-muted/20 px-2.5 py-2 text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words">
                    {mainPreview.content}
                  </pre>
                </div>
              ) : null}

              {rawOutput ? (
                <pre className="max-h-44 overflow-auto rounded-md bg-muted/20 px-2.5 py-2 text-xs text-foreground whitespace-pre-wrap break-words">
                  {rawOutput}
                </pre>
              ) : null}

              {notes.length > 0 ? (
                <div className="space-y-1.5">
                  {notes.map((note, index) => (
                    <p
                      key={`${note.text}-${index}`}
                      className="rounded-md bg-muted/20 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words"
                    >
                      {note.text}
                    </p>
                  ))}
                </div>
              ) : null}

              <details className="group/input">
                <summary className="cursor-pointer select-none text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                  {t('toolCall.browser.input', { defaultValue: 'Input' })}
                </summary>
                <pre className="mt-1.5 max-h-36 overflow-auto rounded-md bg-muted/20 px-2.5 py-2 text-xs text-foreground whitespace-pre-wrap break-words">
                  {JSON.stringify(input, null, 2)}
                </pre>
              </details>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
