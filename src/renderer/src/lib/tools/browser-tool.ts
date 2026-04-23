import type { ImageBlock, ToolResultContent } from '@renderer/lib/api/types'
import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'
import { useUIStore } from '../../stores/ui-store'

function getWebview(): Electron.WebviewTag | null {
  return useUIStore.getState().browserWebviewRef?.current ?? null
}

function requireWebview(): Electron.WebviewTag {
  const wv = getWebview()
  if (!wv) throw new Error('No page is loaded in the browser. Use BrowserNavigate first.')
  return wv
}

async function waitForLoad(wv: Electron.WebviewTag, timeoutMs = 30000): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false
    const done = (): void => {
      if (resolved) return
      resolved = true
      wv.removeEventListener('did-stop-loading', done)
      wv.removeEventListener('did-fail-load', done)
      resolve()
    }
    wv.addEventListener('did-stop-loading', done)
    wv.addEventListener('did-fail-load', done)
    setTimeout(done, timeoutMs)
  })
}

async function waitForWebview(maxWaitMs = 3000): Promise<Electron.WebviewTag | null> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const wv = getWebview()
    if (wv) return wv
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

// ---------------------------------------------------------------------------
// 1. BrowserNavigate
// ---------------------------------------------------------------------------
const browserNavigateHandler: ToolHandler = {
  definition: {
    name: 'BrowserNavigate',
    description:
      'Navigate the built-in browser. Use action "goto" to open a URL, or "back"/"forward"/"refresh" to control navigation. The browser panel opens automatically. Waits for the page to finish loading before returning.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to (required when action is "goto").'
        },
        action: {
          type: 'string',
          description:
            'Navigation action: "goto" (default), "back", "forward", or "refresh".'
        }
      }
    }
  },
  execute: async (input) => {
    const action = (input.action as string) || 'goto'

    if (action === 'goto') {
      let url = input.url as string
      if (!url || typeof url !== 'string') return encodeToolError('"url" is required for goto')
      url = url.trim()
      if (!/^https?:\/\//i.test(url) && !url.startsWith('http://localhost')) {
        url = `https://${url}`
      }
      useUIStore.getState().openBrowserTab(url)
      const wv = await waitForWebview()
      if (wv) {
        const loadPromise = waitForLoad(wv)
        wv.src = url
        await loadPromise
      }
      return encodeStructuredToolResult({
        success: true,
        url,
        title: useUIStore.getState().browserPageTitle
      })
    }

    const wv = requireWebview()
    const loadPromise = waitForLoad(wv)
    if (action === 'back') {
      wv.goBack()
    } else if (action === 'forward') {
      wv.goForward()
    } else if (action === 'refresh') {
      wv.reload()
    } else {
      return encodeToolError(`Unknown action "${action}". Use goto, back, forward, or refresh.`)
    }
    await loadPromise
    return encodeStructuredToolResult({
      success: true,
      url: useUIStore.getState().browserUrl,
      title: useUIStore.getState().browserPageTitle
    })
  }
}

