import { app, BrowserWindow, powerMonitor, screen } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { cp, mkdir, readdir, stat } from 'fs/promises'
import { registerMessagePackHandler } from './messagepack-handler'
import { safeSendMessagePackToAllWindows } from '../window-ipc'
import { decodePersistedStoreState, readSettings, setSettingsValue } from './settings-handlers'

const PET_WINDOW_HEIGHT = 380
const PET_ENABLED_SETTINGS_KEY = 'petDesktopEnabled'
const PET_EXP_SETTINGS_KEY = 'opencowork-pet-exp'
const PET_EXP_LOG_LIMIT = 100

type PetExpAddArgs = {
  id: string
  at: number
  model: string
  tokens: number
  premium: boolean
  exp: number
}

type PetWindowDeps = {
  loadRendererWindow: (window: BrowserWindow, searchParams?: URLSearchParams) => Promise<void>
  showMainWindow: () => void
}

type PetTtsStreamArgs = {
  requestId: string
  provider?: {
    baseUrl?: string
    apiKey?: string
    model?: string
    requestOverrides?: { headers?: Record<string, string>; body?: Record<string, unknown> }
  }
  input?: string
  voice?: string
  instruction?: string
  chatStyle?: string
}

const petTtsStreams = new Map<string, AbortController>()

async function streamChatTts(
  args: PetTtsStreamArgs,
  signal: AbortSignal,
  onChunk: (base64Pcm: string) => void
): Promise<void> {
  const provider = args.provider!
  const baseUrl = (provider.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
  const input = args.input!.trim()
  const instruction = args.instruction?.trim()

  // Same two message shapes as the native worker's non-streaming path:
  // MiMo speaks the assistant message verbatim; OpenAI audio models get a
  // read-aloud instruction in a user message.
  const messages: Array<{ role: string; content: string }> = []
  if (args.chatStyle === 'instruct') {
    const directive = instruction
      ? `Read the following text aloud exactly as written. Do not add, omit or change anything. Speaking style: ${instruction}`
      : 'Read the following text aloud exactly as written. Do not add, omit or change anything.'
    messages.push({ role: 'user', content: `${directive}\n\n${input}` })
  } else {
    if (instruction) messages.push({ role: 'user', content: instruction })
    messages.push({ role: 'assistant', content: input })
  }

  const body: Record<string, unknown> = {
    model: provider.model,
    modalities: ['text', 'audio'],
    messages,
    audio: args.voice ? { format: 'pcm16', voice: args.voice } : { format: 'pcm16' },
    stream: true,
    ...(provider.requestOverrides?.body ?? {})
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey ?? ''}`,
      ...(provider.requestOverrides?.headers ?? {})
    },
    body: JSON.stringify(body),
    signal
  })
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    throw new Error(`TTS stream failed HTTP ${response.status}: ${text.slice(0, 300)}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { audio?: { data?: string } } }>
        }
        const data = json.choices?.[0]?.delta?.audio?.data
        if (typeof data === 'string' && data.length > 0) onChunk(data)
      } catch {
        // keep-alives / non-JSON lines
      }
    }
  }
}

let petWindow: BrowserWindow | null = null
let deps: PetWindowDeps | null = null
let opening = false

export function isPetWindowOpen(): boolean {
  return !!petWindow && !petWindow.isDestroyed()
}

export function isPetEnabled(): boolean {
  return readSettings()[PET_ENABLED_SETTINGS_KEY] === true
}

function broadcastPetWindowChanged(): void {
  safeSendMessagePackToAllWindows('pet-window:changed', { open: isPetWindowOpen() })
}

async function persistPetEnabled(enabled: boolean): Promise<void> {
  try {
    await setSettingsValue(PET_ENABLED_SETTINGS_KEY, enabled ? true : undefined)
  } catch (error) {
    console.error('[Pet] Failed to persist pet enabled state:', error)
  }
}

