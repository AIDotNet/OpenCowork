import {
  Anchor,
  ArrowRightLeft,
  BarChart3,
  BookOpen,
  BrainCircuit,
  Cable,
  Gauge,
  Globe,
  Info,
  MessageSquare,
  PawPrint,
  Puzzle,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  UserRound,
  type LucideIcon
} from 'lucide-react'
import type { SettingsTabId } from '@renderer/lib/settings-tabs'

export type { SettingsTabId } from '@renderer/lib/settings-tabs'
export {
  DEFAULT_SETTINGS_TAB,
  isSettingsTabId,
  resolveSettingsTab
} from '@renderer/lib/settings-tabs'

/** How the content pane hosts the panel. */
export type SettingsPanelLayout = 'scroll' | 'full'

/** Reading width for scrolling panels. */
export type SettingsPanelWidth = 'narrow' | 'wide' | 'full'

export interface SettingsNavSection {
  /** Must match the `id` passed to `<SettingsSection>` inside the panel. */
  id: string
  labelKey: string
}

export interface SettingsNavItem {
  id: SettingsTabId
  icon: LucideIcon
  labelKey: string
  descKey: string
  layout: SettingsPanelLayout
  width: SettingsPanelWidth
  /** Searchable sections, also used to render in-panel jump targets. */
  sections?: SettingsNavSection[]
}

export interface SettingsNavGroup {
  id: string
  labelKey: string
  items: SettingsNavItem[]
}

