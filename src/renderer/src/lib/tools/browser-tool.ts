import { toolRegistry } from '../agent/tool-registry'
import { encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'

function nativeOnlyBrowserResult(toolName: string): string {
  return encodeToolError(
    `${toolName} executes in the .NET Native Worker and is unavailable through the renderer boundary.`
  )
}

const browserNavigateHandler: ToolHandler = {
  definition: {
    name: 'BrowserNavigate',
    description:
      'Navigate the built-in browser to a URL or control page history.\n\n' +
      'This is the entry point for all browser interactions. The browser panel opens automatically on the right side.\n\n' +
      'Usage:\n' +
      '- Use action "goto" (default) with a url to open a new page. Waits for the page to fully load before returning.\n' +
      '- Use action "back", "forward", or "refresh" to control navigation history (no url needed).\n' +
      '- After navigating, use BrowserSnapshot or BrowserScreenshot to observe the page before interacting.\n' +
      '- URLs without a protocol prefix automatically get "https://" prepended. For local dev servers, use "http://localhost:<port>".',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'The URL to navigate to. Required when action is "goto". Example: "https://example.com" or "http://localhost:3000".'
        },
        action: {
          type: 'string',
          description:
            'Navigation action: "goto" (default) opens a URL, "back"/"forward" navigate history, "refresh" reloads the current page.'
        }
      }
    }
  },
  execute: async () => nativeOnlyBrowserResult('BrowserNavigate')
}

const browserGetContentHandler: ToolHandler = {
  definition: {
    name: 'BrowserGetContent',
    description:
      'Extract the current page content as Markdown text.\n\n' +
      'Usage:\n' +
      '- Returns the full page body converted to Markdown by default (headings, links, lists, tables, code blocks, images preserved).\n' +
      '- Set type to "html" to get the raw HTML source instead of Markdown.\n' +
      '- Pass a CSS selector to extract only a specific section (e.g. "main", "#content", ".article-body").\n' +
      '- Best for reading articles, documentation, or extracting structured data from a page.\n' +
      '- For discovering interactive elements (buttons, inputs, links) to click or type into, use BrowserSnapshot instead.\n' +
      '- A page must already be loaded via BrowserNavigate before calling this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'CSS selector to scope extraction to a specific element. Omit to extract the entire page body.'
        },
        type: {
          type: 'string',
          description:
            'Output format: "markdown" (default) converts HTML to readable Markdown, "html" returns raw HTML source.'
        }
      }
    }
  },
  execute: async () => nativeOnlyBrowserResult('BrowserGetContent')
}

const browserScreenshotHandler: ToolHandler = {
  definition: {
    name: 'BrowserScreenshot',
    description:
      'Capture a visual screenshot of the current browser viewport and return it as an image.\n\n' +
      'Usage:\n' +
      '- Returns a PNG image of the currently visible area of the page.\n' +
      '- Use this to visually verify page state, check layout, or see content that is hard to represent as text.\n' +
      '- For extracting text content, prefer BrowserGetContent. For discovering clickable elements, prefer BrowserSnapshot.\n' +
      '- A page must already be loaded via BrowserNavigate before calling this tool.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async () => nativeOnlyBrowserResult('BrowserScreenshot')
}

const browserSnapshotHandler: ToolHandler = {
  definition: {
    name: 'BrowserSnapshot',
    description:
      'Get a structured list of all interactive elements on the current page with their CSS selectors.\n\n' +
      'Usage:\n' +
      '- Returns every visible link, button, input, select, and textarea with a unique CSS selector and description.\n' +
      '- ALWAYS call this before using BrowserClick or BrowserType; it gives you the exact selectors to target.\n' +
      '- Use the returned CSS selectors directly in BrowserClick or BrowserType.\n' +
      '- After a click or navigation that changes the page, call BrowserSnapshot again to get updated selectors.\n' +
      '- A page must already be loaded via BrowserNavigate before calling this tool.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async () => nativeOnlyBrowserResult('BrowserSnapshot')
}

const browserClickHandler: ToolHandler = {
  definition: {
    name: 'BrowserClick',
    description:
      'Click an element on the current page.\n\n' +
      'Usage:\n' +
      '- Pass a CSS selector from BrowserSnapshot to click a specific element. This is the most reliable approach.\n' +
      '- Alternatively, use the text= prefix to match by visible text (e.g. "text=Sign In", "text=Submit").\n' +
      '- The element is scrolled into view before clicking.\n' +
      '- After clicking, the page may change. Call BrowserSnapshot again to see the updated state.\n' +
      '- A page must already be loaded via BrowserNavigate before calling this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'CSS selector from BrowserSnapshot, or text=<visible text> to match by content.'
        }
      },
      required: ['selector']
    }
  },
  execute: async () => nativeOnlyBrowserResult('BrowserClick')
}

const browserTypeHandler: ToolHandler = {
  definition: {
    name: 'BrowserType',
    description:
      'Type text into an input field, textarea, or contenteditable element on the current page.\n\n' +
      'Usage:\n' +
      '- Use a CSS selector from BrowserSnapshot to identify the target input element.\n' +
      '- By default, existing content is cleared before typing. Set clear=false to append.\n' +
      '- Set submit=true to press Enter after typing.\n' +
      '- Triggers standard input/change events so frameworks detect the value change.\n' +
      '- A page must already be loaded via BrowserNavigate before calling this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of the input element from BrowserSnapshot.'
        },
        text: {
          type: 'string',
          description: 'The text to type into the element.'
        },
        clear: {
          type: 'boolean',
          description: 'Clear existing content before typing. Default: true.'
        },
        submit: {
          type: 'boolean',
          description: 'Press Enter after typing to submit the form. Default: false.'
        }
      },
      required: ['selector', 'text']
    }
  },
  execute: async () => nativeOnlyBrowserResult('BrowserType')
}

const browserScrollHandler: ToolHandler = {
  definition: {
    name: 'BrowserScroll',
    description:
      'Scroll the current page up or down.\n\n' +
      'Usage:\n' +
      '- Scrolls by the specified pixel amount, or by one viewport height if amount is omitted.\n' +
      '- Use this to reveal content below the fold, load lazy-loaded content, or navigate long pages.\n' +
      '- After scrolling, call BrowserSnapshot or BrowserScreenshot to observe the newly visible content.\n' +
      '- A page must already be loaded via BrowserNavigate before calling this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          description: 'Scroll direction: "down" (default) or "up".'
        },
        amount: {
          type: 'number',
          description: 'Pixels to scroll. Omit to scroll by one full viewport height.'
        }
      }
    }
  },
  execute: async () => nativeOnlyBrowserResult('BrowserScroll')
}

const ALL_HANDLERS: ToolHandler[] = [
  browserNavigateHandler,
  browserGetContentHandler,
  browserScreenshotHandler,
  browserSnapshotHandler,
  browserClickHandler,
  browserTypeHandler,
  browserScrollHandler
]

let _browserToolRegistered = false

export function registerBrowserTool(): void {
  if (_browserToolRegistered) return
  _browserToolRegistered = true
  for (const handler of ALL_HANDLERS) toolRegistry.register(handler)
}

export function unregisterBrowserTool(): void {
  if (!_browserToolRegistered) return
  _browserToolRegistered = false
  for (const handler of ALL_HANDLERS) toolRegistry.unregister(handler.definition.name)
}

export function isBrowserToolRegistered(): boolean {
  return _browserToolRegistered
}
