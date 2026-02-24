import { useEffect, useState } from 'react'
import mermaid from 'mermaid'

function readCssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

let colorProbe: HTMLSpanElement | null = null

function getColorProbe(): HTMLSpanElement | null {
  if (typeof document === 'undefined' || !document.body) return null
  if (colorProbe && document.body.contains(colorProbe)) return colorProbe

  const probe = document.createElement('span')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.position = 'fixed'
  probe.style.left = '-9999px'
  probe.style.top = '-9999px'
  probe.style.opacity = '0'
  probe.style.pointerEvents = 'none'
  document.body.appendChild(probe)
  colorProbe = probe
  return colorProbe
}

function normalizeColor(raw: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const probe = getColorProbe()
  if (!probe) return fallback

  probe.style.color = fallback
  if (raw) probe.style.color = raw
  const computed = window.getComputedStyle(probe).color.trim()
  if (!computed) return fallback

  // Mermaid does not support modern color syntaxes like oklch/oklab/lab/lch.
  // Force fallback to rgb-compatible color values when those formats appear.
  if (/(^|\b)(oklch|oklab|lch|lab)\s*\(/i.test(computed)) return fallback
  return computed
}

function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

export function applyMermaidTheme(): void {
  const { vars } = buildThemeVars()
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    themeVariables: vars
  })
}

export function useMermaidThemeVersion(): number {
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          setVersion((v) => v + 1)
          break
        }
      }
    })
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return version
}

/** Build the shared themeVariables object used by both preview and export configs. */
function buildThemeVars(): {
  dark: boolean
  background: string
  foreground: string
  vars: Record<string, unknown>
} {
  const dark = isDarkTheme()
  const background = normalizeColor(
    readCssVar('--background', dark ? '#0f0f0f' : '#ffffff'),
    dark ? 'rgb(15, 15, 15)' : 'rgb(255, 255, 255)'
  )
  const foreground = normalizeColor(
    readCssVar('--foreground', dark ? '#f5f5f5' : '#111111'),
    dark ? 'rgb(245, 245, 245)' : 'rgb(17, 17, 17)'
  )
  const card = normalizeColor(
    readCssVar('--card', dark ? '#171717' : '#ffffff'),
    dark ? 'rgb(23, 23, 23)' : 'rgb(255, 255, 255)'
  )
  const muted = normalizeColor(
    readCssVar('--muted', dark ? '#262626' : '#f4f4f5'),
    dark ? 'rgb(38, 38, 38)' : 'rgb(244, 244, 245)'
  )
  const mutedForeground = normalizeColor(
    readCssVar('--muted-foreground', dark ? '#a3a3a3' : '#71717a'),
    dark ? 'rgb(163, 163, 163)' : 'rgb(113, 113, 122)'
  )
  const border = normalizeColor(
    readCssVar('--border', dark ? '#2a2a2a' : '#e4e4e7'),
    dark ? 'rgb(42, 42, 42)' : 'rgb(228, 228, 231)'
  )
  return {
    dark,
    background,
    foreground,
    vars: {
      darkMode: dark,
      background: 'transparent',
      fontFamily:
        'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
      textColor: foreground,
      lineColor: border,
      primaryColor: muted,
      primaryTextColor: foreground,
      primaryBorderColor: border,
      secondaryColor: card,
      secondaryTextColor: foreground,
      secondaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: foreground,
      tertiaryBorderColor: border,
      mainBkg: muted,
      secondBkg: card,
      tertiaryBkg: background,
      nodeBorder: border,
      clusterBkg: card,
      clusterBorder: border,
      edgeLabelBackground: background,
      actorBkg: muted,
      actorBorder: border,
      actorTextColor: foreground,
      labelBoxBkgColor: background,
      labelTextColor: foreground,
      relationColor: mutedForeground,
      signalColor: foreground,
      signalTextColor: foreground
    }
  }
}

