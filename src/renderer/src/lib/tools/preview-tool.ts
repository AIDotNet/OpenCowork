import { toolRegistry } from '../agent/tool-registry'
import type { ToolHandler } from './tool-types'

const openPreviewHandler: ToolHandler = {
  definition: {
    name: 'OpenPreview',
    description:
      'Open a file in the preview panel for the user to view. ' +
      'Supports HTML files (rendered preview), CSV/TSV spreadsheets (editable table), ' +
      'and any text file (syntax-highlighted code view). ' +
      'Use this after creating or editing a file to show the result to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to preview',
        },
        view_mode: {
          type: 'string',
          enum: ['preview', 'code'],
          description: 'View mode: "preview" for rendered view (HTML), "code" for source code. Defaults to auto-detect.',
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
