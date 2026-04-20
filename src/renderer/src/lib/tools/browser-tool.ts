import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'
import { useUIStore } from '../../stores/ui-store'

const BROWSER_TOOL_NAME = 'BrowserOpen'

const browserOpenHandler: ToolHandler = {
  definition: {
    name: BROWSER_TOOL_NAME,
    description:
      'Open a URL in the built-in browser panel. Use this to preview web pages, local dev servers, or any HTTP/HTTPS URL. The browser panel will open automatically on the right side.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'The URL to open (http:// or https://). For local dev servers use http://localhost:<port>.'
        }
      },
      required: ['url']
    }
  },
  execute: async (input) => {
    const url = input.url as string
    if (!url || typeof url !== 'string') {
      return encodeToolError('url is required')
    }
    try {
      useUIStore.getState().openBrowserTab(url)
      return encodeStructuredToolResult({
        success: true,
        url,
        message: `Opened ${url} in the built-in browser panel.`
      })
    } catch (err) {
      return encodeToolError(
        `Failed to open browser: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

let _browserToolRegistered = false

export function registerBrowserTool(): void {
  if (_browserToolRegistered) return
  _browserToolRegistered = true
  toolRegistry.register(browserOpenHandler)
}

export function unregisterBrowserTool(): void {
  if (!_browserToolRegistered) return
  _browserToolRegistered = false
  toolRegistry.unregister(BROWSER_TOOL_NAME)
}

export function isBrowserToolRegistered(): boolean {
  return _browserToolRegistered
}

export { BROWSER_TOOL_NAME }
