import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import { CodeEditor } from '@renderer/components/editor/CodeEditor'
import type { ViewerProps } from '../viewer-registry'
import {
  createMarkdownComponents,
  markdownUrlTransform,
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from './markdown-components'

export function MarkdownViewer({
  filePath,
  content,
  viewMode,
  onContentChange,
  onSave,
  initialLine,
  initialColumn,
  initialPositionKey
}: ViewerProps): React.JSX.Element {
  if (viewMode === 'code') {
    return (
      <CodeEditor
        filePath={filePath}
        content={content}
        onChange={onContentChange}
        onSave={onSave}
        initialLine={initialLine}
        initialColumn={initialColumn}
        initialPositionKey={initialPositionKey}
      />
    )
  }

  return (
    <div className="size-full overflow-y-auto p-6">
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown
          remarkPlugins={MARKDOWN_REMARK_PLUGINS}
          rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
          urlTransform={markdownUrlTransform}
          components={createMarkdownComponents(filePath)}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
