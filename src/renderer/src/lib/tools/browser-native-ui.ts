import type { ImageBlock, ToolResultContent } from '@renderer/lib/api/types'
import { getBrowserAccessDecision } from '../app-plugin/browser-access'
import {
  describeWebviewOperationError,
  isPromiseLike,
  isWebviewConnected,
  type MaybePromise
} from '../browser/webview-helpers'
import { IPC } from '../ipc/channels'
import { ipcClient } from '../ipc/ipc-client'
import { useUIStore } from '../../stores/ui-store'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolContext } from './tool-types'

type NativeBrowserToolResponse = {
  content: ToolResultContent
  isError?: boolean
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function createToolContext(record: Record<string, unknown>): ToolContext {
  return {
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
    workingFolder: typeof record.workingFolder === 'string' ? record.workingFolder : undefined,
    currentToolUseId: typeof record.toolUseId === 'string' ? record.toolUseId : undefined,
    agentRunId:
      typeof record.agentRunId === 'string'
        ? record.agentRunId
        : typeof record.runId === 'string'
          ? record.runId
          : undefined,
    signal: new AbortController().signal,
    ipc: ipcClient
  }
}

function getWebview(ctx?: ToolContext): Electron.WebviewTag | null {
  const webview = useUIStore.getState().getBrowserWebviewRef(ctx?.sessionId)?.current ?? null
  return isWebviewConnected(webview) ? webview : null
}

function requireWebview(ctx?: ToolContext): Electron.WebviewTag {
  const webview = getWebview(ctx)
  if (!webview) {
    throw new Error('No attached browser view is available. Use BrowserNavigate first.')
  }
  return webview
}

async function runWebviewCommand<T>(
  webview: Electron.WebviewTag,
  action: string,
  command: (webview: Electron.WebviewTag) => MaybePromise<T>
): Promise<T> {
  if (!isWebviewConnected(webview)) {
    throw new Error(`Browser view is not attached while trying to ${action}.`)
  }

  const result = command(webview)
  return isPromiseLike<T>(result) ? await result : result
}

async function waitForLoad(webview: Electron.WebviewTag, timeoutMs = 30000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!isWebviewConnected(webview)) {
      resolve()
      return
    }

    let resolved = false
    const timers: { timeout?: number; detach?: number } = {}
    const done = (): void => {
      if (resolved) return
      resolved = true
      if (timers.timeout !== undefined) window.clearTimeout(timers.timeout)
      if (timers.detach !== undefined) window.clearInterval(timers.detach)
      webview.removeEventListener('did-stop-loading', done)
      webview.removeEventListener('did-fail-load', done)
      resolve()
    }
    webview.addEventListener('did-stop-loading', done)
    webview.addEventListener('did-fail-load', done)
    timers.timeout = window.setTimeout(done, timeoutMs)
    timers.detach = window.setInterval(() => {
      if (!isWebviewConnected(webview)) done()
    }, 100)
  })
}

async function waitForWebview(
  ctx?: ToolContext,
  maxWaitMs = 3000
): Promise<Electron.WebviewTag | null> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const webview = getWebview(ctx)
    if (webview) return webview
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

function getBrowserAccessError(url: string): ToolResultContent | null {
  const decision = getBrowserAccessDecision(url)
  return decision.allowed ? null : encodeToolError(decision.reason ?? 'Browser navigation blocked.')
}

function getCurrentBrowserAccessError(ctx?: ToolContext): ToolResultContent | null {
  const url = useUIStore.getState().getBrowserState(ctx?.sessionId).url
  return url ? getBrowserAccessError(url) : null
}

function extractBase64ImageData(dataUrl: string): { data: string; mediaType: string } | null {
  const commaIndex = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || commaIndex === -1) return null

  const metadata = dataUrl.slice(5, commaIndex)
  if (!metadata.includes(';base64')) return null

  return {
    data: dataUrl.slice(commaIndex + 1),
    mediaType: metadata.split(';')[0] || 'image/png'
  }
}

function parseWebviewJson<T>(raw: unknown): T {
  if (typeof raw === 'string') return JSON.parse(raw) as T
  if (raw && typeof raw === 'object') return raw as T
  throw new Error(`Unexpected browser script result: ${String(raw)}`)
}