// ---------------------------------------------------------------------------
// 2. BrowserGetContent
// ---------------------------------------------------------------------------
const HTML_TO_MD_SCRIPT = `
(function(sel) {
  var root = sel ? document.querySelector(sel) : document.body
  if (!root) return JSON.stringify({ error: 'Element not found: ' + sel })

  function convert(node, listDepth) {
    if (node.nodeType === 3) return node.textContent || ''
    if (node.nodeType !== 1) return ''
    var el = node
    var tag = el.tagName.toLowerCase()
    var children = ''
    for (var i = 0; i < el.childNodes.length; i++) children += convert(el.childNodes[i], listDepth)
    children = children.trim()
    if (!children && !['img','br','hr','input'].includes(tag)) return ''

    switch (tag) {
      case 'h1': return '\\n# ' + children + '\\n'
      case 'h2': return '\\n## ' + children + '\\n'
      case 'h3': return '\\n### ' + children + '\\n'
      case 'h4': return '\\n#### ' + children + '\\n'
      case 'h5': return '\\n##### ' + children + '\\n'
      case 'h6': return '\\n###### ' + children + '\\n'
      case 'p': return '\\n' + children + '\\n'
      case 'br': return '\\n'
      case 'hr': return '\\n---\\n'
      case 'strong': case 'b': return '**' + children + '**'
      case 'em': case 'i': return '*' + children + '*'
      case 'del': case 's': return '~~' + children + '~~'
      case 'code':
        if (el.parentElement && el.parentElement.tagName.toLowerCase() === 'pre') return children
        return '\`' + children + '\`'
      case 'pre':
        var code = el.querySelector('code')
        var lang = ''
        if (code) {
          var cls = code.className || ''
          var m = cls.match(/language-(\\w+)/)
          if (m) lang = m[1]
        }
        return '\\n\`\`\`' + lang + '\\n' + (code ? code.textContent : el.textContent) + '\\n\`\`\`\\n'
      case 'blockquote': return '\\n' + children.split('\\n').map(function(l) { return '> ' + l }).join('\\n') + '\\n'
      case 'a':
        var href = el.getAttribute('href') || ''
        if (!href || href === '#') return children
        return '[' + children + '](' + href + ')'
      case 'img':
        var src = el.getAttribute('src') || ''
        var alt = el.getAttribute('alt') || ''
        return '![' + alt + '](' + src + ')'
      case 'ul': case 'ol':
        return '\\n' + Array.from(el.children).map(function(li, idx) {
          var prefix = tag === 'ol' ? (idx + 1) + '. ' : '- '
          var indent = '  '.repeat(listDepth)
          var content = convert(li, listDepth + 1).trim()
          return indent + prefix + content
        }).join('\\n') + '\\n'
      case 'li': return children
      case 'table':
        var rows = Array.from(el.querySelectorAll('tr'))
        if (!rows.length) return children
        var result = '\\n'
        rows.forEach(function(tr, ri) {
          var cells = Array.from(tr.querySelectorAll('th, td')).map(function(c) { return convert(c, 0).trim() })
          result += '| ' + cells.join(' | ') + ' |\\n'
          if (ri === 0) result += '| ' + cells.map(function() { return '---' }).join(' | ') + ' |\\n'
        })
        return result
      case 'script': case 'style': case 'noscript': return ''
      default: return children
    }
  }

  var md = convert(root, 0).replace(/\\n{3,}/g, '\\n\\n').trim()
  return JSON.stringify({ title: document.title, content: md })
})
`

const browserGetContentHandler: ToolHandler = {
  definition: {
    name: 'BrowserGetContent',
    description:
      'Get the current page content as Markdown. Optionally pass a CSS selector to extract only a specific section.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Optional CSS selector to extract content from a specific element.'
        }
      }
    }
  },
  execute: async (input) => {
    const wv = requireWebview()
    const sel = (input.selector as string) || ''
    const raw = await wv.executeJavaScript(
      `${HTML_TO_MD_SCRIPT}(${sel ? JSON.stringify(sel) : 'null'})`
    )
    const parsed = JSON.parse(raw as string)
    if (parsed.error) return encodeToolError(parsed.error)
    const content = (parsed.content as string).slice(0, 80000)
    return encodeStructuredToolResult({
      url: useUIStore.getState().browserUrl,
      title: parsed.title,
      content
    })
  }
}