export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    id: 'account',
    labelKey: 'page.groups.account',
    items: [
      {
        id: 'profile',
        icon: UserRound,
        labelKey: 'profile.title',
        descKey: 'profile.subtitle',
        layout: 'scroll',
        width: 'wide'
      },
      {
        id: 'general',
        icon: Settings,
        labelKey: 'general.title',
        descKey: 'general.subtitle',
        layout: 'scroll',
        width: 'narrow',
        sections: [
          { id: 'theme', labelKey: 'general.themePreset.title' },
          { id: 'appearance', labelKey: 'general.appearance.title' },
          { id: 'animation', labelKey: 'general.animations' },
          { id: 'interface', labelKey: 'general.sections.interface' },
          { id: 'language', labelKey: 'general.language' }
        ]
      }
    ]
  },
  {
    id: 'agent',
    labelKey: 'page.groups.agent',
    items: [
      {
        id: 'model',
        icon: BrainCircuit,
        labelKey: 'model.title',
        descKey: 'model.subtitle',
        layout: 'scroll',
        width: 'narrow',
        sections: [
          { id: 'chat-models', labelKey: 'model.sections.chat' },
          { id: 'prompt-recommendation', labelKey: 'model.promptRecommendationTitle' },
          { id: 'aux-models', labelKey: 'model.sections.auxiliary' },
          { id: 'sampling', labelKey: 'model.sections.sampling' }
        ]
      },
      {
        id: 'provider',
        icon: Server,
        labelKey: 'provider.title',
        descKey: 'provider.subtitle',
        layout: 'full',
        width: 'full'
      },
      {
        id: 'runtime',
        icon: Gauge,
        labelKey: 'runtime.title',
        descKey: 'runtime.subtitle',
        layout: 'scroll',
        width: 'narrow',
        sections: [
          { id: 'concurrency', labelKey: 'runtime.sections.concurrency' },
          { id: 'timeout', labelKey: 'general.apiRequestTimeout' },
          { id: 'compression', labelKey: 'general.contextCompression' },
          { id: 'tooling', labelKey: 'runtime.sections.tooling' },
          { id: 'advanced', labelKey: 'runtime.sections.advanced' }
        ]
      },
      {
        id: 'memory',
        icon: BookOpen,
        labelKey: 'memory.title',
        descKey: 'memory.subtitle',
        layout: 'scroll',
        width: 'narrow'
      },
      {
        id: 'permission',
        icon: ShieldCheck,
        labelKey: 'permission.title',
        descKey: 'permission.subtitle',
        layout: 'scroll',
        width: 'wide',
        sections: [
          { id: 'auto-approve', labelKey: 'general.autoApprove' },
          { id: 'whitelist', labelKey: 'permission.tools.title' },
          { id: 'bash-rules', labelKey: 'permission.bashAllow.title' }
        ]
      }
    ]
  },
  {
    id: 'extensions',
    labelKey: 'page.groups.extensions',
    items: [
      {
        id: 'plugin',
        icon: Puzzle,
        labelKey: 'plugin.title',
        descKey: 'plugin.subtitle',
        layout: 'full',
        width: 'full'
      },
      {
        id: 'aiCoding',
        icon: Terminal,
        labelKey: 'aiCoding.title',
        descKey: 'aiCoding.subtitle',
        layout: 'scroll',
        width: 'narrow'
      },
      {
        id: 'mcp',
        icon: Cable,
        labelKey: 'mcp.title',
        descKey: 'mcp.subtitle',
        layout: 'full',
        width: 'full'
      },
      {
        id: 'extension',
        icon: Sparkles,
        labelKey: 'extension.title',
        descKey: 'extension.subtitle',
        layout: 'scroll',
        width: 'wide',
        sections: [{ id: 'skills-market', labelKey: 'skillsmarket.title' }]
      },
      {
        id: 'hooks',
        icon: Anchor,
        labelKey: 'hooks.title',
        descKey: 'hooks.subtitle',
        layout: 'scroll',
        width: 'narrow'
      },
      {
        id: 'channel',
        icon: MessageSquare,
        labelKey: 'channel.title',
        descKey: 'channel.subtitle',
        layout: 'full',
        width: 'full'
      },
      {
        id: 'websearch',
        icon: Globe,
        labelKey: 'websearch.title',
        descKey: 'websearch.subtitle',
        layout: 'scroll',
        width: 'narrow'
      }
    ]
  },
  {
    id: 'system',
    labelKey: 'page.groups.system',
    items: [
      {
        id: 'system',
        icon: Terminal,
        labelKey: 'system.title',
        descKey: 'system.subtitle',
        layout: 'scroll',
        width: 'narrow',
        sections: [
          { id: 'updates', labelKey: 'general.update.checkForUpdates' },
          { id: 'shell', labelKey: 'system.shell.endpoint.title' },
          { id: 'proxy', labelKey: 'general.systemProxy' },
          { id: 'workspace', labelKey: 'general.projectDefaultDirectory.title' },
          { id: 'editor', labelKey: 'general.editorWorkspace' }
        ]
      },
      {
        id: 'data',
        icon: ArrowRightLeft,
        labelKey: 'data.title',
        descKey: 'data.subtitle',
        layout: 'scroll',
        width: 'narrow',
        sections: [
          { id: 'sessions', labelKey: 'general.data.title' },
          { id: 'migration', labelKey: 'migration.title' },
          { id: 'reset', labelKey: 'general.resetDefault' }
        ]
      }
    ]
  },
  {
    id: 'more',
    labelKey: 'page.groups.more',
    items: [
      {
        id: 'pet',
        icon: PawPrint,
        labelKey: 'pet.title',
        descKey: 'pet.subtitle',
        layout: 'scroll',
        width: 'wide'
      },
      {
        id: 'analytics',
        icon: BarChart3,
        labelKey: 'analytics.title',
        descKey: 'analytics.subtitle',
        layout: 'scroll',
        width: 'full'
      },
      {
        id: 'about',
        icon: Info,
        labelKey: 'about.title',
        descKey: 'about.subtitle',
        layout: 'scroll',
        width: 'narrow'
      }
    ]
  }
]

export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = SETTINGS_NAV_GROUPS.flatMap(
  (group) => group.items
)

const NAV_ITEM_BY_ID = new Map<SettingsTabId, SettingsNavItem>(
  SETTINGS_NAV_ITEMS.map((item) => [item.id, item])
)

export function getSettingsNavItem(tab: SettingsTabId): SettingsNavItem | undefined {
  return NAV_ITEM_BY_ID.get(tab)
}

export interface SettingsSearchEntry {
  tab: SettingsTabId
  /** Present when the entry points at a section inside the tab. */
  sectionId?: string
  labelKey: string
  /** Parent tab label, shown as the search result breadcrumb. */
  contextKey: string
  groupLabelKey: string
}

export const SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...SETTINGS_NAV_GROUPS.flatMap((group) =>
    group.items.flatMap<SettingsSearchEntry>((item) => [
      {
        tab: item.id,
        labelKey: item.labelKey,
        contextKey: item.descKey,
        groupLabelKey: group.labelKey
      },
      ...(item.sections ?? []).map((section) => ({
        tab: item.id,
        sectionId: section.id,
        labelKey: section.labelKey,
        contextKey: item.labelKey,
        groupLabelKey: group.labelKey
      }))
    ])
  ),
  {
    tab: 'system',
    sectionId: 'updates',
    labelKey: 'general.autoUpdate',
    contextKey: 'system.title',
    groupLabelKey: 'page.groups.system'
  }
]