/** Extract text lines from HTML content inside a foreignObject.
 *  Handles <br>, <br/>, block elements, and nested inline elements. */
function extractTextLines(fo: Element): string[] {
  // Build a temporary HTML container to properly parse the HTML content.
  // fo.innerHTML may not work reliably in XML-parsed documents, so use
  // the serialized inner content instead.
  const serializer = new XMLSerializer()
  let html = ''
  for (let i = 0; i < fo.childNodes.length; i++) {
    html += serializer.serializeToString(fo.childNodes[i])
  }
  if (!html.trim()) return []

  // Replace <br> variants with newline markers before extracting text
  html = html.replace(/<br\s*\/?>/gi, '\n')

  const tempDiv = document.createElement('div')
  tempDiv.innerHTML = html
  return (tempDiv.textContent || '').split(/\n/).map((l) => l.trim()).filter(Boolean)
}

/** Prepare an SVG string for Image-element loading:
 *  - Add xmlns attributes (required for standalone SVG)
 *  - Strip <foreignObject> (Image elements cannot render them) and replace with <text>
 *  - Ensure explicit width/height
 *  Returns the cleaned SVG string and its dimensions.
 *
 *  IMPORTANT: We parse as 'text/html' (not 'image/svg+xml') because the SVG
 *  may contain HTML content inside <foreignObject> that is not valid XML
 *  (e.g. unclosed <br>, unnamespaced HTML tags). Strict XML parsing would
 *  produce a parse error and truncate the document. The HTML parser's SVG
 *  integration point correctly handles SVG elements with proper casing. */
function prepareSvgForImageLoad(rawSvg: string, foreground: string): { svg: string; width: number; height: number } {
  const parser = new DOMParser()
  // Parse as HTML to avoid XML parse errors from HTML content in foreignObject
  const doc = parser.parseFromString(rawSvg, 'text/html')
  const svgEl = doc.querySelector('svg')
  if (!svgEl) throw new Error('No SVG element in mermaid output')

  // Standalone SVGs loaded into Image MUST have xmlns
  svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svgEl.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')

  // Strip <foreignObject> and replace with <text> + <tspan> for each line
  const foreignObjects = svgEl.querySelectorAll('foreignObject')
  for (const fo of foreignObjects) {
    const lines = extractTextLines(fo)

    const fx = parseFloat(fo.getAttribute('x') || '0')
    const fy = parseFloat(fo.getAttribute('y') || '0')
    const fw = parseFloat(fo.getAttribute('width') || '100')
    const fh = parseFloat(fo.getAttribute('height') || '20')
    const cx = fx + fw / 2
    const cy = fy + fh / 2

    if (lines.length > 0) {
      const textEl = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      textEl.setAttribute('x', String(cx))
      textEl.setAttribute('text-anchor', 'middle')
      textEl.setAttribute('dominant-baseline', 'central')
      textEl.setAttribute('font-size', '14')
      textEl.setAttribute('fill', foreground)

      if (lines.length === 1) {
        textEl.setAttribute('y', String(cy))
        textEl.textContent = lines[0]
      } else {
        // Multiple lines: stack tspans vertically centered
        const lineHeight = 18
        const totalHeight = lines.length * lineHeight
        const startY = cy - totalHeight / 2 + lineHeight / 2
        for (let i = 0; i < lines.length; i++) {
          const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan')
          tspan.setAttribute('x', String(cx))
          tspan.setAttribute('y', String(startY + i * lineHeight))
          tspan.textContent = lines[i]
          textEl.appendChild(tspan)
        }
      }
      fo.parentNode?.replaceChild(textEl, fo)
    } else {
      fo.parentNode?.removeChild(fo)
    }
  }

  // Parse dimensions
  let width = parseFloat(svgEl.getAttribute('width') || '')
  let height = parseFloat(svgEl.getAttribute('height') || '')
  if (!(width > 1 && height > 1)) {
    const viewBox = svgEl.getAttribute('viewBox')
    if (viewBox) {
      const parts = viewBox.split(/[\s,]+/).map(Number)
      if (parts.length === 4 && parts[2] > 1 && parts[3] > 1) {
        width = parts[2]
        height = parts[3]
      }
    }
  }
  width = Math.max(1, Math.ceil(width || 300))
  height = Math.max(1, Math.ceil(height || 150))

  svgEl.setAttribute('width', String(width))
  svgEl.setAttribute('height', String(height))

  const serializer = new XMLSerializer()
  return { svg: serializer.serializeToString(svgEl), width, height }
}

