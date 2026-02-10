import { useRef, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import type { ViewerProps } from '../viewer-registry'

export function HtmlViewer({ content, viewMode, onContentChange }: ViewerProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (viewMode === 'preview' && iframeRef.current) {
      iframeRef.current.srcdoc = content
    }
  }, [content, viewMode])

  if (viewMode === 'preview') {
    return (
      <iframe
        ref={iframeRef}
        className="size-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin"
        title="HTML Preview"
      />
    )
  }

  return (
    <Editor
      height="100%"
      language="html"
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
  )
}
