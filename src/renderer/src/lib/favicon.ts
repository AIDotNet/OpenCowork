export function getFaviconUrl(value: string): string | null {
  try {
    return new URL('/favicon.ico', value).toString()
  } catch {
    return null
  }
}
