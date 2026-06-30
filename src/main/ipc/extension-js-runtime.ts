import vm from 'vm'
import type {
  ExtensionFetchRequest,
  ExtensionFetchResponse,
  ExtensionInstance,
  ExtensionToolDefinition,
  ExtensionToolResult
} from '../../shared/extension-types'
import { nativeExtensionRequest } from './extension-native-bridge'

const EXTENSION_JS_HANDLER_TIMEOUT_MS = 30_000
const EXTENSION_JS_ENTRY_TIMEOUT_MS = 1_000
const MAX_EXTENSION_FETCH_REDIRECTS = 5

type ExtensionJsExecuteParams = {
  extensionId?: string
  toolName?: string
  input?: unknown
}

type ExtensionJsExecutionResult = {
  success: boolean
  content?: string
  error?: string
}

type ExtensionAssetResult = {
  content?: string
  error?: string
}

type ExtensionMutationResult = {
  success: boolean
  error?: string
}

type ExtensionJsSandbox = Record<string, unknown> & {
  openCoworkExtension?: {
    handlers?: Record<string, unknown>
  }
  __openCoworkInput?: Record<string, unknown>
  __openCoworkContext?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function normalizeFetchRequest(value: unknown): ExtensionFetchRequest {
  const request = normalizeObject(value)
  const url = asString(request.url).trim()
  if (!url) throw new Error('ctx.fetch requires request.url')
  return {
    url,
    ...(typeof request.method === 'string' ? { method: request.method } : {}),
    ...(isRecord(request.headers) ? { headers: normalizeStringMap(request.headers) } : {}),
    ...('body' in request ? { body: request.body } : {})
  }
}

function normalizeStringMap(value: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item
  }
  return result
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseExtensionToolName(
  toolName: string
): { extensionId: string; toolName: string } | null {
  const prefix = 'extension__'
  if (!toolName.startsWith(prefix)) return null
  const rest = toolName.slice(prefix.length)
  const separatorIndex = rest.indexOf('__')
  if (separatorIndex <= 0 || separatorIndex + 2 >= rest.length) return null
  return {
    extensionId: rest.slice(0, separatorIndex),
    toolName: rest.slice(separatorIndex + 2)
  }
}

async function listExtensions(): Promise<ExtensionInstance[]> {
  return await nativeExtensionRequest<ExtensionInstance[]>('extension/list')
}

async function findExtensionOrThrow(extensionId: string): Promise<ExtensionInstance> {
  const extension = (await listExtensions()).find((item) => item.id === extensionId)
  if (!extension) throw new Error(`Extension "${extensionId}" not found`)
  if (!extension.enabled) throw new Error(`Extension "${extensionId}" is disabled`)
  return extension
}

function findToolOrThrow(extension: ExtensionInstance, toolName: string): ExtensionToolDefinition {
  const tool = extension.manifest.tools.find((item) => item.name === toolName)
  if (!tool) throw new Error(`Tool "${toolName}" not found in extension "${extension.id}"`)
  if (tool.kind !== 'js') throw new Error(`Tool "${toolName}" is not a JavaScript tool`)
  if (!tool.handler) throw new Error(`JavaScript tool "${toolName}" requires handler`)
  return tool
}

function describeExtensionConfigForLog(extension: ExtensionInstance): Record<string, unknown> {
  const schema = extension.manifest.configSchema ?? []
  const configured = new Set(Object.keys(extension.config))
  const fields: Array<{
    key: string
    type: string
    present: boolean
    length: number
  }> = schema.map((field) => {
    const value = extension.config[field.key] ?? ''
    return {
      key: field.key,
      type: field.type,
      present: value.trim().length > 0,
      length: value.length
    }
  })

  for (const key of configured) {
    if (schema.some((field) => field.key === key)) continue
    const value = extension.config[key] ?? ''
    fields.push({
      key,
      type: 'unknown',
      present: value.trim().length > 0,
      length: value.length
    })
  }

  return {
    fieldCount: fields.length,
    fields
  }
}

async function readExtensionAsset(extensionId: string, assetPath: string): Promise<string> {
  const result = await nativeExtensionRequest<ExtensionAssetResult>('extension/read-asset', {
    id: extensionId,
    path: assetPath
  })
  if (result.error) throw new Error(result.error)
  return result.content ?? ''
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function isNetworkAllowed(extension: ExtensionInstance, targetUrl: string): boolean {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return false
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false

  const allowlist = extension.manifest.permissions?.network ?? []
  if (allowlist.includes('*')) return true
  if (allowlist.length === 0) return false

  return allowlist.some((allowed) => {
    const value = allowed.trim()
    if (!value) return false
    if (value.endsWith('*')) return target.href.startsWith(value.slice(0, -1))
    try {
      const allowedUrl = new URL(value)
      return target.origin === allowedUrl.origin && target.href.startsWith(allowedUrl.href)
    } catch {
      return target.origin === value
    }
  })
}

function describeExtensionFetchUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return '(invalid url)'
  }
}

