import type { ITheme } from '@xterm/xterm'

export type AppThemeMode = 'light' | 'dark'
export type AppThemePreset = 'studio' | 'graphite' | 'ocean' | 'forest' | 'dawn'
export type SshTerminalThemePreset = AppThemePreset

type ThemeCssVars = Record<`--${string}`, string>

type ThemePreviewPalette = {
  rail: string
  canvas: string
  card: string
  accent: string
  accentSoft: string
  text: string
}

export type SshChromePalette = {
  libraryFrameStart: string
  libraryFrameEnd: string
  libraryBorder: string
  libraryText: string
  connectFrame: string
  connectBorder: string
  connectText: string
  terminalFrame: string
  terminalBorder: string
  terminalText: string
  canvas: string
  canvasSubtle: string
  terminalCanvas: string
  panel: string
  panelStrong: string
  panelBorder: string
  surface: string
  surfaceStrong: string
  text: string
  muted: string
  accent: string
  accentSoft: string
  accentContrast: string
  success: string
  successSoft: string
  warning: string
  warningSoft: string
  danger: string
  dangerSoft: string
  badge: string
  libraryPill: string
  libraryPillActive: string
  libraryPillText: string
  libraryPillActiveText: string
  connectPill: string
  connectPillActive: string
  connectPillText: string
  connectPillActiveText: string
  terminalPill: string
  terminalPillActive: string
  terminalPillText: string
  terminalPillActiveText: string
}

export type ThemePresetDefinition = {
  id: AppThemePreset
  labelKey: string
  descriptionKey: string
  swatches: [string, string, string]
  preview: Record<AppThemeMode, ThemePreviewPalette>
  cssVars: Record<AppThemeMode, ThemeCssVars>
  terminal: Record<AppThemeMode, ITheme>
  ssh: Record<AppThemeMode, SshChromePalette>
}

export const DEFAULT_APP_THEME_PRESET: AppThemePreset = 'studio'
export const DEFAULT_SSH_TERMINAL_THEME_PRESET: SshTerminalThemePreset = 'graphite'

function createTerminalTheme(colors: {
  background: string
  foreground: string
  selectionBackground: string
  cursor?: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}): ITheme {
  return {
    background: colors.background,
    foreground: colors.foreground,
    cursor: colors.cursor ?? colors.foreground,
    cursorAccent: colors.background,
    selectionBackground: colors.selectionBackground,
    black: colors.black,
    red: colors.red,
    green: colors.green,
    yellow: colors.yellow,
    blue: colors.blue,
    magenta: colors.magenta,
    cyan: colors.cyan,
    white: colors.white,
    brightBlack: colors.brightBlack,
    brightRed: colors.brightRed,
    brightGreen: colors.brightGreen,
    brightYellow: colors.brightYellow,
    brightBlue: colors.brightBlue,
    brightMagenta: colors.brightMagenta,
    brightCyan: colors.brightCyan,
    brightWhite: colors.brightWhite
  }
}

