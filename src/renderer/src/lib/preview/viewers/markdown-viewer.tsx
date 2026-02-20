import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ViewerProps } from '../viewer-registry'

const MonacoEditor = React.lazy(async () => {
  const mod = await import('@monaco-editor/react')
  return { default: mod.default }
})

export function MarkdownViewer({ filePath, content, viewMode, onContentChange }: ViewerProps): React.JSX.Element {
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
            tabSize: 2,
          }}
        />
      </React.Suspense>
    )
  }

  // Preview mode: render markdown
  // For images with relative paths, resolve them against the file's directory
  const fileDir = filePath.replace(/[\\/][^\\/]*$/, '')

  return (
    <div className="size-full overflow-y-auto p-6">
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            img: ({ src, alt, ...props }) => {
              let resolvedSrc = src || ''
              // Resolve relative image paths against the markdown file's directory
              if (resolvedSrc && !resolvedSrc.startsWith('http') && !resolvedSrc.startsWith('data:')) {
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
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
