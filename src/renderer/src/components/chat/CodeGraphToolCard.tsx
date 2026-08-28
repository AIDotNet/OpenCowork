import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import Markdown from 'react-markdown'
import { Copy } from 'lucide-react'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ToolResultContent } from '@renderer/lib/api/types'
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from '@renderer/lib/preview/viewers/markdown-components'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { filesLabel, toolStatusLabel } from '@renderer/lib/chat/execution-labels'
import { useUIStore } from '@renderer/stores/ui-store'
import type { CompactToolHeaderModel } from './CompactToolCallHeader'
import { CompactToolCallHeader } from './CompactToolCallHeader'

// Dedicated chat card for the codegraph_* tool family (explore/search/callers/
// callees/impact/node/files/status). The worker returns a success-shaped envelope
// { success, text (agent-facing markdown), isError, errorKind, notices } — this
// card decodes it and renders a graph-flavored summary (query, project, file
// references) instead of the generic parameter list + raw output.

interface CodeGraphToolCardProps {
  name: string
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  error?: string
  startedAt?: number
  completedAt?: number
  forceOpen?: boolean
}

const CONTENT_TRANSITION = {
  duration: 0.18,
  ease: 'easeOut' as const
}

const MAX_FILE_CHIPS = 8

interface CodeGraphEnvelope {
  success: boolean
  isError: boolean
  errorKind: string | null
  markdown: string
  error: string | null
  notices: string[]
}

