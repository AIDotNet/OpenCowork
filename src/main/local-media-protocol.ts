import { protocol, net } from 'electron'
import { createReadStream } from 'fs'
import * as path from 'path'
import { realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import { Readable } from 'stream'
import { pathToFileURL } from 'url'

/**
 * Custom scheme that streams local media files straight from disk, so the
 * renderer can display images/videos of any size without pushing base64
 * through IPC (fs:read-file-binary caps reads at ~10 MB). URL shape:
 * `oc-media://local/<encodeURIComponent(absolutePath)>` — built by
 * `filePathToMediaUrl` in src/renderer/src/lib/local-media-url.ts.
 */
export const LOCAL_MEDIA_SCHEME = 'oc-media'

const URL_PREFIX = `${LOCAL_MEDIA_SCHEME}://local/`

const ALLOWED_ROOTS = [
  // Main-process persistence uses ~/open-cowork/{image,video}; native media
  // providers persist under ~/.open-cowork/media/{images,video}.
  path.join(homedir(), 'open-cowork', 'image'),
  path.join(homedir(), 'open-cowork', 'video'),
  path.join(homedir(), '.open-cowork', 'media', 'images'),
  path.join(homedir(), '.open-cowork', 'media', 'video'),
  path.join(homedir(), '.open-cowork', 'media', 'videos')
]

const ALLOWED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.svg',
  '.avif',
  '.ico',
  '.mp4',
  '.webm',
  '.mov',
  '.m4v',
  '.ogg',
  '.mp3',
  '.wav',
  '.m4a'
])

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ogg': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4'
}

interface ByteRange {
  start: number
  end: number
}

function parseByteRange(value: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || (!match[1] && !match[2]) || size <= 0) return null

  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }

  const start = Number(match[1])
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null

  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null
  return { start, end: Math.min(requestedEnd, size - 1) }
}

function isWithinRoot(filePath: string, root: string): boolean {
  const relativePath = path.relative(root, filePath)
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  )
}

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false
  // file:// documents serialize their origin as "null" in CORS requests.
  if (origin === 'null') return true
  return origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173'
}

/** Must run before app ready. */
export function registerLocalMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_MEDIA_SCHEME,
      privileges: { secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/** Must run after app ready. */
export function registerLocalMediaProtocolHandler(): void {
  protocol.handle(LOCAL_MEDIA_SCHEME, async (request) => {
    if (!request.url.startsWith(URL_PREFIX)) {
      return new Response('Bad request', { status: 400 })
    }
    const encodedPath = request.url.slice(URL_PREFIX.length).split(/[?#]/, 1)[0]
    let filePath = ''
    try {
      filePath = decodeURIComponent(encodedPath)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (!filePath || !path.isAbsolute(filePath)) {
      return new Response('Bad request', { status: 400 })
    }

    let realFilePath: string
    try {
      realFilePath = await realpath(filePath)
      const realRoots = await Promise.all(
        ALLOWED_ROOTS.map(async (root) => {
          try {
            return await realpath(root)
          } catch {
            return null
          }
        })
      )
      if (!realRoots.some((root) => root !== null && isWithinRoot(realFilePath, root))) {
        return new Response('Forbidden', { status: 403 })
      }
    } catch {
      return new Response('Not found', { status: 404 })
    }

    const extension = path.extname(realFilePath).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return new Response('Forbidden', { status: 403 })
    }

    try {
      // Chromium relies on byte ranges for seeking and for MP4 files whose
      // metadata lives at the end; returning the full file can leave playback stuck.
      const rangeHeader = request.headers.get('Range')
      if (rangeHeader) {
        const fileStats = await stat(realFilePath)
        const range = parseByteRange(rangeHeader, fileStats.size)
        if (!range) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileStats.size}` }
          })
        }

        const origin = request.headers.get('Origin')
        const headers = new Headers({
          'Accept-Ranges': 'bytes',
          'Content-Length': String(range.end - range.start + 1),
          'Content-Range': `bytes ${range.start}-${range.end}/${fileStats.size}`,
          'Content-Type': MEDIA_TYPES[extension] ?? 'application/octet-stream'
        })
        if (isAllowedOrigin(origin)) {
          headers.set('Access-Control-Allow-Origin', origin as string)
          headers.set('Vary', 'Origin')
        }

        const body =
          request.method === 'HEAD'
            ? null
            : (Readable.toWeb(
                createReadStream(realFilePath, { start: range.start, end: range.end })
              ) as ReadableStream<Uint8Array>)
        return new Response(body, { status: 206, headers })
      }

      const response = await net.fetch(pathToFileURL(realFilePath).toString())
      // Allow only the renderer origins that can legitimately consume this
      // resource. Do not expose local media to arbitrary web content.
      const origin = request.headers.get('Origin')
      const headers = new Headers(response.headers)
      headers.set('Accept-Ranges', 'bytes')
      if (isAllowedOrigin(origin)) {
        headers.set('Access-Control-Allow-Origin', origin as string)
        headers.set('Vary', 'Origin')
      }
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