async function executeBrowserNavigate(
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultContent> {
  const action = (input.action as string) || 'goto'

  if (action === 'goto') {
    let url = input.url as string
    if (!url || typeof url !== 'string') return encodeToolError('"url" is required for goto')
    url = url.trim()
    if (!/^https?:\/\//i.test(url) && !url.startsWith('http://localhost')) {
      url = `https://${url}`
    }
    const accessError = getBrowserAccessError(url)
    if (accessError) return accessError
    useUIStore.getState().openBrowserTab(url, ctx.sessionId)
    const webview = await waitForWebview(ctx)
    if (!webview) {
      return encodeToolError('Browser view did not attach. Reopen the browser tab and try again.')
    }
    const loadPromise = waitForLoad(webview)
    await runWebviewCommand(webview, 'navigate', (target) => {
      target.src = url
    })
    await loadPromise
    const browserState = useUIStore.getState().getBrowserState(ctx.sessionId)
    return encodeStructuredToolResult({
      success: true,
      url,
      title: browserState.pageTitle
    })
  }

  if (action !== 'back' && action !== 'forward' && action !== 'refresh') {
    return encodeToolError(`Unknown action "${action}". Use goto, back, forward, or refresh.`)
  }

  const webview = requireWebview(ctx)
  if (action === 'back') {
    const canGoBack = await runWebviewCommand(webview, 'read back navigation state', (target) =>
      target.canGoBack()
    )
    if (!canGoBack) return encodeToolError('Browser cannot go back.')
  } else if (action === 'forward') {
    const canGoForward = await runWebviewCommand(
      webview,
      'read forward navigation state',
      (target) => target.canGoForward()
    )
    if (!canGoForward) return encodeToolError('Browser cannot go forward.')
  } else {
    const accessError = getCurrentBrowserAccessError(ctx)
    if (accessError) return accessError
  }

  const loadPromise = waitForLoad(webview)
  if (action === 'back') {
    await runWebviewCommand(webview, 'go back', (target) => target.goBack())
  } else if (action === 'forward') {
    await runWebviewCommand(webview, 'go forward', (target) => target.goForward())
  } else {
    await runWebviewCommand(webview, 'refresh', (target) => target.reload())
  }
  await loadPromise
  const browserState = useUIStore.getState().getBrowserState(ctx.sessionId)
  return encodeStructuredToolResult({
    success: true,
    url: browserState.url,
    title: browserState.pageTitle
  })
}

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

async function executeBrowserGetContent(
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultContent> {
  const accessError = getCurrentBrowserAccessError(ctx)
  if (accessError) return accessError
  const webview = requireWebview(ctx)
  const selector = (input.selector as string) || ''
  const outputType = (input.type as string) || 'markdown'

  if (outputType === 'html') {
    const raw = await runWebviewCommand(webview, 'read page HTML', (target) =>
      target.executeJavaScript(
        `(function(sel) {
          var root = sel ? document.querySelector(sel) : document.body
          if (!root) return JSON.stringify({ error: 'Element not found: ' + sel })
          return JSON.stringify({ title: document.title, content: root.innerHTML })
        })(${selector ? JSON.stringify(selector) : 'null'})`
      )
    )
    const parsed = parseWebviewJson<{ error?: string; title?: string; content?: string }>(raw)
    if (parsed.error) return encodeToolError(parsed.error)
    const content = (parsed.content ?? '').slice(0, 80000)
    return encodeStructuredToolResult({
      url: useUIStore.getState().getBrowserState(ctx.sessionId).url,
      title: parsed.title,
      type: 'html',
      content
    })
  }

  const raw = await runWebviewCommand(webview, 'read page Markdown', (target) =>
    target.executeJavaScript(
      `${HTML_TO_MD_SCRIPT}(${selector ? JSON.stringify(selector) : 'null'})`
    )
  )
  const parsed = parseWebviewJson<{ error?: string; title?: string; content?: string }>(raw)
  if (parsed.error) return encodeToolError(parsed.error)
  const content = (parsed.content ?? '').slice(0, 80000)
  return encodeStructuredToolResult({
    url: useUIStore.getState().getBrowserState(ctx.sessionId).url,
    title: parsed.title,
    type: 'markdown',
    content
  })
}

async function executeBrowserScreenshot(
  _input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultContent> {
  const accessError = getCurrentBrowserAccessError(ctx)
  if (accessError) return accessError
  const webview = requireWebview(ctx)
  const nativeImage = await runWebviewCommand(webview, 'capture screenshot', (target) =>
    target.capturePage()
  )
  if (nativeImage.isEmpty()) {
    return encodeToolError('Failed to capture screenshot; page may still be loading.')
  }
  const encodedImage = extractBase64ImageData(nativeImage.toDataURL())
  if (!encodedImage?.data) {
    return encodeToolError('Failed to encode screenshot image.')
  }
  const size = nativeImage.getSize()
  const persisted = (await ctx.ipc.invoke(IPC.IMAGE_PERSIST_GENERATED, {
    data: encodedImage.data,
    mediaType: encodedImage.mediaType
  })) as { filePath?: string; mediaType?: string; data?: string; error?: string }
  const image: ImageBlock = {
    type: 'image',
    source: {
      type: 'base64',
      mediaType: persisted?.mediaType || encodedImage.mediaType,
      data: persisted?.data || encodedImage.data,
      ...(persisted?.filePath ? { filePath: persisted.filePath } : {})
    }
  }
  return [
    image,
    {
      type: 'text',
      text: `Screenshot captured: ${size.width}x${size.height}px - ${useUIStore.getState().getBrowserState(ctx.sessionId).url}`
    }
  ]
}

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
    if (text) desc += ' - "' + text + '"'

    results.push({ selector: sel, description: desc })
  })

  return JSON.stringify({ title: document.title, count: results.length, elements: results })
})()
`

async function executeBrowserSnapshot(
  _input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultContent> {
  const accessError = getCurrentBrowserAccessError(ctx)
  if (accessError) return accessError
  const webview = requireWebview(ctx)
  const raw = await runWebviewCommand(webview, 'read interactive elements', (target) =>
    target.executeJavaScript(SNAPSHOT_SCRIPT)
  )
  const parsed = parseWebviewJson<{
    title?: string
    count?: number
    elements?: Array<{ selector: string; description: string }>
  }>(raw)
  const elements = parsed.elements ?? []
  const lines = elements
    .map((item, index) => `[${index}] ${item.description}\n    selector: ${item.selector}`)
    .join('\n')
  return encodeStructuredToolResult({
    url: useUIStore.getState().getBrowserState(ctx.sessionId).url,
    title: parsed.title,
    elementCount: parsed.count ?? elements.length,
    elements: lines
  })
}

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

async function executeBrowserClick(
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultContent> {
  const accessError = getCurrentBrowserAccessError(ctx)
  if (accessError) return accessError
  const webview = requireWebview(ctx)
  const selector = input.selector as string
  if (!selector) return encodeToolError('"selector" is required')
  const raw = await runWebviewCommand(webview, 'click page element', (target) =>
    target.executeJavaScript(`${CLICK_SCRIPT}(${JSON.stringify(selector)})`)
  )
  const parsed = parseWebviewJson<{ error?: string; tag?: string; text?: string }>(raw)
  if (parsed.error) return encodeToolError(parsed.error)
  await new Promise((resolve) => setTimeout(resolve, 300))
  return encodeStructuredToolResult({
    success: true,
    clicked: `<${parsed.tag}> "${parsed.text}"`
  })
}

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

async function executeBrowserType(
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultContent> {
  const accessError = getCurrentBrowserAccessError(ctx)
  if (accessError) return accessError
  const webview = requireWebview(ctx)
  const selector = input.selector as string
  const text = input.text as string
  const clear = input.clear !== false
  const submit = input.submit === true
  if (!selector) return encodeToolError('"selector" is required')
  if (text == null) return encodeToolError('"text" is required')
  const raw = await runWebviewCommand(webview, 'type into page element', (target) =>
    target.executeJavaScript(
      `${TYPE_SCRIPT}(${JSON.stringify(selector)}, ${JSON.stringify(text)}, ${clear}, ${submit})`
    )
  )
  const parsed = parseWebviewJson<{ error?: string; tag?: string; value?: string }>(raw)
  if (parsed.error) return encodeToolError(parsed.error)
  return encodeStructuredToolResult({
    success: true,
    element: parsed.tag,
    value: parsed.value
  })
}

async function executeBrowserScroll(
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultContent> {
  const accessError = getCurrentBrowserAccessError(ctx)
  if (accessError) return accessError
  const webview = requireWebview(ctx)
  const direction = (input.direction as string) || 'down'
  const amount = typeof input.amount === 'number' ? input.amount : 0
  const raw = await runWebviewCommand(webview, 'scroll page', (target) =>
    target.executeJavaScript(`
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
  )
  const parsed = parseWebviewJson<{
    scrollY?: number
    scrollHeight?: number
    viewportHeight?: number
  }>(raw)
  return encodeStructuredToolResult({
    success: true,
    scrollY: parsed.scrollY,
    scrollHeight: parsed.scrollHeight,
    viewportHeight: parsed.viewportHeight
  })
}