// ---------------------------------------------------------------------------
// 3. BrowserScreenshot
// ---------------------------------------------------------------------------
const browserScreenshotHandler: ToolHandler = {
  definition: {
    name: 'BrowserScreenshot',
    description:
      'Capture a screenshot of the current page in the built-in browser and return it as an image.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async (): Promise<ToolResultContent> => {
    const wv = requireWebview()
    const nativeImage = await wv.capturePage()
    if (nativeImage.isEmpty()) {
      return encodeToolError('Failed to capture screenshot — page may still be loading.')
    }
    const base64 = nativeImage.toPNG().toString('base64')
    const size = nativeImage.getSize()
    const image: ImageBlock = {
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: base64 }
    }
    return [
      image,
      {
        type: 'text',
        text: `Screenshot captured: ${size.width}x${size.height}px — ${useUIStore.getState().browserUrl}`
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// 4. BrowserSnapshot
// ---------------------------------------------------------------------------
const SNAPSHOT_SCRIPT = `
(function() {
  var selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick]'
  var els = document.querySelectorAll(selectors)
  var results = []
  var seen = new Set()

  function uniqueSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id)
    var path = []
    var cur = el
    while (cur && cur !== document.body) {
      var tag = cur.tagName.toLowerCase()
      var parent = cur.parentElement
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === cur.tagName })
        if (siblings.length > 1) {
          tag += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')'
        }
      }
      path.unshift(tag)
      cur = parent
    }
    return path.join(' > ')
  }

  els.forEach(function(el) {
    if (el.offsetParent === null && el.tagName !== 'INPUT' && el.getAttribute('type') !== 'hidden') return
    var sel = uniqueSelector(el)
    if (seen.has(sel)) return
    seen.add(sel)
    var tag = el.tagName.toLowerCase()
    var text = (el.textContent || '').trim().substring(0, 80).replace(/\\s+/g, ' ')
    var type = el.getAttribute('type') || ''
    var name = el.getAttribute('name') || ''
    var placeholder = el.getAttribute('placeholder') || ''
    var role = el.getAttribute('role') || ''
    var href = el.getAttribute('href') || ''
    var value = ''
    if (tag === 'input' || tag === 'textarea') value = (el.value || '').substring(0, 40)
    if (tag === 'select') value = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : ''

    var desc = tag
    if (type) desc += '[type=' + type + ']'
    if (role) desc += '[role=' + role + ']'
    if (name) desc += ' name="' + name + '"'
    if (placeholder) desc += ' placeholder="' + placeholder + '"'
    if (href) desc += ' href="' + href.substring(0, 100) + '"'
    if (value) desc += ' value="' + value + '"'
    if (text) desc += ' — "' + text + '"'

    results.push({ selector: sel, description: desc })
  })

  return JSON.stringify({ title: document.title, count: results.length, elements: results })
})()
`

const browserSnapshotHandler: ToolHandler = {
  definition: {
    name: 'BrowserSnapshot',
    description:
      'Get a structured snapshot of all interactive elements on the current page (links, buttons, inputs, selects). Returns CSS selectors you can use with BrowserClick and BrowserType.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async () => {
    const wv = requireWebview()
    const raw = await wv.executeJavaScript(SNAPSHOT_SCRIPT)
    const parsed = JSON.parse(raw as string)
    const lines = (parsed.elements as Array<{ selector: string; description: string }>)
      .map((e, i) => `[${i}] ${e.description}\n    selector: ${e.selector}`)
      .join('\n')
    return encodeStructuredToolResult({
      url: useUIStore.getState().browserUrl,
      title: parsed.title,
      elementCount: parsed.count,
      elements: lines
    })
  }
}

// ---------------------------------------------------------------------------
// 5. BrowserClick
// ---------------------------------------------------------------------------
const CLICK_SCRIPT = `
(function(selector) {
  var el
  if (selector.startsWith('text=')) {
    var searchText = selector.slice(5)
    var all = document.querySelectorAll('a, button, [role="button"], [onclick], input[type="submit"], input[type="button"]')
    for (var i = 0; i < all.length; i++) {
      if ((all[i].textContent || '').trim().includes(searchText)) { el = all[i]; break }
    }
    if (!el) {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
      while (walker.nextNode()) {
        if ((walker.currentNode.textContent || '').trim().includes(searchText) && walker.currentNode.offsetParent !== null) {
          el = walker.currentNode; break
        }
      }
    }
  } else {
    el = document.querySelector(selector)
  }
  if (!el) return JSON.stringify({ error: 'Element not found: ' + selector })
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  el.click()
  return JSON.stringify({ success: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 80) })
})
`

const browserClickHandler: ToolHandler = {
  definition: {
    name: 'BrowserClick',
    description:
      'Click an element on the current page. Use a CSS selector (from BrowserSnapshot) or text= prefix to match by visible text (e.g. "text=Submit").',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'CSS selector or text=<visible text> to identify the element to click.'
        }
      },
      required: ['selector']
    }
  },
  execute: async (input) => {
    const wv = requireWebview()
    const selector = input.selector as string
    if (!selector) return encodeToolError('"selector" is required')
    const raw = await wv.executeJavaScript(
      `${CLICK_SCRIPT}(${JSON.stringify(selector)})`
    )
    const parsed = JSON.parse(raw as string)
    if (parsed.error) return encodeToolError(parsed.error)
    await new Promise((r) => setTimeout(r, 300))
    return encodeStructuredToolResult({
      success: true,
      clicked: `<${parsed.tag}> "${parsed.text}"`
    })
  }
}