export async function openPetWindow(): Promise<void> {
  if (!deps || opening) return

  if (isPetWindowOpen()) {
    petWindow?.showInactive()
    return
  }

  opening = true
  const workArea = screen.getPrimaryDisplay().workArea
  const height = Math.min(PET_WINDOW_HEIGHT, workArea.height)

  const window = new BrowserWindow({
    x: workArea.x,
    y: workArea.y + workArea.height - height,
    width: workArea.width,
    height,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  petWindow = window
  window.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  // Click-through by default; the renderer re-enables mouse events while the
  // pointer is over the pet, its menu or HUD.
  window.setIgnoreMouseEvents(true, { forward: true })

  window.on('ready-to-show', () => {
    // Re-apply on macOS: ignore state set before the first paint can be lost.
    window.setIgnoreMouseEvents(true, { forward: true })
    window.showInactive()
  })

  window.on('closed', () => {
    if (petWindow === window) {
      petWindow = null
    }
    broadcastPetWindowChanged()
  })

  try {
    await deps.loadRendererWindow(window, new URLSearchParams({ appView: 'pet' }))
    if (!window.isDestroyed()) {
      window.setIgnoreMouseEvents(true, { forward: true })
    }
    broadcastPetWindowChanged()
  } catch (error) {
    petWindow = null
    if (!window.isDestroyed()) {
      window.destroy()
    }
    console.error('[Pet] Failed to open pet window:', error)
  } finally {
    opening = false
  }
}

export function closePetWindow(): void {
  if (!isPetWindowOpen()) return
  const window = petWindow
  petWindow = null
  window?.destroy()
  broadcastPetWindowChanged()
}

export async function togglePetWindow(): Promise<void> {
  if (isPetWindowOpen()) {
    closePetWindow()
    await persistPetEnabled(false)
    return
  }
  await openPetWindow()
  await persistPetEnabled(true)
}

export async function openPetWindowOnStartupIfEnabled(): Promise<void> {
  if (isPetEnabled()) {
    await openPetWindow()
  }
}

function getBundledPetDirCandidates(): string[] {
  if (!app.isPackaged) {
    return [join(app.getAppPath(), 'resources', 'pets')]
  }
  return [
    join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'pets'),
    join(process.resourcesPath, 'resources', 'pets')
  ]
}

/**
 * Install/repair bundled pets into ~/.open-cowork/pets. File-level
 * fill-missing semantics: files the user already has are never overwritten,
 * but files absent from an installed pet (older app version, interrupted
 * install) are copied in. (The default capybara ships in renderer assets and
 * is not part of this.)
 */
export async function installBuiltinPets(): Promise<void> {
  try {
    const targetRoot = join(homedir(), '.open-cowork', 'pets')
    await mkdir(targetRoot, { recursive: true })

    for (const candidate of getBundledPetDirCandidates()) {
      let entries: string[]
      try {
        entries = await readdir(candidate)
      } catch {
        continue
      }
      for (const entry of entries) {
        const source = join(candidate, entry)
        try {
          if (!(await stat(source)).isDirectory()) continue
        } catch {
          continue
        }
        const targetDir = join(targetRoot, entry)
        await mkdir(targetDir, { recursive: true })

        let installed = 0
        for (const file of await readdir(source)) {
          const sourceFile = join(source, file)
          try {
            if (!(await stat(sourceFile)).isFile()) continue
          } catch {
            continue
          }
          const targetFile = join(targetDir, file)
          try {
            await stat(targetFile)
            continue // user's copy wins
          } catch {
            // missing: fill in
          }
          await cp(sourceFile, targetFile)
          installed++
        }
        if (installed > 0) {
          console.log(`[Pet] Installed built-in pet files: ${entry} (+${installed})`)
        }
      }
      break // first existing candidate wins
    }
  } catch (error) {
    console.error('[Pet] Failed to install built-in pets:', error)
  }
}

export function registerPetHandlers(petDeps: PetWindowDeps): void {
  deps = petDeps

  registerMessagePackHandler<void>('pet-window:open', async () => {
    await openPetWindow()
    await persistPetEnabled(true)
    return { open: isPetWindowOpen() }
  })

  registerMessagePackHandler<void>('pet-window:close', async () => {
    closePetWindow()
    await persistPetEnabled(false)
    return { open: false }
  })

  registerMessagePackHandler<void>('pet-window:status', () => ({
    open: isPetWindowOpen(),
    enabled: isPetEnabled()
  }))

  registerMessagePackHandler<{ ignore?: boolean }>('pet-window:set-ignore-mouse', (args, event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window !== petWindow || window.isDestroyed()) return
    window.setIgnoreMouseEvents(args?.ignore !== false, { forward: true })
  })

  // The pet window is non-focusable by default; the chat input needs the
  // window to accept keyboard focus while it is open.
  registerMessagePackHandler<{ focusable?: boolean }>('pet-window:set-focusable', (args, event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window !== petWindow || window.isDestroyed()) return
    const focusable = args?.focusable === true
    if (focusable) {
      window.setFocusable(true)
      // show() (not showInactive) is what makes a previously non-focusable
      // window become the key window on macOS; re-assert always-on-top after
      // the focusable toggle.
      window.show()
      window.focus()
      window.setAlwaysOnTop(true, 'floating')
    } else {
      // Hand key status back before the toggle; setFocusable resets the
      // window level on macOS, which blinks unless always-on-top is
      // re-asserted and the window is re-ordered without taking focus.
      window.blur()
      window.setFocusable(false)
      window.setAlwaysOnTop(true, 'floating')
      window.showInactive()
    }
  })

  // Seconds since the last user input, for the pet's doze/welcome-back
  // behavior when the user steps away from the computer.
  registerMessagePackHandler<void>('pet-window:idle-seconds', () => {
    return powerMonitor.getSystemIdleTime()
  })

  // Streaming chat-audio TTS (MiMo / gpt-4o-audio, stream: true, pcm16):
  // SSE audio deltas are forwarded as 'pet:tts-stream-event' chunks so the
  // renderer can start playback while synthesis is still running. The
  // invoke itself resolves when the stream ends.
  registerMessagePackHandler<PetTtsStreamArgs>('pet:tts-stream', async (args) => {
    const requestId = args?.requestId
    if (!requestId || !args?.provider || !args?.input?.trim()) {
      throw new Error('invalid tts stream request')
    }
    const controller = new AbortController()
    petTtsStreams.set(requestId, controller)
    try {
      await streamChatTts(args, controller.signal, (data) => {
        safeSendMessagePackToAllWindows('pet:tts-stream-event', {
          requestId,
          type: 'chunk',
          data
        })
      })
      return { ok: true }
    } finally {
      petTtsStreams.delete(requestId)
    }
  })

  registerMessagePackHandler<{ requestId?: string }>('pet:tts-cancel', (args) => {
    if (args?.requestId) petTtsStreams.get(args.requestId)?.abort()
  })

  // Cross-window pet state relay: settings window broadcasts skin/profile
  // changes; the pet window (a separate renderer) picks them up live.
  registerMessagePackHandler<{ kind: string; payload?: unknown }>('pet:sync', (args) => {
    safeSendMessagePackToAllWindows('pet:sync-event', args ?? { kind: 'unknown' })
  })

  // From the pet's context menu: focus the main window on the pet studio.
  registerMessagePackHandler<void>('pet:open-studio', () => {
    deps?.showMainWindow()
    safeSendMessagePackToAllWindows('pet:sync-event', { kind: 'open-studio' })
  })

  // Pet experience ledger. The main process is the single writer so that
  // multiple renderer windows recording usage can't clobber each other.
  registerMessagePackHandler<PetExpAddArgs>('pet:exp-add', async (args) => {
    if (!args || typeof args.exp !== 'number' || !Number.isFinite(args.exp) || args.exp <= 0) {
      return { success: false }
    }
    const persisted =
      decodePersistedStoreState<{
        totalExp?: number
        totalTokens?: number
        log?: PetExpAddArgs[]
      }>(readSettings()[PET_EXP_SETTINGS_KEY]) ?? {}
    const totalExp = Math.round(((persisted.totalExp ?? 0) + args.exp) * 100) / 100
    const totalTokens = (persisted.totalTokens ?? 0) + (args.tokens > 0 ? args.tokens : 0)
    const log = [args, ...(Array.isArray(persisted.log) ? persisted.log : [])].slice(
      0,
      PET_EXP_LOG_LIMIT
    )
    await setSettingsValue(
      PET_EXP_SETTINGS_KEY,
      JSON.stringify({ state: { totalExp, totalTokens, log }, version: 0 })
    )
    safeSendMessagePackToAllWindows('pet:sync-event', { kind: 'exp' })
    return { success: true, totalExp }
  })
}
