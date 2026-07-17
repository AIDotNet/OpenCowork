import { protocol, net } from 'electron'
import * as path from 'path'
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
    if (!ALLOWED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      return new Response('Forbidden', { status: 403 })
    }

    try {
      const response = await net.fetch(pathToFileURL(filePath).toString())
      // Allow <video crossorigin="anonymous"> frames to be drawn onto a canvas
      // (poster capture) without tainting it.
      const headers = new Headers(response.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