async function performExtensionFetch(
  extension: ExtensionInstance,
  request: ExtensionFetchRequest
): Promise<ExtensionFetchResponse> {
  let url = request.url
  let method = (request.method || 'GET').toUpperCase()
  const headers = { ...(request.headers ?? {}) }
  let body: BodyInit | undefined

  if (request.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    if (typeof request.body === 'string') {
      body = request.body
    } else {
      body = JSON.stringify(request.body)
      const hasContentType = Object.keys(headers).some(
        (key) => key.toLowerCase() === 'content-type'
      )
      if (!hasContentType) headers['Content-Type'] = 'application/json'
    }
  }

  let response: Response | null = null
  for (let redirectCount = 0; redirectCount <= MAX_EXTENSION_FETCH_REDIRECTS; redirectCount += 1) {
    if (!url || !isNetworkAllowed(extension, url)) {
      throw new Error(`Network access denied for ${url || '(empty url)'}`)
    }

    response = await fetch(url, { method, headers, body, redirect: 'manual' })
    const location = response.headers.get('location')
    if (!response.ok && !isRedirectStatus(response.status)) {
      console.warn('[ExtensionFetch] request failed', {
        extensionId: extension.id,
        method,
        url: describeExtensionFetchUrl(url),
        status: response.status,
        statusText: response.statusText
      })
    }
    if (!isRedirectStatus(response.status) || !location) break
    if (redirectCount === MAX_EXTENSION_FETCH_REDIRECTS) {
      throw new Error('Extension fetch exceeded redirect limit')
    }

    const nextUrl = new URL(location, url).href
    if (!isNetworkAllowed(extension, nextUrl)) {
      throw new Error(`Network access denied for redirect to ${nextUrl}`)
    }
    console.debug('[ExtensionFetch] redirect', {
      extensionId: extension.id,
      method,
      status: response.status,
      from: describeExtensionFetchUrl(url),
      to: describeExtensionFetchUrl(nextUrl)
    })
    url = nextUrl

    if (response.status === 303) {
      method = 'GET'
      body = undefined
      delete headers['Content-Type']
      delete headers['content-type']
    }
  }
  if (!response) throw new Error('Extension fetch failed')

  const text = await response.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    text,
    ...(json !== undefined ? { json } : {})
  }
}

async function storageGet(extensionId: string, key: string): Promise<unknown> {
  return await nativeExtensionRequest<unknown>('extension/storage-get', { extensionId, key })
}

async function storageSet(extensionId: string, key: string, value: unknown): Promise<void> {
  const result = await nativeExtensionRequest<ExtensionMutationResult>('extension/storage-set', {
    extensionId,
    key,
    value
  })
  if (!result.success) throw new Error(result.error ?? 'Extension storage set failed')
}

async function storageDelete(extensionId: string, key: string): Promise<void> {
  const result = await nativeExtensionRequest<ExtensionMutationResult>('extension/storage-delete', {
    extensionId,
    key
  })
  if (!result.success) throw new Error(result.error ?? 'Extension storage delete failed')
}

