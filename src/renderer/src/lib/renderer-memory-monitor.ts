import type { ContentBlock, UnifiedMessage } from './api/types'
import { getRequestDebugStoreStats } from './debug-store'
import { useChatStore } from '../stores/chat-store'
import { useSettingsStore } from '../stores/settings-store'

const RENDERER_MEMORY_SAMPLE_MS = 60_000
const RENDERER_MEMORY_INITIAL_DELAY_MS = 10_000
const WARN_USED_JS_HEAP_BYTES = 512 * 1024 * 1024
const WARN_RESIDENT_CONTENT_CHARS = 64 * 1024 * 1024

type ChromiumPerformanceMemory = {
  usedJSHeapSize?: number
  totalJSHeapSize?: number
  jsHeapSizeLimit?: number
}

let installed = false

export function installRendererMemoryMonitor(): () => void {
  if (installed) return () => {}
  installed = true

  const initialTimer = window.setTimeout(sampleRendererMemory, RENDERER_MEMORY_INITIAL_DELAY_MS)
  const interval = window.setInterval(sampleRendererMemory, RENDERER_MEMORY_SAMPLE_MS)

  return () => {
    window.clearTimeout(initialTimer)
    window.clearInterval(interval)
    installed = false
  }
}

function shouldLogRendererMemory(): boolean {
  if (import.meta.env.DEV) return true
  if (useSettingsStore.getState().devMode) return true
  try {
    return localStorage.getItem('openCowork.rendererMemoryDebug') === '1'
  } catch {
    return false
  }
}

function readChromiumMemory(): ChromiumPerformanceMemory | null {
  const memory = (performance as Performance & { memory?: ChromiumPerformanceMemory }).memory
  return memory ?? null
}

function sampleRendererMemory(): void {
  const chatStore = useChatStore.getState()
  chatStore.releaseDormantSessions()

  if (!shouldLogRendererMemory()) return

  const state = useChatStore.getState()
  const residentSessions = state.sessions.filter((session) => session.messages.length > 0)
  const residentMessages = residentSessions.reduce(
    (sum, session) => sum + session.messages.length,
    0
  )
  const residentContentChars = residentSessions.reduce(
    (sum, session) => sum + estimateMessagesContentChars(session.messages),
    0
  )
  const previewContentChars = Object.values(state.generatingImagePreviews).reduce(
    (sum, preview) => sum + estimateContentBlockChars(preview),
    0
  )
  const heap = readChromiumMemory()
  const debugStore = getRequestDebugStoreStats()
  const details = {
    heap: heap
      ? {
          usedMB: bytesToMb(heap.usedJSHeapSize),
          totalMB: bytesToMb(heap.totalJSHeapSize),
          limitMB: bytesToMb(heap.jsHeapSizeLimit)
        }
      : null,
    sessions: state.sessions.length,
    residentSessions: residentSessions.length,
    residentMessages,
    knownMessages: state.sessions.reduce((sum, session) => sum + session.messageCount, 0),
    residentContentMB: charsToMb(residentContentChars),
    generatingImagePreviews: Object.keys(state.generatingImagePreviews).length,
    previewContentMB: charsToMb(previewContentChars),
    debugStore: {
      entries: debugStore.entries,
      debugEntries: debugStore.debugEntries,
      bodyMB: charsToMb(debugStore.bodyChars),
      contextWindowMB: charsToMb(debugStore.contextWindowChars)
    },
    activeSessionId: state.activeSessionId
  }
  const usedJsHeap = heap?.usedJSHeapSize ?? 0
  const shouldWarn =
    usedJsHeap >= WARN_USED_JS_HEAP_BYTES ||
    residentContentChars >= WARN_RESIDENT_CONTENT_CHARS ||
    previewContentChars >= WARN_RESIDENT_CONTENT_CHARS
  const log = shouldWarn ? console.warn : console.log
  log('[RendererMemory] sample', details)
}

function estimateMessagesContentChars(messages: UnifiedMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += estimateMessageContentChars(message)
    total += message.debugInfo?.body?.length ?? 0
    total += message.debugInfo?.contextWindowBody?.length ?? 0
  }
  return total
}

function estimateMessageContentChars(message: UnifiedMessage): number {
  if (typeof message.content === 'string') return message.content.length
  if (!Array.isArray(message.content)) return 0
  return message.content.reduce((sum, block) => sum + estimateContentBlockChars(block), 0)
}

function estimateContentBlockChars(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return block.text.length
    case 'thinking':
      return block.thinking.length + (block.encryptedContent?.length ?? 0)
    case 'image':
      return block.source.type === 'base64'
        ? (block.source.data?.length ?? 0)
        : (block.source.url?.length ?? 0)
    case 'tool_use':
      return block.name.length + estimateJsonChars(block.input)
    case 'tool_result':
      return estimateJsonChars(block.content)
    case 'image_error':
      return block.message.length
    case 'agent_error':
      return block.message.length
    default:
      return estimateJsonChars(block)
  }
}

function estimateJsonChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

function bytesToMb(value?: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round((value / 1024 / 1024) * 10) / 10
}

function charsToMb(chars: number): number {
  return Math.round((chars / 1024 / 1024) * 10) / 10
}