async function runBrowserTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResultContent> {
  switch (toolName) {
    case 'BrowserNavigate':
      return await executeBrowserNavigate(input, ctx)
    case 'BrowserGetContent':
      return await executeBrowserGetContent(input, ctx)
    case 'BrowserScreenshot':
      return await executeBrowserScreenshot(input, ctx)
    case 'BrowserSnapshot':
      return await executeBrowserSnapshot(input, ctx)
    case 'BrowserClick':
      return await executeBrowserClick(input, ctx)
    case 'BrowserType':
      return await executeBrowserType(input, ctx)
    case 'BrowserScroll':
      return await executeBrowserScroll(input, ctx)
    default:
      return encodeToolError(`Unsupported browser tool: ${toolName}`)
  }
}

export async function handleNativeBrowserToolRequest(
  params: unknown
): Promise<NativeBrowserToolResponse> {
  const record = normalizeRecord(params)
  const toolName = typeof record.toolName === 'string' ? record.toolName : ''
  const input = normalizeRecord(record.input)
  const ctx = createToolContext(record)

  try {
    return {
      content: await runBrowserTool(toolName, input, ctx),
      isError: false
    }
  } catch (error) {
    const message = describeWebviewOperationError(
      toolName ? `run ${toolName}` : 'run browser tool',
      error
    )
    return {
      content: encodeToolError(message),
      isError: true,
      error: message
    }
  }
}
