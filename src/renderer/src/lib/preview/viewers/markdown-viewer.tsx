import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeEditor } from '@renderer/components/editor/CodeEditor'
import type { ViewerProps } from '../viewer-registry'
import { createMarkdownComponents } from './markdown-components'

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