function normalizeJsResult(
  extension: ExtensionInstance,
  tool: ExtensionToolDefinition,
  value: unknown
): Omit<ExtensionToolResult, '__openCoworkExtensionResult'> {
  if (isRecord(value)) {
    return {
      extensionId: extension.id,
      toolName: tool.name,
      ...(typeof value.text === 'string' ? { text: value.text } : {}),
      ...('data' in value ? { data: value.data } : {}),
      ...(isRecord(value.ui) ? { ui: value.ui as ExtensionToolResult['ui'] } : {})
    }
  }

  return {
    extensionId: extension.id,
    toolName: tool.name,
    text: typeof value === 'string' ? value : JSON.stringify(value),
    data: value
  }
}

function encodeExtensionToolResult(
  result: Omit<ExtensionToolResult, '__openCoworkExtensionResult'>
): string {
  return JSON.stringify({
    __openCoworkExtensionResult: true,
    ...result
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Extension handler timed out')), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function createSandbox(): ExtensionJsSandbox {
  const sandbox: ExtensionJsSandbox = {
    console,
    fetch: () =>
      Promise.reject(
        new Error(
          'Direct fetch is disabled in OpenCowork extension sandboxes. Use ctx.fetch instead.'
        )
      ),
    XMLHttpRequest: undefined,
    WebSocket: undefined,
    EventSource: undefined,
    require: undefined,
    module: undefined,
    exports: undefined,
    process: undefined
  }
  sandbox.globalThis = sandbox
  return sandbox
}

export async function executeJsExtensionToolInMain(
  rawParams: unknown
): Promise<ExtensionJsExecutionResult> {
  try {
    const params = normalizeObject(rawParams) as ExtensionJsExecuteParams
    const parsed = parseExtensionToolName(asString(params.toolName))
    const extensionId = asString(params.extensionId) || parsed?.extensionId || ''
    const toolName = parsed?.toolName ?? asString(params.toolName)
    if (!extensionId || !toolName) {
      throw new Error('extension:execute-js-tool requires extensionId and toolName')
    }

    const extension = await findExtensionOrThrow(extensionId)
    const tool = findToolOrThrow(extension, toolName)
    const entry = extension.manifest.entry?.trim()
    if (!entry) throw new Error(`Extension "${extension.id}" does not define an entry file`)

    console.debug('[ExtensionJS] execute tool', {
      extensionId: extension.id,
      toolName: tool.name,
      handler: tool.handler,
      config: describeExtensionConfigForLog(extension)
    })

    const entryCode = await readExtensionAsset(extension.id, entry)
    const sandbox = createSandbox()
    const context = vm.createContext(sandbox, {
      name: `open-cowork-extension:${extension.id}`,
      codeGeneration: { strings: true, wasm: false }
    })

    new vm.Script(entryCode, { filename: `${extension.id}/${entry}` }).runInContext(context, {
      timeout: EXTENSION_JS_ENTRY_TIMEOUT_MS
    })

    sandbox.__openCoworkInput = normalizeObject(params.input)
    sandbox.__openCoworkContext = Object.freeze({
      config: Object.freeze({ ...extension.config }),
      fetch: (request: unknown) => performExtensionFetch(extension, normalizeFetchRequest(request)),
      storage: Object.freeze({
        get: (key: unknown) => storageGet(extension.id, String(key ?? '')),
        set: (key: unknown, value: unknown) => storageSet(extension.id, String(key ?? ''), value),
        delete: (key: unknown) => storageDelete(extension.id, String(key ?? ''))
      })
    })

    const invocation = new vm.Script(
      `
      (async () => {
        const extension = globalThis.openCoworkExtension;
        const handler = extension && extension.handlers && extension.handlers[${JSON.stringify(tool.handler)}];
        if (typeof handler !== 'function') {
          throw new Error('Extension handler not found: ${String(tool.handler).replace(/'/g, "\\'")}');
        }
        return await handler(globalThis.__openCoworkInput || {}, globalThis.__openCoworkContext);
      })()
      `,
      { filename: `${extension.id}/${entry}:${tool.handler}` }
    ).runInContext(context, { timeout: EXTENSION_JS_ENTRY_TIMEOUT_MS }) as Promise<unknown>

    const value = await withTimeout(Promise.resolve(invocation), EXTENSION_JS_HANDLER_TIMEOUT_MS)
    return {
      success: true,
      content: encodeExtensionToolResult(normalizeJsResult(extension, tool, value))
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
