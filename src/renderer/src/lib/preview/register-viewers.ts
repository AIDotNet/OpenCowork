import { viewerRegistry } from './viewer-registry'
import { HtmlViewer } from './viewers/html-viewer'
import { SpreadsheetViewer } from './viewers/spreadsheet-viewer'
import { FallbackViewer } from './viewers/fallback-viewer'

export function registerAllViewers(): void {
  viewerRegistry.register({
    type: 'html',
    extensions: ['.html', '.htm'],
    component: HtmlViewer,
  })

  viewerRegistry.register({
    type: 'spreadsheet',
    extensions: ['.csv', '.tsv'],
    component: SpreadsheetViewer,
  })

  viewerRegistry.register({
    type: 'fallback',
    extensions: [],
    component: FallbackViewer,
  })
}