const PRESET_DEFINITIONS: Record<AppThemePreset, ThemePresetDefinition> = {
  studio: {
    id: 'studio',
    labelKey: 'general.themePreset.presets.studio.label',
    descriptionKey: 'general.themePreset.presets.studio.desc',
    swatches: ['#3558e8', '#7aa7ff', '#f08f61'],
    preview: {
      light: {
        rail: '#304064',
        canvas: '#eef2f6',
        card: '#ffffff',
        accent: '#3558e8',
        accentSoft: '#dfe8ff',
        text: '#202b41'
      },
      dark: {
        rail: '#111725',
        canvas: '#14192d',
        card: '#1a2137',
        accent: '#79a6ff',
        accentSoft: '#203661',
        text: '#f4f7ff'
      }
    },
    cssVars: {
      light: {
        '--background': '#f4f7fb',
        '--foreground': '#172033',
        '--card': '#ffffff',
        '--card-foreground': '#172033',
        '--popover': '#ffffff',
        '--popover-foreground': '#172033',
        '--primary': '#3558e8',
        '--primary-foreground': '#f8fbff',
        '--secondary': '#e9eef7',
        '--secondary-foreground': '#2a3750',
        '--muted': '#eef2f8',
        '--muted-foreground': '#6b7892',
        '--accent': '#e4ebff',
        '--accent-foreground': '#22315a',
        '--destructive': '#d65353',
        '--destructive-foreground': '#ffffff',
        '--border': '#d6dfec',
        '--input': '#d6dfec',
        '--ring': '#6f84ff',
        '--chart-1': '#3558e8',
        '--chart-2': '#00a3bf',
        '--chart-3': '#f08f61',
        '--chart-4': '#56ae74',
        '--chart-5': '#d7a53f',
        '--sidebar': '#f8fbff',
        '--sidebar-foreground': '#172033',
        '--sidebar-primary': '#3558e8',
        '--sidebar-primary-foreground': '#f8fbff',
        '--sidebar-accent': '#ebf1ff',
        '--sidebar-accent-foreground': '#20305b',
        '--sidebar-border': '#d6dfec',
        '--sidebar-ring': '#6f84ff'
      },
      dark: {
        '--background': '#101726',
        '--foreground': '#f4f7ff',
        '--card': '#171e2f',
        '--card-foreground': '#f4f7ff',
        '--popover': '#171f30',
        '--popover-foreground': '#f4f7ff',
        '--primary': '#79a6ff',
        '--primary-foreground': '#0b1220',
        '--secondary': '#1d2638',
        '--secondary-foreground': '#edf2ff',
        '--muted': '#182031',
        '--muted-foreground': '#92a0bd',
        '--accent': '#1f2b44',
        '--accent-foreground': '#f5f7ff',
        '--destructive': '#ff7f8c',
        '--destructive-foreground': '#2a1116',
        '--border': '#2a344a',
        '--input': '#2a344a',
        '--ring': '#7aa7ff',
        '--chart-1': '#79a6ff',
        '--chart-2': '#67d6f3',
        '--chart-3': '#f2a272',
        '--chart-4': '#69cf8e',
        '--chart-5': '#ebc15e',
        '--sidebar': '#131a2a',
        '--sidebar-foreground': '#f4f7ff',
        '--sidebar-primary': '#79a6ff',
        '--sidebar-primary-foreground': '#0b1220',
        '--sidebar-accent': '#1b2539',
        '--sidebar-accent-foreground': '#f4f7ff',
        '--sidebar-border': '#283249',
        '--sidebar-ring': '#7aa7ff'
      }
    },
    terminal: {
      light: createTerminalTheme({
        background: '#f7faff',
        foreground: '#1d2740',
        selectionBackground: 'rgba(53, 88, 232, 0.18)',
        cursor: '#3558e8',
        black: '#1f2740',
        red: '#cc4e62',
        green: '#1f8c57',
        yellow: '#c98517',
        blue: '#3558e8',
        magenta: '#8d63d2',
        cyan: '#0287a0',
        white: '#dfe7f7',
        brightBlack: '#7f8aa5',
        brightRed: '#e26d81',
        brightGreen: '#31a36c',
        brightYellow: '#dda13a',
        brightBlue: '#5877f0',
        brightMagenta: '#a989df',
        brightCyan: '#26a8c0',
        brightWhite: '#ffffff'
      }),
      dark: createTerminalTheme({
        background: '#151b30',
        foreground: '#d7e1ff',
        selectionBackground: 'rgba(121, 157, 255, 0.22)',
        cursor: '#dbfff0',
        black: '#151b30',
        red: '#ff7a93',
        green: '#35e0a1',
        yellow: '#f0c56e',
        blue: '#75a7ff',
        magenta: '#d4a8ff',
        cyan: '#7be4f6',
        white: '#d7e1ff',
        brightBlack: '#7282a1',
        brightRed: '#ff9bb0',
        brightGreen: '#5ff1ba',
        brightYellow: '#ffd98d',
        brightBlue: '#93bcff',
        brightMagenta: '#e1c0ff',
        brightCyan: '#9df0ff',
        brightWhite: '#f4f7ff'
      })
    },
    ssh: {
      light: {
        libraryFrameStart: '#304064',
        libraryFrameEnd: '#4a4568',
        libraryBorder: 'rgba(255,255,255,0.08)',
        libraryText: '#eef4ff',
        connectFrame: '#f0f3f6',
        connectBorder: '#d8dee6',
        connectText: '#5b6678',
        terminalFrame: '#191f35',
        terminalBorder: 'rgba(255,255,255,0.08)',
        terminalText: '#dbe6ff',
        canvas: '#eef2f6',
        canvasSubtle: '#f6f8fb',
        terminalCanvas: '#14192d',
        panel: '#161d33',
        panelStrong: '#11172a',
        panelBorder: 'rgba(255,255,255,0.08)',
        surface: '#ffffff',
        surfaceStrong: '#f5f8fb',
        text: '#22304a',
        muted: '#8291a6',
        accent: '#2f8cf3',
        accentSoft: '#deebff',
        accentContrast: '#ffffff',
        success: '#1f8c57',
        successSoft: '#ebf8ef',
        warning: '#c78413',
        warningSoft: '#fff4dc',
        danger: '#d25555',
        dangerSoft: '#fff0f0',
        badge: '#2f8cf3',
        libraryPill: 'rgba(255,255,255,0.1)',
        libraryPillActive: 'rgba(255,255,255,0.16)',
        libraryPillText: '#d3dbef',
        libraryPillActiveText: '#ffffff',
        connectPill: '#dfe5ea',
        connectPillActive: '#cfd5dd',
        connectPillText: '#6a7688',
        connectPillActiveText: '#2f3851',
        terminalPill: 'rgba(255,255,255,0.06)',
        terminalPillActive: '#173d34',
        terminalPillText: '#b7c4e5',
        terminalPillActiveText: '#4ef0a8'
      },
      dark: {
        libraryFrameStart: '#18213a',
        libraryFrameEnd: '#252340',
        libraryBorder: 'rgba(255,255,255,0.1)',
        libraryText: '#eef4ff',
        connectFrame: '#121927',
        connectBorder: '#243046',
        connectText: '#9daccc',
        terminalFrame: '#111828',
        terminalBorder: 'rgba(255,255,255,0.08)',
        terminalText: '#e7eeff',
        canvas: '#0f1524',
        canvasSubtle: '#12192a',
        terminalCanvas: '#0b1220',
        panel: '#11182a',
        panelStrong: '#0c1322',
        panelBorder: 'rgba(255,255,255,0.08)',
        surface: '#171f31',
        surfaceStrong: '#1c2538',
        text: '#edf3ff',
        muted: '#97a5c4',
        accent: '#79a6ff',
        accentSoft: '#203763',
        accentContrast: '#0b1220',
        success: '#5de0ad',
        successSoft: '#14251f',
        warning: '#f0c56e',
        warningSoft: '#2a2314',
        danger: '#ff90a4',
        dangerSoft: '#281620',
        badge: '#79a6ff',
        libraryPill: 'rgba(255,255,255,0.08)',
        libraryPillActive: 'rgba(255,255,255,0.14)',
        libraryPillText: '#cdd7ef',
        libraryPillActiveText: '#ffffff',
        connectPill: '#182233',
        connectPillActive: '#23324a',
        connectPillText: '#9daccc',
        connectPillActiveText: '#f4f7ff',
        terminalPill: 'rgba(255,255,255,0.06)',
        terminalPillActive: '#1b3c39',
        terminalPillText: '#c6d2eb',
        terminalPillActiveText: '#7cf0b6'
      }
    }
  },
  graphite: {
    id: 'graphite',
    labelKey: 'general.themePreset.presets.graphite.label',
    descriptionKey: 'general.themePreset.presets.graphite.desc',
    swatches: ['#2a7b73', '#7fd4c9', '#7b8798'],
    preview: {
      light: {
        rail: '#3f4349',
        canvas: '#f3f4f5',
        card: '#ffffff',
        accent: '#2a7b73',
        accentSoft: '#dcecea',
        text: '#17191d'
      },
      dark: {
        rail: '#121417',
        canvas: '#171b1f',
        card: '#1d2227',
        accent: '#6bd1c2',
        accentSoft: '#193431',
        text: '#f4f6f5'
      }
    },
    cssVars: {
      light: {
        '--background': '#f3f4f5',
        '--foreground': '#17191d',
        '--card': '#ffffff',
        '--card-foreground': '#17191d',
        '--popover': '#ffffff',
        '--popover-foreground': '#17191d',
        '--primary': '#2a7b73',
        '--primary-foreground': '#f7fbfa',
        '--secondary': '#e8ecec',
        '--secondary-foreground': '#243133',
        '--muted': '#edf0f0',
        '--muted-foreground': '#667276',
        '--accent': '#e2ebea',
        '--accent-foreground': '#1c3131',
        '--destructive': '#c85656',
        '--destructive-foreground': '#ffffff',
        '--border': '#d5dbdc',
        '--input': '#d5dbdc',
        '--ring': '#68bfb2',
        '--chart-1': '#2a7b73',
        '--chart-2': '#4aa09a',
        '--chart-3': '#8894a4',
        '--chart-4': '#d2a66d',
        '--chart-5': '#8b6262',
        '--sidebar': '#f7f8f8',
        '--sidebar-foreground': '#17191d',
        '--sidebar-primary': '#2a7b73',
        '--sidebar-primary-foreground': '#f7fbfa',
        '--sidebar-accent': '#edf2f2',
        '--sidebar-accent-foreground': '#213536',
        '--sidebar-border': '#d5dbdc',
        '--sidebar-ring': '#68bfb2'
      },
      dark: {
        '--background': '#111316',
        '--foreground': '#f4f6f5',
        '--card': '#171b1f',
        '--card-foreground': '#f4f6f5',
        '--popover': '#181c21',
        '--popover-foreground': '#f4f6f5',
        '--primary': '#6bd1c2',
        '--primary-foreground': '#0c1415',
        '--secondary': '#1d2325',
        '--secondary-foreground': '#edf2f1',
        '--muted': '#181d20',
        '--muted-foreground': '#92a09e',
        '--accent': '#1b2424',
        '--accent-foreground': '#edf2f1',
        '--destructive': '#ff8888',
        '--destructive-foreground': '#241415',
        '--border': '#2a3131',
        '--input': '#2a3131',
        '--ring': '#7ad8cb',
        '--chart-1': '#6bd1c2',
        '--chart-2': '#8eb7ff',
        '--chart-3': '#9ba6b7',
        '--chart-4': '#d8b57a',
        '--chart-5': '#ff9f8d',
        '--sidebar': '#14181b',
        '--sidebar-foreground': '#f4f6f5',
        '--sidebar-primary': '#6bd1c2',
        '--sidebar-primary-foreground': '#0c1415',
        '--sidebar-accent': '#1b2022',
        '--sidebar-accent-foreground': '#f4f6f5',
        '--sidebar-border': '#293031',
        '--sidebar-ring': '#7ad8cb'
      }
    },
    terminal: {
      light: createTerminalTheme({
        background: '#f5f7f7',
        foreground: '#1b2124',
        selectionBackground: 'rgba(42, 123, 115, 0.18)',
        cursor: '#2a7b73',
        black: '#1b2124',
        red: '#c85656',
        green: '#1f8b76',
        yellow: '#b98a3d',
        blue: '#5678ad',
        magenta: '#7f6b9d',
        cyan: '#328d86',
        white: '#dfe6e6',
        brightBlack: '#768186',
        brightRed: '#d96b6b',
        brightGreen: '#36a691',
        brightYellow: '#caa253',
        brightBlue: '#6f90c6',
        brightMagenta: '#9580b3',
        brightCyan: '#4da9a2',
        brightWhite: '#ffffff'
      }),
      dark: createTerminalTheme({
        background: '#12171a',
        foreground: '#dfe7e6',
        selectionBackground: 'rgba(107, 209, 194, 0.2)',
        cursor: '#dfe7e6',
        black: '#12171a',
        red: '#ff8a8a',
        green: '#6bd1c2',
        yellow: '#e4c077',
        blue: '#93b1ff',
        magenta: '#beabd8',
        cyan: '#79dfd2',
        white: '#dfe7e6',
        brightBlack: '#7d8a8e',
        brightRed: '#ffadad',
        brightGreen: '#8be5d9',
        brightYellow: '#f2d596',
        brightBlue: '#adc5ff',
        brightMagenta: '#cebce4',
        brightCyan: '#9fece3',
        brightWhite: '#f6fbfa'
      })
    },
    ssh: {
      light: {
        libraryFrameStart: '#3f4349',
        libraryFrameEnd: '#59616a',
        libraryBorder: 'rgba(255,255,255,0.08)',
        libraryText: '#f7fbfa',
        connectFrame: '#eff2f2',
        connectBorder: '#d7dddd',
        connectText: '#5e6668',
        terminalFrame: '#1a2023',
        terminalBorder: 'rgba(255,255,255,0.08)',
        terminalText: '#dbe4e3',
        canvas: '#eff2f2',
        canvasSubtle: '#f6f8f8',
        terminalCanvas: '#12171a',
        panel: '#161d20',
        panelStrong: '#11171a',
        panelBorder: 'rgba(255,255,255,0.08)',
        surface: '#ffffff',
        surfaceStrong: '#f5f7f7',
        text: '#1f2529',
        muted: '#7b878d',
        accent: '#2a7b73',
        accentSoft: '#dcecea',
        accentContrast: '#ffffff',
        success: '#287a64',
        successSoft: '#e8f7f0',
        warning: '#b98a3d',
        warningSoft: '#fff5df',
        danger: '#c85656',
        dangerSoft: '#fff1f1',
        badge: '#2a7b73',
        libraryPill: 'rgba(255,255,255,0.1)',
        libraryPillActive: 'rgba(255,255,255,0.16)',
        libraryPillText: '#dbe4e3',
        libraryPillActiveText: '#ffffff',
        connectPill: '#e2e7e7',
        connectPillActive: '#d4dbdb',
        connectPillText: '#657072',
        connectPillActiveText: '#263133',
        terminalPill: 'rgba(255,255,255,0.06)',
        terminalPillActive: '#1f3936',
        terminalPillText: '#cbd7d6',
        terminalPillActiveText: '#8ce8db'
      },
      dark: {
        libraryFrameStart: '#171c20',
        libraryFrameEnd: '#23292e',
        libraryBorder: 'rgba(255,255,255,0.08)',
        libraryText: '#f5f8f7',
        connectFrame: '#111416',
        connectBorder: '#253033',
        connectText: '#9ba7aa',
        terminalFrame: '#111518',
        terminalBorder: 'rgba(255,255,255,0.08)',
        terminalText: '#edf5f4',
        canvas: '#0f1316',
        canvasSubtle: '#12171a',
        terminalCanvas: '#0f1417',
        panel: '#141a1d',
        panelStrong: '#0f1417',
        panelBorder: 'rgba(255,255,255,0.08)',
        surface: '#1a2125',
        surfaceStrong: '#20272c',
        text: '#edf5f4',
        muted: '#97a3a5',
        accent: '#6bd1c2',
        accentSoft: '#193431',
        accentContrast: '#0c1415',
        success: '#7be0c4',
        successSoft: '#12231f',
        warning: '#e4c077',
        warningSoft: '#292215',
        danger: '#ff9d9d',
        dangerSoft: '#2a1818',
        badge: '#6bd1c2',
        libraryPill: 'rgba(255,255,255,0.08)',
        libraryPillActive: 'rgba(255,255,255,0.14)',
        libraryPillText: '#d5dfde',
        libraryPillActiveText: '#ffffff',
        connectPill: '#182022',
        connectPillActive: '#233033',
        connectPillText: '#a1adaf',
        connectPillActiveText: '#f5f8f7',
        terminalPill: 'rgba(255,255,255,0.06)',
        terminalPillActive: '#1e3a36',
        terminalPillText: '#d0dddc',
        terminalPillActiveText: '#97efe2'
      }
    }
  },
  ocean: {
    id: 'ocean',
    labelKey: 'general.themePreset.presets.ocean.label',
    descriptionKey: 'general.themePreset.presets.ocean.desc',
    swatches: ['#0f8aa6', '#4cc9f0', '#8be3ff'],
    preview: {
      light: {
        rail: '#0f5162',
        canvas: '#eef7f8',
        card: '#ffffff',
        accent: '#0f8aa6',
        accentSoft: '#d7f0f6',
        text: '#13232a'
      },
      dark: {
        rail: '#081823',
        canvas: '#0d1f2b',
        card: '#132734',
        accent: '#4cc9f0',
        accentSoft: '#153b48',
        text: '#eefbff'
      }
    },
    cssVars: {
      light: {
        '--background': '#eef7f8',
        '--foreground': '#13232a',
        '--card': '#ffffff',
        '--card-foreground': '#13232a',
        '--popover': '#ffffff',
        '--popover-foreground': '#13232a',
        '--primary': '#0f8aa6',
        '--primary-foreground': '#f4fdff',
        '--secondary': '#dff0f4',
        '--secondary-foreground': '#1b3540',
        '--muted': '#e7f3f6',
        '--muted-foreground': '#5c7580',
        '--accent': '#d7f0f6',
        '--accent-foreground': '#123844',
        '--destructive': '#d65f58',
        '--destructive-foreground': '#ffffff',
        '--border': '#c9e1e7',
        '--input': '#c9e1e7',
        '--ring': '#4cbad8',
        '--chart-1': '#0f8aa6',
        '--chart-2': '#4cc9f0',
        '--chart-3': '#1380b9',
        '--chart-4': '#65b58d',
        '--chart-5': '#db9f51',
        '--sidebar': '#f5fbfc',
        '--sidebar-foreground': '#13232a',
        '--sidebar-primary': '#0f8aa6',
        '--sidebar-primary-foreground': '#f4fdff',
        '--sidebar-accent': '#e2f5f8',
        '--sidebar-accent-foreground': '#123844',
        '--sidebar-border': '#c9e1e7',
        '--sidebar-ring': '#4cbad8'
      },
      dark: {
        '--background': '#081823',
        '--foreground': '#eefbff',
        '--card': '#0f202b',
        '--card-foreground': '#eefbff',
        '--popover': '#10222d',
        '--popover-foreground': '#eefbff',
        '--primary': '#4cc9f0',
        '--primary-foreground': '#07202a',
        '--secondary': '#102733',
        '--secondary-foreground': '#eefbff',
        '--muted': '#0e2230',
        '--muted-foreground': '#8fb0bd',
        '--accent': '#123040',
        '--accent-foreground': '#eefbff',
        '--destructive': '#ff8d82',
        '--destructive-foreground': '#2d130f',
        '--border': '#1f3947',
        '--input': '#1f3947',
        '--ring': '#72d9ff',
        '--chart-1': '#4cc9f0',
        '--chart-2': '#8be3ff',
        '--chart-3': '#7aa8ff',
        '--chart-4': '#67d39a',
        '--chart-5': '#ffc87a',
        '--sidebar': '#0b1b25',
        '--sidebar-foreground': '#eefbff',
        '--sidebar-primary': '#4cc9f0',
        '--sidebar-primary-foreground': '#07202a',
        '--sidebar-accent': '#102631',
        '--sidebar-accent-foreground': '#eefbff',
        '--sidebar-border': '#1d3643',
        '--sidebar-ring': '#72d9ff'
      }
    },
    terminal: {
      light: createTerminalTheme({
        background: '#f4fdff',
        foreground: '#17303a',
        selectionBackground: 'rgba(15, 138, 166, 0.18)',
        cursor: '#0f8aa6',
        black: '#17303a',
        red: '#d66166',
        green: '#1fa87d',
        yellow: '#c99841',
        blue: '#147db2',
        magenta: '#5d7fd6',
        cyan: '#0f8aa6',
        white: '#dbeff4',
        brightBlack: '#6c8a95',
        brightRed: '#ea7a7a',
        brightGreen: '#36c49a',
        brightYellow: '#deae5d',
        brightBlue: '#329ad0',
        brightMagenta: '#7798eb',
        brightCyan: '#34afd2',
        brightWhite: '#ffffff'
      }),
      dark: createTerminalTheme({
        background: '#0b1a23',
        foreground: '#def7ff',
        selectionBackground: 'rgba(76, 201, 240, 0.18)',
        cursor: '#bdf3ff',
        black: '#0b1a23',
        red: '#ff8f90',
        green: '#57e1af',
        yellow: '#ffd279',
        blue: '#71c9ff',
        magenta: '#93b3ff',
        cyan: '#66e3ff',
        white: '#def7ff',
        brightBlack: '#6f92a2',
        brightRed: '#ffb1b2',
        brightGreen: '#80f0c7',
        brightYellow: '#ffe39d',
        brightBlue: '#93d7ff',
        brightMagenta: '#b1c6ff',
        brightCyan: '#8feeff',
        brightWhite: '#f3fdff'
      })
    },
    ssh: {
      light: {
        libraryFrameStart: '#0f5162',
        libraryFrameEnd: '#17667a',
        libraryBorder: 'rgba(255,255,255,0.08)',
        libraryText: '#eefcff',
        connectFrame: '#eef7f8',
        connectBorder: '#d2e3e7',
        connectText: '#5d747d',
        terminalFrame: '#0d2230',
        terminalBorder: 'rgba(255,255,255,0.08)',
        terminalText: '#ddf6ff',
        canvas: '#eef7f8',
        canvasSubtle: '#f6fbfc',
        terminalCanvas: '#0b1a23',
        panel: '#102431',
        panelStrong: '#0b1a23',
        panelBorder: 'rgba(255,255,255,0.08)',
        surface: '#ffffff',
        surfaceStrong: '#f4fbfc',
        text: '#18303a',
        muted: '#7c939c',
        accent: '#0f8aa6',
        accentSoft: '#d7f0f6',
        accentContrast: '#ffffff',
        success: '#1c996f',
        successSoft: '#e7f8f0',
        warning: '#cc9540',
        warningSoft: '#fff5e1',
        danger: '#d66166',
        dangerSoft: '#fff1f1',
        badge: '#0f8aa6',
        libraryPill: 'rgba(255,255,255,0.1)',
        libraryPillActive: 'rgba(255,255,255,0.16)',
        libraryPillText: '#d8eef3',
        libraryPillActiveText: '#ffffff',
        connectPill: '#dfecef',
        connectPillActive: '#cfdee2',
        connectPillText: '#60767d',
        connectPillActiveText: '#17313b',
        terminalPill: 'rgba(255,255,255,0.06)',
        terminalPillActive: '#15424b',
        terminalPillText: '#c7e2eb',
        terminalPillActiveText: '#84f0ff'
      },
      dark: {
        libraryFrameStart: '#08202d',
        libraryFrameEnd: '#0c3042',
        libraryBorder: 'rgba(255,255,255,0.08)',
        libraryText: '#eefbff',
        connectFrame: '#081823',
        connectBorder: '#183443',
        connectText: '#98b7c3',
        terminalFrame: '#08151d',
        terminalBorder: 'rgba(255,255,255,0.08)',
        terminalText: '#eefbff',
        canvas: '#081823',
        canvasSubtle: '#0b1b25',
        terminalCanvas: '#07141c',
        panel: '#0d202b',
        panelStrong: '#081823',
        panelBorder: 'rgba(255,255,255,0.08)',
        surface: '#102632',
        surfaceStrong: '#14303d',
        text: '#eefbff',
        muted: '#93b1bd',
        accent: '#4cc9f0',
        accentSoft: '#153b48',
        accentContrast: '#07202a',
        success: '#6ae1b6',
        successSoft: '#11241d',
        warning: '#ffd279',
        warningSoft: '#2a2213',
        danger: '#ff9fa2',
        dangerSoft: '#281618',
        badge: '#4cc9f0',
        libraryPill: 'rgba(255,255,255,0.08)',
        libraryPillActive: 'rgba(255,255,255,0.14)',
        libraryPillText: '#d4eff6',
        libraryPillActiveText: '#ffffff',
        connectPill: '#102531',
        connectPillActive: '#173646',
        connectPillText: '#9cb7c1',
        connectPillActiveText: '#eefbff',
        terminalPill: 'rgba(255,255,255,0.06)',
        terminalPillActive: '#15444d',
        terminalPillText: '#d3edf5',
        terminalPillActiveText: '#90f3ff'
      }
    }
  },
  forest: {
    id: 'forest',
    labelKey: 'general.themePreset.presets.forest.label',
    descriptionKey: 'general.themePreset.presets.forest.desc',
    swatches: ['#2f8b57', '#6fd39a', '#98e0a0'],
    preview: {
      light: {
        rail: '#244937',
        canvas: '#f4f8f4',
        card: '#ffffff',
        accent: '#2f8b57',
        accentSoft: '#e1f1e6',
        text: '#16221b'
      },
      dark: {
        rail: '#0d1913',
        canvas: '#121f18',
        card: '#17271f',
        accent: '#6fd39a',
        accentSoft: '#173b28',
        text: '#effbf3'
      }
    },
    cssVars: {
      light: {
        '--background': '#f4f8f4',
        '--foreground': '#16221b',
        '--card': '#ffffff',
        '--card-foreground': '#16221b',
        '--popover': '#ffffff',
        '--popover-foreground': '#16221b',
        '--primary': '#2f8b57',
        '--primary-foreground': '#f6fff8',
        '--secondary': '#e5efe7',
        '--secondary-foreground': '#22372a',
        '--muted': '#ebf3ec',
        '--muted-foreground': '#67796d',
        '--accent': '#e1f1e6',
        '--accent-foreground': '#1d3a28',
        '--destructive': '#c95e5e',
        '--destructive-foreground': '#ffffff',
        '--border': '#d6e3d8',
        '--input': '#d6e3d8',
        '--ring': '#59b87d',
        '--chart-1': '#2f8b57',
        '--chart-2': '#64b287',
        '--chart-3': '#96c36b',
        '--chart-4': '#dfb35c',
        '--chart-5': '#c77e5c',
        '--sidebar': '#f8fbf8',
        '--sidebar-foreground': '#16221b',
        '--sidebar-primary': '#2f8b57',
        '--sidebar-primary-foreground': '#f6fff8',
        '--sidebar-accent': '#edf5ef',
        '--sidebar-accent-foreground': '#1d3a28',
        '--sidebar-border': '#d6e3d8',
        '--sidebar-ring': '#59b87d'
      },
      dark: {
        '--background': '#0d1913',
        '--foreground': '#effbf3',
        '--card': '#131f18',
        '--card-foreground': '#effbf3',
        '--popover': '#15221a',
        '--popover-foreground': '#effbf3',
        '--primary': '#6fd39a',
        '--primary-foreground': '#0b1d13',
        '--secondary': '#17261d',
        '--secondary-foreground': '#effbf3',
        '--muted': '#132219',
        '--muted-foreground': '#93ae9b',
        '--accent': '#173126',
        '--accent-foreground': '#effbf3',
        '--destructive': '#ff9494',
        '--destructive-foreground': '#2b1515',
        '--border': '#244032',
        '--input': '#244032',
        '--ring': '#88e2af',
        '--chart-1': '#6fd39a',
        '--chart-2': '#98e0a0',
        '--chart-3': '#b9d665',
        '--chart-4': '#f0c275',
        '--chart-5': '#ff9d78',
        '--sidebar': '#101c15',
        '--sidebar-foreground': '#effbf3',
        '--sidebar-primary': '#6fd39a',
        '--sidebar-primary-foreground': '#0b1d13',
        '--sidebar-accent': '#15241b',
        '--sidebar-accent-foreground': '#effbf3',
        '--sidebar-border': '#223c2f',
        '--sidebar-ring': '#88e2af'
      }
    },
    terminal: {
      light: createTerminalTheme({
        background: '#f7fcf8',
        foreground: '#1c2a22',
        selectionBackground: 'rgba(47, 139, 87, 0.16)',
        cursor: '#2f8b57',
        black: '#1c2a22',
        red: '#c86464',
        green: '#2f8b57',
        yellow: '#bf963d',
        blue: '#508f70',
        magenta: '#758b65',
        cyan: '#1b9b84',
        white: '#dfefe4',
        brightBlack: '#74837a',
        brightRed: '#dc7c7c',
        brightGreen: '#48a56f',
        brightYellow: '#d3ab56',
        brightBlue: '#6ca98a',
        brightMagenta: '#8aa17a',
        brightCyan: '#39b29c',
        brightWhite: '#ffffff'
      }),
      dark: createTerminalTheme({
        background: '#0d1712',
        foreground: '#e1f5e6',
        selectionBackground: 'rgba(111, 211, 154, 0.18)',
        cursor: '#c3f6d6',
        black: '#0d1712',
        red: '#ff9d9d',
        green: '#6fd39a',
        yellow: '#ebc777',
        blue: '#8bd3ae',
        magenta: '#b8cc7a',
        cyan: '#73e3c9',
        white: '#e1f5e6',
        brightBlack: '#6d8976',
        brightRed: '#ffbdbd',
        brightGreen: '#92e3b4',
        brightYellow: '#f4d996',
        brightBlue: '#addfc0',
        brightMagenta: '#cddd9a',
        brightCyan: '#97efdb',
        brightWhite: '#f5fdf7'
      })
    },
    ssh: {
      light: {
        libraryFrameStart: '#244937',
        libraryFrameEnd: '#355744',
        libraryBorder: 'rgba(255,255,255,0.08)',
        libraryText: '#f5fff7',
        connectFrame: '#f2f7f2',
        connectBorder: '#d7e3d9',
        connectText: '#607368',
        terminalFrame: '#13231b',
        terminalBorder: 'rgba(255,255,255,0.08)',
        terminalText: '#e4f7eb',
        canvas: '#f2f7f2',
        canvasSubtle: '#f8fbf8',
        terminalCanvas: '#0d1712',
        panel: '#12231b',
        panelStrong: '#0d1712',
        panelBorder: 'rgba(255,255,255,0.08)',
        surface: '#ffffff',
        surfaceStrong: '#f5faf6',
        text: '#1d2a22',
        muted: '#7b8d82',
        accent: '#2f8b57',
        accentSoft: '#e1f1e6',
        accentContrast: '#ffffff',
        success: '#2f8b57',
        successSoft: '#e8f8ed',
        warning: '#bf963d',
        warningSoft: '#fff5e0',
        danger: '#c86464',
        dangerSoft: '#fff1f1',
        badge: '#2f8b57',
        libraryPill: 'rgba(255,255,255,0.1)',
        libraryPillActive: 'rgba(255,255,255,0.16)',
        libraryPillText: '#dcecdf',
        libraryPillActiveText: '#ffffff',
        connectPill: '#e3ebe5',
        connectPillActive: '#d5dfd7',
        connectPillText: '#63766a',
        connectPillActiveText: '#20332a',
        terminalPill: 'rgba(255,255,255,0.06)',
        terminalPillActive: '#1e402c',
        terminalPillText: '#d4e7da',
        terminalPillActiveText: '#9ef0bd'
      },
      dark: {
        libraryFrameStart: '#12231b',
        libraryFrameEnd: '#173227',
        libraryBorder: 'rgba(255,255,255,0.08)',
        libraryText: '#effcf3',
        connectFrame: '#0d1913',
        connectBorder: '#20392d',
        connectText: '#98af9e',
        terminalFrame: '#0d1712',
        terminalBorder: 'rgba(255,255,255,0.08)',
        terminalText: '#effcf3',
        canvas: '#0d1913',
        canvasSubtle: '#101c15',
        terminalCanvas: '#0b1410',
        panel: '#11201a',
        panelStrong: '#0d1913',
        panelBorder: 'rgba(255,255,255,0.08)',
        surface: '#15241c',
        surfaceStrong: '#193027',
        text: '#effcf3',
        muted: '#93aa99',
        accent: '#6fd39a',
        accentSoft: '#173b28',
        accentContrast: '#0b1d13',
        success: '#86e3ad',
        successSoft: '#11231b',
        warning: '#ebc777',
        warningSoft: '#2a2415',
        danger: '#ffaaaa',
        dangerSoft: '#291717',
        badge: '#6fd39a',
        libraryPill: 'rgba(255,255,255,0.08)',
        libraryPillActive: 'rgba(255,255,255,0.14)',
        libraryPillText: '#d7e8dc',
        libraryPillActiveText: '#ffffff',
        connectPill: '#16271e',
        connectPillActive: '#20372a',
        connectPillText: '#9eb5a4',
        connectPillActiveText: '#effcf3',
        terminalPill: 'rgba(255,255,255,0.06)',
        terminalPillActive: '#1f412e',
        terminalPillText: '#daeade',
        terminalPillActiveText: '#a9f3c5'
      }
    }
  },
  dawn: {
    id: 'dawn',
    labelKey: 'general.themePreset.presets.dawn.label',
    descriptionKey: 'general.themePreset.presets.dawn.desc',
    swatches: ['#ca6a33', '#ffb27d', '#ffd8a8'],
    preview: {
      light: {
        rail: '#6a402f',
        canvas: '#fbf6f2',
        card: '#ffffff',
        accent: '#ca6a33',
        accentSoft: '#f9e5da',
        text: '#2b1d19'
      },
      dark: {
        rail: '#22140e',
        canvas: '#2a1810',
        card: '#312016',
        accent: '#ffb27d',
        accentSoft: '#4b2c1f',
        text: '#fff4eb'
      }
    },
    cssVars: {
      light: {
        '--background': '#fbf6f2',
        '--foreground': '#2b1d19',
        '--card': '#ffffff',
        '--card-foreground': '#2b1d19',
        '--popover': '#ffffff',
        '--popover-foreground': '#2b1d19',
        '--primary': '#ca6a33',
        '--primary-foreground': '#fffaf7',
        '--secondary': '#f3e8df',
        '--secondary-foreground': '#473025',
        '--muted': '#f7eee7',
        '--muted-foreground': '#7f665c',
        '--accent': '#f9e5da',
        '--accent-foreground': '#5f3824',
        '--destructive': '#cc6258',
        '--destructive-foreground': '#ffffff',
        '--border': '#ead6cb',
        '--input': '#ead6cb',
        '--ring': '#e99568',
        '--chart-1': '#ca6a33',
        '--chart-2': '#ff9a63',
        '--chart-3': '#d79c52',
        '--chart-4': '#b49068',
        '--chart-5': '#8f6464',
        '--sidebar': '#fdf9f6',
        '--sidebar-foreground': '#2b1d19',
        '--sidebar-primary': '#ca6a33',
        '--sidebar-primary-foreground': '#fffaf7',
        '--sidebar-accent': '#fbede4',
        '--sidebar-accent-foreground': '#5f3824',
        '--sidebar-border': '#ead6cb',
        '--sidebar-ring': '#e99568'
      },
      dark: {
        '--background': '#22140e',
        '--foreground': '#fff4eb',
        '--card': '#2a1a12',
        '--card-foreground': '#fff4eb',
        '--popover': '#2f1d14',
        '--popover-foreground': '#fff4eb',
        '--primary': '#ffb27d',
        '--primary-foreground': '#341a0e',
        '--secondary': '#342116',
        '--secondary-foreground': '#fff4eb',
        '--muted': '#2a1a12',
        '--muted-foreground': '#c7ac9b',
        '--accent': '#422719',
        '--accent-foreground': '#fff4eb',
        '--destructive': '#ff9d8b',
        '--destructive-foreground': '#331611',
        '--border': '#533324',
        '--input': '#533324',
        '--ring': '#ffbf90',
        '--chart-1': '#ffb27d',
        '--chart-2': '#ffd8a8',
        '--chart-3': '#f3c66b',
        '--chart-4': '#d6a07e',
        '--chart-5': '#ff9b8b',
        '--sidebar': '#26160f',
        '--sidebar-foreground': '#fff4eb',
        '--sidebar-primary': '#ffb27d',
        '--sidebar-primary-foreground': '#341a0e',
        '--sidebar-accent': '#342116',
        '--sidebar-accent-foreground': '#fff4eb',
        '--sidebar-border': '#4f311f',
        '--sidebar-ring': '#ffbf90'
      }
    },
    terminal: {
      light: createTerminalTheme({
        background: '#fffaf6',
        foreground: '#33221c',
        selectionBackground: 'rgba(202, 106, 51, 0.16)',
        cursor: '#ca6a33',
        black: '#33221c',
        red: '#cc6258',
        green: '#7e9b57',
        yellow: '#cb9547',
        blue: '#d17d49',
        magenta: '#9d745b',
        cyan: '#b8804b',
        white: '#f2e3da',
        brightBlack: '#8c7165',
        brightRed: '#df7b70',
        brightGreen: '#96b26c',
        brightYellow: '#ddac60',
        brightBlue: '#e6915e',
        brightMagenta: '#b28b73',
        brightCyan: '#cf9965',
        brightWhite: '#ffffff'
      }),
      dark: createTerminalTheme({
        background: '#26160f',
        foreground: '#ffe9d8',
        selectionBackground: 'rgba(255, 178, 125, 0.18)',
        cursor: '#ffd8a8',
        black: '#26160f',
        red: '#ff9d8b',
        green: '#9fd17c',
        yellow: '#ffd17c',
        blue: '#ffb27d',
        magenta: '#d6a07e',
        cyan: '#ffc18e',
        white: '#ffe9d8',
        brightBlack: '#9c7761',
        brightRed: '#ffb8ab',
        brightGreen: '#b8e499',
        brightYellow: '#ffe09c',
        brightBlue: '#ffc69c',
        brightMagenta: '#e3b493',
        brightCyan: '#ffd3ae',
        brightWhite: '#fff8f2'
      })
    },
    ssh: {
      light: {
        libraryFrameStart: '#6a402f',
        libraryFrameEnd: '#87563e',
        libraryBorder: 'rgba(255,255,255,0.08)',
        libraryText: '#fff6ef',
        connectFrame: '#f8f2ed',
        connectBorder: '#ebdbd1',
        connectText: '#7b675e',
        terminalFrame: '#2a1a12',
        terminalBorder: 'rgba(255,255,255,0.08)',
        terminalText: '#ffe8d9',
        canvas: '#f8f2ed',
        canvasSubtle: '#fdf9f5',
        terminalCanvas: '#26160f',
        panel: '#2d1d14',
        panelStrong: '#26160f',
        panelBorder: 'rgba(255,255,255,0.08)',
        surface: '#ffffff',
        surfaceStrong: '#fdf7f3',
        text: '#33231c',
        muted: '#8d7568',
        accent: '#ca6a33',
        accentSoft: '#f9e5da',
        accentContrast: '#ffffff',
        success: '#7e9b57',
        successSoft: '#eef5e5',
        warning: '#cb9547',
        warningSoft: '#fff3df',
        danger: '#cc6258',
        dangerSoft: '#fff1f0',
        badge: '#ca6a33',
        libraryPill: 'rgba(255,255,255,0.1)',
        libraryPillActive: 'rgba(255,255,255,0.16)',
        libraryPillText: '#f0ddd2',
        libraryPillActiveText: '#ffffff',
        connectPill: '#efe4dc',
        connectPillActive: '#e0d3c8',
        connectPillText: '#7d675b',
        connectPillActiveText: '#4a3024',
        terminalPill: 'rgba(255,255,255,0.06)',
        terminalPillActive: '#4b2c1f',
        terminalPillText: '#f2ddd0',
        terminalPillActiveText: '#ffd4b0'
      },
      dark: {
        libraryFrameStart: '#2d1b13',
        libraryFrameEnd: '#46291d',
        libraryBorder: 'rgba(255,255,255,0.08)',
        libraryText: '#fff4eb',
        connectFrame: '#22140e',
        connectBorder: '#4a2d20',
        connectText: '#d2b29e',
        terminalFrame: '#1f120d',
        terminalBorder: 'rgba(255,255,255,0.08)',
        terminalText: '#fff0e5',
        canvas: '#22140e',
        canvasSubtle: '#26160f',
        terminalCanvas: '#1d110b',
        panel: '#291810',
        panelStrong: '#22140e',
        panelBorder: 'rgba(255,255,255,0.08)',
        surface: '#312016',
        surfaceStrong: '#3a261a',
        text: '#fff4eb',
        muted: '#d0ae99',
        accent: '#ffb27d',
        accentSoft: '#4b2c1f',
        accentContrast: '#341a0e',
        success: '#b7d98e',
        successSoft: '#252113',
        warning: '#ffd17c',
        warningSoft: '#332312',
        danger: '#ffac9f',
        dangerSoft: '#351815',
        badge: '#ffb27d',
        libraryPill: 'rgba(255,255,255,0.08)',
        libraryPillActive: 'rgba(255,255,255,0.14)',
        libraryPillText: '#efd8ca',
        libraryPillActiveText: '#ffffff',
        connectPill: '#342116',
        connectPillActive: '#4a2d20',
        connectPillText: '#e2beaa',
        connectPillActiveText: '#fff4eb',
        terminalPill: 'rgba(255,255,255,0.06)',
        terminalPillActive: '#533122',
        terminalPillText: '#f2ddcf',
        terminalPillActiveText: '#ffd9b7'
      }
    }
  }
}

export const APP_THEME_PRESETS = Object.values(PRESET_DEFINITIONS)

export function isAppThemePreset(value: unknown): value is AppThemePreset {
  return typeof value === 'string' && value in PRESET_DEFINITIONS
}

export function resolveAppThemeMode(value?: string | null): AppThemeMode {
  return value === 'light' ? 'light' : 'dark'
}

export function getThemePresetDefinition(preset: AppThemePreset): ThemePresetDefinition {
  return PRESET_DEFINITIONS[preset] ?? PRESET_DEFINITIONS[DEFAULT_APP_THEME_PRESET]
}

export function getTerminalTheme(preset: AppThemePreset, mode: AppThemeMode): ITheme {
  return getThemePresetDefinition(preset).terminal[mode]
}

export function getSshChromePalette(preset: AppThemePreset, mode: AppThemeMode): SshChromePalette {
  return getThemePresetDefinition(preset).ssh[mode]
}

export function applyThemePresetCssVars(
  root: HTMLElement,
  preset: AppThemePreset,
  mode: AppThemeMode
): void {
  const cssVars = getThemePresetDefinition(preset).cssVars[mode]
  for (const [key, value] of Object.entries(cssVars)) {
    root.style.setProperty(key, value)
  }
}
