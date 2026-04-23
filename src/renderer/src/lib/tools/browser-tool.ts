import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'
import { useUIStore } from '../../stores/ui-store'

const BROWSER_TOOL_NAME = 'BrowserOpen'
const BROWSER_GET_CONTENT_TOOL_NAME = 'BrowserGetContent'

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

const browserGetContentHandler: ToolHandler = {
  definition: {
    name: BROWSER_GET_CONTENT_TOOL_NAME,
    description:
      'Get the text content of the current page in the built-in browser panel. Returns the page title and body text. The browser must have a page loaded first via BrowserOpen.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async () => {
    const store = useUIStore.getState()
    const webview = store.browserWebviewRef?.current
    if (!webview || !store.browserUrl) {
      return encodeToolError('No page is currently loaded in the browser')
    }
    try {
      const content = await webview.executeJavaScript(
        `JSON.stringify({ title: document.title, text: document.body.innerText })`
      )
      const parsed = JSON.parse(content as string)
      return encodeStructuredToolResult({
        url: store.browserUrl,
        title: parsed.title ?? '',
        content: typeof parsed.text === 'string' ? parsed.text.slice(0, 50000) : ''
      })
    } catch (err) {
      return encodeToolError(
        `Failed to get page content: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

let _browserToolRegistered = false

export function registerBrowserTool(): void {
  if (_browserToolRegistered) return
  _browserToolRegistered = true
  toolRegistry.register(browserOpenHandler)
  toolRegistry.register(browserGetContentHandler)
}

export function unregisterBrowserTool(): void {
  if (!_browserToolRegistered) return
  _browserToolRegistered = false
  toolRegistry.unregister(BROWSER_TOOL_NAME)
  toolRegistry.unregister(BROWSER_GET_CONTENT_TOOL_NAME)
}

export function isBrowserToolRegistered(): boolean {
  return _browserToolRegistered
}

export { BROWSER_TOOL_NAME, BROWSER_GET_CONTENT_TOOL_NAME }
