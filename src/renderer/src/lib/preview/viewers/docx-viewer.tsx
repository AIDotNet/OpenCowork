import { useState, useEffect } from 'react'
import { FileText } from 'lucide-react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import type { ViewerProps } from '../viewer-registry'

async function convertDocxToHtml(base64: string): Promise<string> {
  const mammoth = await import('mammoth')
  const buffer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const result = await mammoth.convertToHtml({ arrayBuffer: buffer.buffer })
  return result.value
}

export function DocxViewer({ filePath }: ViewerProps): React.JSX.Element {
  const [html, setHtml] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    ipcClient.invoke(IPC.FS_READ_FILE_BINARY, { path: filePath }).then(async (raw: unknown) => {
      if (cancelled) return
      const result = raw as { data?: string; error?: string }
      if (result.error || !result.data) {
        setError(result.error || 'Failed to read file')
        setLoading(false)
        return
      }
      try {
        const converted = await convertDocxToHtml(result.data)
        if (!cancelled) setHtml(converted)
      } catch (err) {
        if (!cancelled) setError(String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [filePath])

  if (loading) {
    return (
      <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <FileText className="size-5 animate-pulse" />
        Loading document...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex size-full items-center justify-center text-sm text-destructive">
        {error}
      </div>
    )
  }

  return (
    <div className="size-full overflow-y-auto p-6">
      <div
        className="prose prose-sm dark:prose-invert max-w-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
