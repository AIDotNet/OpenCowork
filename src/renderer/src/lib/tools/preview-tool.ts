import { toolRegistry } from '../agent/tool-registry'
import type { ToolHandler } from './tool-types'

const openPreviewHandler: ToolHandler = {
  definition: {
    name: 'OpenPreview',
    description:
      'Open a file in the preview panel so the user can see it immediately. ' +
      'IMPORTANT: You MUST call this tool right after creating or editing any of these file types:\n' +
      '- HTML files (.html/.htm): renders a live preview in an iframe, great for data visualizations (ECharts, D3, Chart.js), interactive pages, reports, dashboards, etc.\n' +
      '- Spreadsheet files (.csv/.tsv): shows an editable table view with undo/redo and search.\n' +
      '- Any other text/code file: displays with syntax highlighting via Monaco Editor.\n\n' +
      'When the user asks you to create a chart, visualization, single-page app, report, or any visual output, ' +
      'prefer generating a self-contained HTML file (with inline CSS/JS and CDN libraries like ECharts, Chart.js, D3, etc.), ' +
      'then immediately call OpenPreview to show the result. This gives the user instant visual feedback without leaving the app.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to preview. Must be an existing file on disk.',
        },
        view_mode: {
          type: 'string',
          enum: ['preview', 'code'],
          description: 'View mode: "preview" for rendered HTML view, "code" for source code with syntax highlighting. Defaults based on file type (HTML→preview, others→code).',
        },
      },
      required: ['file_path'],
    },
  },
  execute: async (input) => {
    const filePath = String(input.file_path)
    const viewMode = input.view_mode as 'preview' | 'code' | undefined

    // Import dynamically to avoid circular deps at module level
    const { useUIStore } = await import('@renderer/stores/ui-store')
    useUIStore.getState().openFilePreview(filePath, viewMode)

    return JSON.stringify({ success: true, message: `Opened ${filePath} in preview panel` })
  },
  requiresApproval: () => false,
}

export function registerPreviewTools(): void {
  toolRegistry.register(openPreviewHandler)
}
