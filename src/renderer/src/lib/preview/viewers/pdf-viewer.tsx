import { useState, useEffect } from 'react'
import { FileText, ChevronLeft, ChevronRight } from 'lucide-react'
import { Document, Page, pdfjs } from 'react-pdf'
import { Button } from '@renderer/components/ui/button'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import type { ViewerProps } from '../viewer-registry'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Configure pdf.js worker
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

export function PdfViewer({ filePath, sshConnectionId }: ViewerProps): React.JSX.Element {
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const channel = sshConnectionId ? IPC.SSH_FS_READ_FILE_BINARY : IPC.FS_READ_FILE_BINARY
    const args = sshConnectionId
      ? { connectionId: sshConnectionId, path: filePath }
      : { path: filePath }
    ipcClient.invoke(channel, args).then((raw: unknown) => {
      if (cancelled) return
      const result = raw as { data?: string; error?: string }
      if (result.error || !result.data) {
        setError(result.error || 'Failed to read file')
        setLoading(false)
        return
      }
      try {
        const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))
        if (!cancelled) {
          setPdfData(bytes)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err))
          setLoading(false)
        }
      }
    })

    return () => { cancelled = true }
  }, [filePath, sshConnectionId])

  const onDocumentLoadSuccess = ({ numPages: n }: { numPages: number }): void => {
    setNumPages(n)
    setCurrentPage(1)
  }

  const prevPage = (): void => setCurrentPage((p) => Math.max(1, p - 1))
  const nextPage = (): void => setCurrentPage((p) => Math.min(numPages, p + 1))

  if (loading) {
    return (
      <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <FileText className="size-5 animate-pulse" />
        Loading PDF...
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
    <div className="flex size-full flex-col">
      {/* Page navigation */}
      <div className="flex h-8 items-center justify-center gap-2 border-b px-2">
        <Button variant="ghost" size="sm" className="h-6 px-1" onClick={prevPage} disabled={currentPage <= 1}>
          <ChevronLeft className="size-3.5" />
        </Button>
        <span className="text-xs text-muted-foreground">
          {currentPage} / {numPages}
        </span>
        <Button variant="ghost" size="sm" className="h-6 px-1" onClick={nextPage} disabled={currentPage >= numPages}>
          <ChevronRight className="size-3.5" />
        </Button>
      </div>

      {/* PDF content */}
      <div className="flex-1 overflow-auto flex justify-center bg-muted/30 p-4">
        {pdfData && (
          <Document
            file={{ data: pdfData }}
            onLoadSuccess={onDocumentLoadSuccess}
            loading={
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="size-4 animate-pulse" /> Loading...
              </div>
            }
          >
            <Page
              pageNumber={currentPage}
              renderTextLayer={true}
              renderAnnotationLayer={true}
              className="shadow-lg"
            />
          </Document>
        )}
      </div>
    </div>
  )
}
