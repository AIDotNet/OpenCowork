import htmlToImageScriptUrl from 'html-to-image/dist/html-to-image.js?url'

interface HtmlToImageOptions {
  backgroundColor?: string
  pixelRatio?: number
  width?: number
  height?: number
  canvasWidth?: number
  canvasHeight?: number
  fontEmbedCSS?: string
  skipAutoScale?: boolean
  style?: Partial<CSSStyleDeclaration>
}

interface HtmlToImageApi {
  toPng(node: HTMLElement, options?: HtmlToImageOptions): Promise<string>
  getFontEmbedCSS(node: HTMLElement, options?: HtmlToImageOptions): Promise<string>
}

type HtmlToImageWindow = Window & {
  htmlToImage?: HtmlToImageApi
}

let htmlToImagePromise: Promise<HtmlToImageApi> | null = null

function getHtmlToImageApi(): HtmlToImageApi | null {
  const api = (window as HtmlToImageWindow).htmlToImage
  return typeof api?.toPng === 'function' && typeof api.getFontEmbedCSS === 'function' ? api : null
}

export function loadHtmlToImage(): Promise<HtmlToImageApi> {
  const api = getHtmlToImageApi()
  if (api) return Promise.resolve(api)
  if (htmlToImagePromise) return htmlToImagePromise

  htmlToImagePromise = new Promise<HtmlToImageApi>((resolve, reject) => {
    document.querySelector<HTMLScriptElement>('script[data-html-to-image-loader]')?.remove()

    const script = document.createElement('script')
    script.setAttribute('data-html-to-image-loader', '')
    script.async = true
    script.src = htmlToImageScriptUrl
    script.onload = () => {
      const loadedApi = getHtmlToImageApi()
      if (loadedApi) {
        resolve(loadedApi)
        return
      }
      reject(new Error('html-to-image loaded without exposing its browser API'))
    }
    script.onerror = () => reject(new Error('Failed to load html-to-image browser bundle'))

    document.head.appendChild(script)
  }).catch((error) => {
    htmlToImagePromise = null
    throw error
  })

  return htmlToImagePromise
}
