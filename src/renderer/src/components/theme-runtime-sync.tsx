import { useEffect } from 'react'
import { useTheme } from 'next-themes'
import { applyThemePresetCssVars, resolveAppThemeMode } from '@renderer/lib/theme-presets'
import { useSettingsStore } from '@renderer/stores/settings-store'

export function ThemeRuntimeSync(): null {
  const theme = useSettingsStore((state) => state.theme)
  const backgroundColor = useSettingsStore((state) => state.backgroundColor)
  const fontFamily = useSettingsStore((state) => state.fontFamily)
  const fontSize = useSettingsStore((state) => state.fontSize)
  const animationsEnabled = useSettingsStore((state) => state.animationsEnabled)
  const themePreset = useSettingsStore((state) => state.themePreset)
  const { theme: activeTheme, resolvedTheme, setTheme } = useTheme()

  useEffect(() => {
    if (theme !== activeTheme) {
      setTheme(theme)
    }
  }, [activeTheme, setTheme, theme])

  useEffect(() => {
    const root = document.documentElement

    applyThemePresetCssVars(root, themePreset, resolveAppThemeMode(resolvedTheme))
    root.dataset.themePreset = themePreset

    if (backgroundColor && backgroundColor.trim()) {
      root.style.setProperty('--app-background', backgroundColor.trim())
    } else {
      root.style.removeProperty('--app-background')
    }

    if (fontFamily && fontFamily.trim()) {
      root.style.setProperty('--app-font-family', fontFamily.trim())
    } else {
      root.style.removeProperty('--app-font-family')
    }

    if (typeof fontSize === 'number' && Number.isFinite(fontSize)) {
      root.style.setProperty('--app-font-size', `${fontSize}px`)
    } else {
      root.style.removeProperty('--app-font-size')
    }

    root.dataset.animations = animationsEnabled ? 'enabled' : 'disabled'
  }, [animationsEnabled, backgroundColor, fontFamily, fontSize, resolvedTheme, themePreset])

  return null
}
