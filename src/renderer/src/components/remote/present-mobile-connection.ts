export type MobileDeviceKind = 'android' | 'ios' | 'ipad' | 'harmony' | 'desktop' | 'unknown'

export interface PresentedMobileDevice {
  kind: MobileDeviceKind
  title: string
  titleKey: 'devicePhone' | 'deviceDesktop' | null
  detail: string | null
  ipAddress: string
}

const FRIENDLY_MODEL =
  /^(Pixel|Nexus|Galaxy|SM-|GT-|Redmi|Mi |MI |HUAWEI|HONOR|OPPO|vivo|OnePlus|iPhone|iPad|Moto|Nokia|Sony|ASUS|Nothing)/i

function isFriendlyModel(model: string): boolean {
  const trimmed = model.trim()
  if (!trimmed || trimmed.length > 32) return false
  if (FRIENDLY_MODEL.test(trimmed) || /\s/.test(trimmed)) return true
  if (/^Build\//i.test(trimmed)) return false
  if (/^[A-Z0-9._-]{5,}$/.test(trimmed) && /\d/.test(trimmed)) return false
  return true
}

export function presentIpAddress(ip: string): string {
  const trimmed = ip.trim()
  const mapped = trimmed.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  return mapped?.[1] ?? trimmed
}

function androidVersion(ua: string): string | null {
  return ua.match(/Android\s+([\d.]+)/i)?.[1] ?? null
}

function iosVersion(ua: string): string | null {
  const raw = ua.match(/(?:CPU iPhone OS|CPU OS|iPhone OS)\s+([\d_]+)/i)?.[1]
  return raw ? raw.replace(/_/g, '.') : null
}

function harmonyVersion(ua: string): string | null {
  return ua.match(/(?:HarmonyOS|OpenHarmony)\s*([\d.]+)?/i)?.[1] ?? null
}

function androidModel(ua: string): string | null {
  const match = ua.match(
    /Android\s+[\d.]+;\s*(?:[a-z]{2}(?:-[A-Z]{2})?;\s*)?([^;)]+?)(?:\s+Build\/|;|\))/i
  )
  const model = match?.[1]?.trim()
  if (!model || /^(Linux|U|wv)$/i.test(model)) return null
  return isFriendlyModel(model) ? model : null
}

export function presentMobileDevice(userAgent: string, ipAddress: string): PresentedMobileDevice {
  const ua = userAgent.trim()
  const ip = presentIpAddress(ipAddress)

  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua))) {
    const version = iosVersion(ua)
    return {
      kind: 'ipad',
      title: 'iPad',
      titleKey: null,
      detail: version ? `iPadOS ${version}` : null,
      ipAddress: ip
    }
  }

  if (/iPhone/i.test(ua)) {
    const version = iosVersion(ua)
    return {
      kind: 'ios',
      title: 'iPhone',
      titleKey: null,
      detail: version ? `iOS ${version}` : null,
      ipAddress: ip
    }
  }

  if (/HarmonyOS|OpenHarmony/i.test(ua)) {
    const version = harmonyVersion(ua)
    const model = androidModel(ua)
    return {
      kind: 'harmony',
      title: model ?? (version ? `HarmonyOS ${version}` : 'HarmonyOS'),
      titleKey: null,
      detail: model && version ? `HarmonyOS ${version}` : null,
      ipAddress: ip
    }
  }

  if (/Android/i.test(ua)) {
    const version = androidVersion(ua)
    const model = androidModel(ua)
    const os = version ? `Android ${version}` : 'Android'
    return {
      kind: 'android',
      title: model ?? os,
      titleKey: null,
      detail: model ? os : null,
      ipAddress: ip
    }
  }

  if (/Windows|Macintosh|Mac OS X|Linux|CrOS/i.test(ua) && !/Mobile/i.test(ua)) {
    return {
      kind: 'desktop',
      title: 'Desktop',
      titleKey: 'deviceDesktop',
      detail: null,
      ipAddress: ip
    }
  }

  return {
    kind: 'unknown',
    title: 'Phone',
    titleKey: 'devicePhone',
    detail: null,
    ipAddress: ip
  }
}
