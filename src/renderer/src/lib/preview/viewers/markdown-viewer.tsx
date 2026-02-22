import * as React from 'react'
import { Check, ImageDown } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import mermaid from 'mermaid'
import {
  applyMermaidTheme,
  copyMermaidToClipboard,
  useMermaidThemeVersion
} from '@renderer/lib/utils/mermaid-theme'
import type { ViewerProps } from '../viewer-registry'

const MonacoEditor = React.lazy(async () => {
  const mod = await import('@monaco-editor/react')
  return { default: mod.default }
})

function MermaidBlock({ code }: { code: string }): React.JSX.Element {
  const [svg, setSvg] = React.useState('')
  const [error, setError] = React.useState('')
  const [copied, setCopied] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const renderId = React.useId().replace(/:/g, '-')
  const themeVersion = useMermaidThemeVersion()

  const handleCopyImage = React.useCallback(async () => {
    if (!svg.trim()) return
    setBusy(true)
    try {
      await copyMermaidToClipboard(svg)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('[Mermaid] Copy image failed:', err)
    } finally {
      setBusy(false)
    }
  }, [svg])

  React.useEffect(() => {
    let cancelled = false

    async function renderDiagram(): Promise<void> {
      const source = code.trim()
      if (!source) {
        setSvg('')
        setError('')
        return
      }

      try {
        applyMermaidTheme()
        const result = await mermaid.render(`mermaid-${renderId}-${Date.now()}`, source)
        if (cancelled) return
        setSvg(result.svg)
        setError('')
      } catch (err) {
        if (cancelled) return
        setSvg('')
        setError(err instanceof Error ? err.message : 'Failed to render Mermaid diagram.')
      }
    }

    void renderDiagram()
    return () => {
      cancelled = true
    }
  }, [code, renderId, themeVersion])

  return (
    <div className="my-3 overflow-hidden rounded-md border border-border/60 bg-background">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-3 py-1.5">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">
          mermaid
        </span>
        <button
          onClick={() => void handleCopyImage()}
          disabled={busy || !svg.trim()}
          title="复制 Mermaid 图到剪贴板"
          className="flex items-center rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted-foreground/10 transition-colors disabled:opacity-50"
        >
          {copied ? <Check className="size-3" /> : <ImageDown className="size-3" />}
          <span>{copied ? '已复制' : '下载'}</span>
        </button>
      </div>
      <div className="p-3">
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-xs font-medium text-destructive/90">Mermaid render failed</p>
            <p className="mt-1 text-xs text-destructive/70">{error}</p>
            <pre className="mt-2 overflow-x-auto rounded bg-background/70 p-2 text-xs">{code}</pre>
          </div>
        ) : !svg ? (
          <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
            Rendering Mermaid diagram...
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md bg-background">
            <div
              className="[&_svg]:mx-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export function createMarkdownComponents(filePath?: string): Components {
  const fileDir = filePath ? filePath.replace(/[\\/][^\\/]*$/, '') : ''

  return {
    img: ({ src, alt, ...props }) => {
      let resolvedSrc = src || ''
      if (
        fileDir &&
        resolvedSrc &&
        !resolvedSrc.startsWith('http') &&
        !resolvedSrc.startsWith('data:') &&
        !resolvedSrc.startsWith('file://')
      ) {
        const sep = fileDir.includes('/') ? '/' : '\\'
        resolvedSrc = `file://${fileDir}${sep}${resolvedSrc.replace(/^\.[\\/]/, '')}`
      }
      return (
        <img
          {...props}
          src={resolvedSrc}
          alt={alt || ''}
          className="max-w-full rounded"
          loading="lazy"
        />
      )
    },
    pre: ({ children }) => <>{children}</>,
    code: ({ children, className }) => {
      const code = String(children ?? '').replace(/\n$/, '')
      const languageMatch = /language-([\w-]+)/.exec(className || '')
      const language = languageMatch?.[1]?.toLowerCase()

      if (!className) {
        return <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>
      }

      if (language === 'mermaid') {
        return <MermaidBlock code={code} />
      }

      return (
        <pre className="my-3 overflow-x-auto rounded-md bg-muted/60 p-3 text-xs">
          <code className={className}>{children}</code>
        </pre>
      )
    }
  }
}

export function MarkdownViewer({
  filePath,
  content,
  viewMode,
  onContentChange
}: ViewerProps): React.JSX.Element {
  if (viewMode === 'code') {
    return (
      <React.Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Loading editor...
          </div>
        }
      >
        <MonacoEditor
          height="100%"
          language="markdown"
          theme="vs-dark"
          value={content}
          onChange={(value) => onContentChange?.(value ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2
          }}
        />
      </React.Suspense>
    )
  }

  return (
    <div className="size-full overflow-y-auto p-6">
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents(filePath)}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
