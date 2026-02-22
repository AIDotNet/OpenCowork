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

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    themeVariables: {
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

async function svgToPngBlob(svg: string): Promise<Blob> {
  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(svgBlob)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('Failed to load Mermaid SVG image'))
      img.src = url
    })

    const width = Math.max(1, Math.ceil(image.width || 1))
    const height = Math.max(1, Math.ceil(image.height || 1))
    const canvas = document.createElement('canvas')
    canvas.width = width * 2
    canvas.height = height * 2

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas context is unavailable')
    ctx.scale(2, 2)
    ctx.drawImage(image, 0, 0, width, height)

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Failed to convert Mermaid SVG to PNG'))
      }, 'image/png')
    })

    return pngBlob
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function copyMermaidToClipboard(svg: string): Promise<'image' | 'text'> {
  if (!svg.trim()) throw new Error('No Mermaid SVG content available')
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable')

  const ClipboardItemCtor = globalThis.ClipboardItem
  if (!ClipboardItemCtor || !navigator.clipboard.write) {
    await navigator.clipboard.writeText(svg)
    return 'text'
  }

  try {
    const pngBlob = await svgToPngBlob(svg)
    await navigator.clipboard.write([new ClipboardItemCtor({ 'image/png': pngBlob })])
    return 'image'
  } catch {
    try {
      const svgBlob = new Blob([svg], { type: 'image/svg+xml' })
      await navigator.clipboard.write([new ClipboardItemCtor({ 'image/svg+xml': svgBlob })])
      return 'image'
    } catch {
      await navigator.clipboard.writeText(svg)
      return 'text'
    }
  }
}
