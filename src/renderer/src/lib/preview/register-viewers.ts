import * as React from 'react'
import { viewerRegistry } from './viewer-registry'

const HtmlViewer = React.lazy(async () => {
  const mod = await import('./viewers/html-viewer')
  return { default: mod.HtmlViewer }
})

const SpreadsheetViewer = React.lazy(async () => {
  const mod = await import('./viewers/spreadsheet-viewer')
  return { default: mod.SpreadsheetViewer }
})

const MarkdownViewer = React.lazy(async () => {
  const mod = await import('./viewers/markdown-viewer')
  return { default: mod.MarkdownViewer }
})

const ImageViewer = React.lazy(async () => {
  const mod = await import('./viewers/image-viewer')
  return { default: mod.ImageViewer }
})

const DocxViewer = React.lazy(async () => {
  const mod = await import('./viewers/docx-viewer')
  return { default: mod.DocxViewer }
})

const PdfViewer = React.lazy(async () => {
  const mod = await import('./viewers/pdf-viewer')
  return { default: mod.PdfViewer }
})

const FallbackViewer = React.lazy(async () => {
  const mod = await import('./viewers/fallback-viewer')
  return { default: mod.FallbackViewer }
})

export function registerAllViewers(): void {
  viewerRegistry.register({
    type: 'html',
    extensions: ['.html', '.htm'],
    component: HtmlViewer,
  })

  viewerRegistry.register({
    type: 'spreadsheet',
    extensions: ['.csv', '.tsv', '.xlsx', '.xls'],
    component: SpreadsheetViewer,
  })

  viewerRegistry.register({
    type: 'markdown',
    extensions: ['.md', '.mdx', '.markdown'],
    component: MarkdownViewer,
  })

  viewerRegistry.register({
    type: 'image',
    extensions: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico'],
    component: ImageViewer,
  })

  viewerRegistry.register({
    type: 'docx',
    extensions: ['.docx'],
    component: DocxViewer,
  })

  viewerRegistry.register({
    type: 'pdf',
    extensions: ['.pdf'],
    component: PdfViewer,
  })

  viewerRegistry.register({
    type: 'fallback',
    extensions: [],
    component: FallbackViewer,
  })
}
