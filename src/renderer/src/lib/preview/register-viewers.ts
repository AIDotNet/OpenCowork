import { viewerRegistry } from './viewer-registry'
import { HtmlViewer } from './viewers/html-viewer'
import { SpreadsheetViewer } from './viewers/spreadsheet-viewer'
import { MarkdownViewer } from './viewers/markdown-viewer'
import { ImageViewer } from './viewers/image-viewer'
import { DocxViewer } from './viewers/docx-viewer'
import { PdfViewer } from './viewers/pdf-viewer'
import { FallbackViewer } from './viewers/fallback-viewer'

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
