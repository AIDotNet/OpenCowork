import { useEffect, useState } from 'react'

/** Load an image source into an HTMLImageElement (for measuring / editing). */
export function useNodeImage(src: string | undefined | null): HTMLImageElement | undefined {
  const [image, setImage] = useState<HTMLImageElement | undefined>(undefined)

  useEffect(() => {
    if (!src) {
      setImage(undefined)
      return
    }
    let cancelled = false
    const el = new window.Image()
    // oc-media:// sources are cross-origin; request them with CORS so canvases
    // drawn from this image (crop/mask/outpaint) are not tainted.
    el.crossOrigin = 'anonymous'
    el.onload = (): void => {
      if (!cancelled) setImage(el)
    }
    el.onerror = (): void => {
      if (!cancelled) setImage(undefined)
    }
    el.src = src
    return () => {
      cancelled = true
      el.onload = null
      el.onerror = null
    }
  }, [src])

  return image
}