// ---------------------------------------------------------------------------
// 6. BrowserType
// ---------------------------------------------------------------------------
const TYPE_SCRIPT = `
(function(selector, text, clear, submit) {
  var el = document.querySelector(selector)
  if (!el) return JSON.stringify({ error: 'Element not found: ' + selector })
  var tag = el.tagName.toLowerCase()
  if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) {
    return JSON.stringify({ error: 'Element is not an input field: ' + selector })
  }
  el.focus()
  if (el.isContentEditable) {
    if (clear) el.textContent = ''
    el.textContent += text
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    var setter = Object.getOwnPropertyDescriptor(
      tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'
    ).set
    setter.call(el, (clear ? '' : el.value) + text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if (submit) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
    if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit()
  }
  return JSON.stringify({ success: true, tag: tag, value: (el.value || el.textContent || '').substring(0, 200) })
})
`

const browserTypeHandler: ToolHandler = {
  definition: {
    name: 'BrowserType',
    description:
      'Type text into an input field or textarea on the current page. Use a CSS selector from BrowserSnapshot to identify the element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of the input element.'
        },
        text: {
          type: 'string',
          description: 'Text to type into the element.'
        },
        clear: {
          type: 'boolean',
          description: 'Clear existing content before typing. Default: true.'
        },
        submit: {
          type: 'boolean',
          description: 'Press Enter after typing to submit. Default: false.'
        }
      },
      required: ['selector', 'text']
    }
  },
  execute: async (input) => {
    const wv = requireWebview()
    const selector = input.selector as string
    const text = input.text as string
    const clear = input.clear !== false
    const submit = input.submit === true
    if (!selector) return encodeToolError('"selector" is required')
    if (text == null) return encodeToolError('"text" is required')
    const raw = await wv.executeJavaScript(
      `${TYPE_SCRIPT}(${JSON.stringify(selector)}, ${JSON.stringify(text)}, ${clear}, ${submit})`
    )
    const parsed = JSON.parse(raw as string)
    if (parsed.error) return encodeToolError(parsed.error)
    return encodeStructuredToolResult({
      success: true,
      element: parsed.tag,
      value: parsed.value
    })
  }
}

// ---------------------------------------------------------------------------
// 7. BrowserScroll
// ---------------------------------------------------------------------------
const browserScrollHandler: ToolHandler = {
  definition: {
    name: 'BrowserScroll',
    description:
      'Scroll the current page up or down by a specified pixel amount (defaults to one viewport height).',
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          description: '"up" or "down" (default: "down").'
        },
        amount: {
          type: 'number',
          description: 'Pixels to scroll. Defaults to the viewport height.'
        }
      }
    }
  },
  execute: async (input) => {
    const wv = requireWebview()
    const direction = (input.direction as string) || 'down'
    const amount = typeof input.amount === 'number' ? input.amount : 0
    const raw = await wv.executeJavaScript(`
      (function() {
        var amt = ${amount} || window.innerHeight
        window.scrollBy(0, ${direction === 'up' ? '-' : ''}amt)
        return JSON.stringify({
          scrollY: Math.round(window.scrollY),
          scrollHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight
        })
      })()
    `)
    const parsed = JSON.parse(raw as string)
    return encodeStructuredToolResult({
      success: true,
      scrollY: parsed.scrollY,
      scrollHeight: parsed.scrollHeight,
      viewportHeight: parsed.viewportHeight
    })
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
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
  for (const h of ALL_HANDLERS) toolRegistry.register(h)
}

export function unregisterBrowserTool(): void {
  if (!_browserToolRegistered) return
  _browserToolRegistered = false
  for (const h of ALL_HANDLERS) toolRegistry.unregister(h.definition.name)
}

export function isBrowserToolRegistered(): boolean {
  return _browserToolRegistered
}
