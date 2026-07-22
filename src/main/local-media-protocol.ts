import { protocol, net } from 'electron'
import * as path from 'path'
import { realpath } from 'fs/promises'
import { homedir } from 'os'
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
  path.join(homedir(), '.open-cowork', 'image')
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

function isWithinRoot(filePath: string, root: string): boolean {
  const relativePath = path.relative(root, filePath)
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath)
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
      const response = await net.fetch(pathToFileURL(realFilePath).toString())
      // Allow only the renderer origins that can legitimately consume this
      // resource. Do not expose local media to arbitrary web content.
      const origin = request.headers.get('Origin')
      const headers = new Headers(response.headers)
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