interface CodeGraphFileRef {
  path: string
  line: number | null
  count: number
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function outputAsString(output: ToolResultContent | undefined): string {
  if (!output) return ''
  if (typeof output === 'string') return output
  return output
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

function parseEnvelope(output: ToolResultContent | undefined): CodeGraphEnvelope | null {
  const raw = outputAsString(output)
  if (!raw.trim()) return null
  const parsed = decodeStructuredToolResult(raw)
  if (!parsed || Array.isArray(parsed)) {
    // Not an envelope — treat the raw payload as the markdown body.
    return {
      success: true,
      isError: false,
      errorKind: null,
      markdown: raw,
      error: null,
      notices: []
    }
  }
  const notices = Array.isArray(parsed.notices)
    ? parsed.notices.filter((n): n is string => typeof n === 'string' && !!n.trim())
    : []
  return {
    success: parsed.success !== false,
    isError: parsed.isError === true,
    errorKind: stringValue(parsed.errorKind) || null,
    // `text` for tool results; `message` for the not-ready guidance shape.
    markdown: stringValue(parsed.text) || stringValue(parsed.message),
    error: stringValue(parsed.error) || null,
    notices
  }
}

// Pull `path:line` references and `**`path`**` file-section markers out of the
// agent-facing markdown so the card can show a compact "files touched" strip.
function extractFileRefs(markdown: string): CodeGraphFileRef[] {
  if (!markdown) return []
  const refs = new Map<string, CodeGraphFileRef>()
  const add = (path: string, line: number | null): void => {
    const normalized = path.trim()
    if (!normalized || normalized.length > 260) return
    const existing = refs.get(normalized)
    if (existing) {
      existing.count += 1
      if (existing.line === null && line !== null) existing.line = line
    } else {
      refs.set(normalized, { path: normalized, line, count: 1 })
    }
  }

  const lineRefPattern = /([A-Za-z0-9_@][A-Za-z0-9_@.\\/-]*\.[A-Za-z0-9]{1,8}):(\d{1,6})/g
  for (const match of markdown.matchAll(lineRefPattern)) {
    add(match[1], Number.parseInt(match[2], 10))
  }
  const sectionPattern = /\*\*`([^`\n]+)`\*\*/g
  for (const match of markdown.matchAll(sectionPattern)) {
    add(match[1], null)
  }

  return [...refs.values()].sort((a, b) => b.count - a.count)
}

function countSymbolMentions(markdown: string): number {
  if (!markdown) return 0
  const matches = markdown.match(/^\s*-\s+\S.*\([A-Za-z_]+\)\s+—\s+/gm)
  return matches ? matches.length : 0
}

function pathFileName(value: string): string {
  const normalized = value.replace(/[\\/]+$/, '')
  const idx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

function resolveAbsolutePath(path: string, projectPath: string): string | null {
  if (isAbsolutePath(path)) return path
  if (!projectPath) return null
  return `${projectPath.replace(/[\\/]+$/, '')}/${path.replace(/^[\\/]+/, '')}`
}

function toolActionKey(name: string): string {
  return name.replace(/^codegraph_/, '') || name
}

function elapsedLabel(startedAt?: number, completedAt?: number): string | null {
  if (typeof startedAt !== 'number' || typeof completedAt !== 'number') return null
  const seconds = Math.max(0, completedAt - startedAt) / 1000
  return `${seconds.toFixed(1)}s`
}

// Tiny animated node-graph shown while the worker resolves the query.
function CodeGraphScanIndicator({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-border/60 bg-muted/20 px-2.5 py-2 text-xs text-muted-foreground">
      <span className="tool-name-live-pulse tool-name-live-pulse--running">{label}</span>
    </div>
  )
}

export function CodeGraphToolCard({
  name,
  input,
  output,
  status,
  error,
  startedAt,
  completedAt,
  forceOpen = false
}: CodeGraphToolCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const openFilePreview = useUIStore((s) => s.openFilePreview)

  const envelope = useMemo(() => parseEnvelope(output), [output])
  const markdown = envelope?.markdown ?? ''
  const fileRefs = useMemo(() => extractFileRefs(markdown), [markdown])
  const symbolCount = useMemo(() => countSymbolMentions(markdown), [markdown])

  const isRunning = status === 'streaming' || status === 'pending_approval' || status === 'running'
  const notIndexed = envelope?.errorKind === 'not_indexed'
  const canceledMessage =
    status === 'canceled'
      ? t('toolCall.noResult', { defaultValue: 'No tool result available' })
      : null
  const parsedError =
    error || (envelope?.isError ? envelope.error || envelope.markdown : envelope?.error) || null
  const displayError = parsedError || canceledMessage
  const hasError = status === 'error' || status === 'canceled' || Boolean(parsedError)

  const query =
    stringValue(input.query) ||
    stringValue(input.symbol) ||
    stringValue(input.nodeId) ||
    stringValue(input.file) ||
    stringValue(input.path)
  const projectPath = stringValue(input.projectPath) || stringValue(input.workingFolder)
  const actionLabel = toolActionKey(name)

  // Collapsed by default even while running; users expand manually.
  const [manualOpen, setManualOpen] = useState(false)
  const open = forceOpen || manualOpen
  const [bodyExpanded, setBodyExpanded] = useState(false)
  const isLongBody = markdown.length > 800 || markdown.split('\n').length > 16

  const badges: CompactToolHeaderModel['badges'] = []
  if (notIndexed) {
    badges.push({ label: 'Indexing', tone: 'amber' })
  } else {
    if (fileRefs.length > 0) badges.push({ label: filesLabel(fileRefs.length) })
    if (symbolCount > 0) {
      badges.push({ label: `${symbolCount} ${symbolCount === 1 ? 'symbol' : 'symbols'}` })
    }
  }

  const model: CompactToolHeaderModel = {
    toolLabel: 'CodeGraph',
    primary: query || actionLabel,
    secondary: [actionLabel, projectPath ? pathFileName(projectPath) : '']
      .filter(Boolean)
      .join(' · '),
    badges,
    title: [query, projectPath].filter(Boolean).join('\n') || name
  }

  const handleOpenFile = (ref: CodeGraphFileRef): void => {
    const absolute = resolveAbsolutePath(ref.path, projectPath)
    if (!absolute) return
    openFilePreview(absolute, 'code', undefined, null, ref.line ?? undefined)
  }

  const handleCopy = (): void => {
    if (markdown) void navigator.clipboard.writeText(markdown)
  }

  return (
    <div className="my-0 min-w-0 overflow-hidden">
      <button
        type="button"
        onClick={() => {
          if (forceOpen) return
          setManualOpen(!open)
        }}
        className="group w-full rounded-lg p-0 text-left transition-colors"
      >
        <CompactToolCallHeader
          model={model}
          status={status}
          statusLabel={toolStatusLabel(status)}
          hasError={hasError}
          errorTitle={displayError}
          elapsed={elapsedLabel(startedAt, completedAt)}
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
            className="ml-2 mt-1 overflow-hidden border-l border-border/45 pl-3 dark:border-white/[0.07]"
          >
            <div className="space-y-2 rounded-lg border border-border/50 bg-muted/15 p-3 dark:border-white/[0.07] dark:bg-white/[0.02]">
              {isRunning ? (
                <CodeGraphScanIndicator label="Querying the code graph…" />
              ) : null}

              {displayError ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/[0.06] px-2.5 py-2 text-xs text-destructive">
                  <span className="break-words whitespace-pre-wrap">{displayError}</span>
                </div>
              ) : null}

              {!displayError && notIndexed && markdown ? (
                <div className="rounded-md border border-amber-500/25 bg-amber-500/[0.05] px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
                  <p className="mb-0.5 font-medium">
                    {t('toolCall.codegraph.notIndexed', { defaultValue: 'Index not ready' })}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-amber-700/80 dark:text-amber-300/80">
                    {markdown}
                  </p>
                </div>
              ) : null}

              {!displayError && !notIndexed && fileRefs.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                    {t('toolCall.codegraph.files', { defaultValue: 'Files referenced' })}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {fileRefs.slice(0, MAX_FILE_CHIPS).map((ref) => {
                      const clickable = Boolean(resolveAbsolutePath(ref.path, projectPath))
                      return (
                        <button
                          key={ref.path}
                          type="button"
                          disabled={!clickable}
                          onClick={() => handleOpenFile(ref)}
                          title={ref.path}
                          className={`inline-flex max-w-full items-center gap-1 rounded-full border border-border/55 bg-muted/25 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors ${
                            clickable
                              ? 'hover:border-sky-500/35 hover:bg-sky-500/[0.08] hover:text-foreground'
                              : 'cursor-default'
                          }`}
                        >
                          <span className="truncate font-mono">{pathFileName(ref.path)}</span>
                          {ref.count > 1 ? (
                            <span className="shrink-0 tabular-nums text-muted-foreground/60">
                              ×{ref.count}
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                    {fileRefs.length > MAX_FILE_CHIPS ? (
                      <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] text-muted-foreground/60">
                        +{fileRefs.length - MAX_FILE_CHIPS}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {!displayError && !notIndexed && markdown ? (
                <div>
                  <div className="mb-1 flex items-center gap-1">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                      {t('toolCall.codegraph.result', { defaultValue: 'Graph result' })}
                    </p>
                    <button
                      type="button"
                      onClick={handleCopy}
                      title={t('action.copy', { ns: 'common', defaultValue: 'Copy' })}
                      className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground"
                    >
                      <Copy className="size-3" />
                    </button>
                  </div>
                  <div
                    className={`overflow-auto rounded-md border border-border/50 bg-muted/10 px-3 py-2 ${
                      isLongBody && !bodyExpanded ? 'max-h-48' : 'max-h-[480px]'
                    }`}
                  >
                    <div className="prose prose-sm dark:prose-invert max-w-none text-xs prose-headings:mb-1.5 prose-headings:mt-3 prose-headings:text-sm prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0.5 prose-pre:bg-muted prose-pre:px-2.5 prose-pre:py-2 prose-code:before:content-none prose-code:after:content-none">
                      <Markdown
                        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                      >
                        {markdown}
                      </Markdown>
                    </div>
                  </div>
                  {isLongBody ? (
                    <button
                      type="button"
                      onClick={() => setBodyExpanded(!bodyExpanded)}
                      className="mt-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {bodyExpanded
                        ? t('action.showLess', { ns: 'common' })
                        : t('toolCall.showAll', {
                            chars: markdown.length,
                            lines: markdown.split('\n').length
                          })}
                    </button>
                  ) : null}
                </div>
              ) : null}

              {envelope && envelope.notices.length > 0 ? (
                <div className="space-y-1">
                  {envelope.notices.map((notice, index) => (
                    <p
                      key={`${notice}-${index}`}
                      className="rounded-md bg-muted/20 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words"
                    >
                      {notice}
                    </p>
                  ))}
                </div>
              ) : null}

              <details className="group/input">
                <summary className="cursor-pointer select-none text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                  {t('toolCall.codegraph.input', { defaultValue: 'Input' })}
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