/** Try re-rendering mermaid source with htmlLabels disabled.
 *  Returns null if the re-render fails (e.g. source uses HTML markup in labels). */
async function tryRenderWithoutHtmlLabels(source: string): Promise<{ svg: string; width: number; height: number } | null> {
  const { foreground, vars } = buildThemeVars()

  const container = document.createElement('div')
  container.style.position = 'fixed'
  container.style.left = '-9999px'
  container.style.top = '-9999px'
  container.style.opacity = '0'
  container.style.pointerEvents = 'none'
  document.body.appendChild(container)

  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      suppressErrorRendering: true,
      theme: 'base',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      themeVariables: vars
    })

    const result = await mermaid.render(`mermaid-export-${Date.now()}`, source.trim(), container)
    return prepareSvgForImageLoad(result.svg, foreground)
  } catch {
    return null
  } finally {
    document.body.removeChild(container)
    applyMermaidTheme()
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunks: string[] = []
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)))
  }
  return btoa(chunks.join(''))
}

async function svgToPngBlob(svgString: string, width: number, height: number): Promise<Blob> {
  // Use Blob URL — more reliable than data URL for large SVGs and avoids btoa encoding issues
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(svgBlob)

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = (_e) => reject(new Error('Failed to load SVG into Image element'))
      img.src = url
    })

    const scale = Math.max(window.devicePixelRatio || 2, 2)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas context is unavailable')

    // Fill with theme background color to avoid transparent PNG
    const dark = isDarkTheme()
    ctx.fillStyle = dark ? '#0f0f0f' : '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.scale(scale, scale)
    ctx.drawImage(image, 0, 0, width, height)

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Failed to convert canvas to PNG'))
      }, 'image/png')
    })

    return pngBlob
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function copyMermaidToClipboard(source: string, renderedSvg?: string): Promise<'image' | 'text'> {
  if (!source.trim()) throw new Error('No Mermaid content available')

  const { foreground } = buildThemeVars()

  try {
    // Strategy 1: re-render with htmlLabels:false (clean SVG without foreignObject)
    let exported = await tryRenderWithoutHtmlLabels(source)

    // Strategy 2: if re-render failed (e.g. HTML labels in source), use the
    // already-rendered SVG and strip foreignObject manually
    if (!exported && renderedSvg) {
      exported = prepareSvgForImageLoad(renderedSvg, foreground)
    }

    if (!exported) throw new Error('Failed to produce exportable SVG')

    const pngBlob = await svgToPngBlob(exported.svg, exported.width, exported.height)
    const buffer = await pngBlob.arrayBuffer()
    const base64 = arrayBufferToBase64(buffer)

    // Use Electron native clipboard via IPC for reliable image writing
    const { ipcClient } = await import('@renderer/lib/ipc/ipc-client')
    const { IPC } = await import('@renderer/lib/ipc/channels')
    const result = (await ipcClient.invoke(IPC.CLIPBOARD_WRITE_IMAGE, { data: base64 })) as {
      success?: boolean
      error?: string
    }
    if (result.success) return 'image'
    console.warn('[Mermaid] IPC clipboard write failed:', result.error)
  } catch (err) {
    console.warn('[Mermaid] PNG clipboard write failed:', err)
  }

  // Fallback to text
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(source)
    return 'text'
  }
  throw new Error('Clipboard API is unavailable')
}
