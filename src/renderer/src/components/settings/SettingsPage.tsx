import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Search, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { FadeIn, SlideIn } from '@renderer/components/animate-ui'
import { WindowControls } from '@renderer/components/layout/WindowControls'
import { cn } from '@renderer/lib/utils'
import {
  getSettingsNavItem,
  resolveSettingsTab,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SEARCH_ENTRIES,
  type SettingsNavItem,
  type SettingsTabId
} from './settings-nav'
import { settingsSectionDomId } from './settings-primitives'
import { ChannelPanel } from './PluginPanel'
import { AppPluginPanel } from './AppPluginPanel'
import { ExtensionPanel } from './ExtensionPanel'
import { McpPanel } from './McpPanel'
import { HooksPanel } from './HooksPanel'
import { PermissionPanel } from './PermissionPanel'
import { WebSearchPanel } from './WebSearchPanel'
import { PetPanel } from './PetPanel'
import { ProfilePanel } from './ProfilePanel'
import { AboutPanel } from './panels/AboutPanel'
import { AiCodingWorkbenchPanel } from './panels/AiCodingWorkbenchPanel'
import { AnalyticsPanel } from './panels/AnalyticsPanel'
import { DataPanel } from './panels/DataPanel'
import { GeneralPanel } from './panels/GeneralPanel'
import { MemoryPanel } from './panels/MemoryPanel'
import { ModelPanel } from './panels/ModelPanel'
import { ProviderWorkbenchPanel } from './panels/ProviderWorkbenchPanel'
import { RuntimePanel } from './panels/RuntimePanel'
import { SystemPanel } from './panels/SystemPanel'

const panelMap: Record<SettingsTabId, () => React.JSX.Element> = {
  profile: ProfilePanel,
  general: GeneralPanel,
  model: ModelPanel,
  provider: ProviderWorkbenchPanel,
  runtime: RuntimePanel,
  memory: MemoryPanel,
  permission: PermissionPanel,
  plugin: AppPluginPanel,
  aiCoding: AiCodingWorkbenchPanel,
  mcp: McpPanel,
  extension: ExtensionPanel,
  hooks: HooksPanel,
  channel: ChannelPanel,
  websearch: WebSearchPanel,
  system: SystemPanel,
  data: DataPanel,
  pet: PetPanel,
  analytics: AnalyticsPanel,
  about: AboutPanel
}

const CONTENT_WIDTH_CLASS = {
  narrow: 'mx-auto w-full max-w-3xl px-8 pb-16 pt-8',
  wide: 'mx-auto w-full max-w-5xl px-6 pb-16 pt-8',
  full: 'w-full px-6 pb-16 pt-8'
} as const

interface SearchResult {
  tab: SettingsTabId
  sectionId?: string
  label: string
  context: string
}

export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settingsTab = useUIStore((s) => s.settingsTab)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const closeSettingsPage = useUIStore((s) => s.closeSettingsPage)
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)
  const isMac = useMemo(() => /Mac/.test(navigator.userAgent), [])

  const [query, setQuery] = useState('')
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pendingSectionRef = useRef<string | null>(null)

  const activeTab = resolveSettingsTab(settingsTab) ?? 'profile'
  const activeItem = getSettingsNavItem(activeTab)
  const ActivePanel = panelMap[activeTab]
  const isFullLayout = activeItem?.layout === 'full'

  const scrollToSection = useCallback((sectionId: string) => {
    const target = document.getElementById(settingsSectionDomId(sectionId))
    if (!target) return false
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveSectionId(sectionId)
    return true
  }, [])

  const goTo = useCallback(
    (tab: SettingsTabId, sectionId?: string) => {
      if (tab !== activeTab) {
        pendingSectionRef.current = sectionId ?? null
        setSettingsTab(tab)
        return
      }
      if (sectionId) scrollToSection(sectionId)
    },
    [activeTab, scrollToSection, setSettingsTab]
  )

  // The panel for a newly selected tab only exists after it renders, so a
  // requested section anchor has to be replayed on the next frame.
  useEffect(() => {
    const pending = pendingSectionRef.current
    if (!pending) {
      setActiveSectionId(null)
      scrollRef.current?.scrollTo({ top: 0 })
      return
    }
    pendingSectionRef.current = null
    const frame = requestAnimationFrame(() => scrollToSection(pending))
    return () => cancelAnimationFrame(frame)
  }, [activeTab, scrollToSection])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
      if (event.key === 'Escape' && document.activeElement === searchInputRef.current) {
        setQuery('')
        searchInputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const results = useMemo<SearchResult[]>(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []
    return SETTINGS_SEARCH_ENTRIES.map((entry) => ({
      tab: entry.tab,
      sectionId: entry.sectionId,
      label: t(entry.labelKey),
      context: t(entry.contextKey)
    })).filter(
      (entry) =>
        entry.label.toLowerCase().includes(normalized) ||
        entry.context.toLowerCase().includes(normalized)
    )
  }, [query, t])

  const searching = query.trim().length > 0

  const handleNavKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = Array.from(
      navRef.current?.querySelectorAll<HTMLButtonElement>('button[data-nav-item]') ?? []
    )
    if (buttons.length === 0) return
    event.preventDefault()
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const next = (current + delta + buttons.length) % buttons.length
    buttons[next]?.focus()
  }, [])

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-muted/10">
      <motion.header
        initial={animationsEnabled ? { opacity: 0, y: -4 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={animationsEnabled ? { duration: 0.18, ease: 'easeOut' } : { duration: 0 }}
        className={`titlebar-drag relative flex h-10 shrink-0 items-center gap-3 border-b bg-background/90 px-3 backdrop-blur ${isMac ? 'pl-[104px]' : 'pr-[132px]'}`}
        style={{ paddingRight: isMac ? undefined : 'calc(132px + 0.75rem)' }}
      >
        <Button
          variant="ghost"
          size="icon"
          className="titlebar-no-drag size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
          onClick={closeSettingsPage}
          title={t('page.back', { defaultValue: 'Back' })}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground/92">{t('page.title')}</div>
          <div className="hidden truncate text-[11px] text-muted-foreground sm:block">
            {t('page.subtitle')}
          </div>
        </div>
        {!isMac ? (
          <div className="absolute right-0 top-0 z-10">
            <WindowControls />
          </div>
        ) : null}
      </motion.header>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[240px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
          <div className="shrink-0 border-b border-sidebar-border/60 p-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('page.searchPlaceholder')}
                className="h-8 bg-background/70 pl-8 pr-7 text-xs shadow-none"
              />
              {searching ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                  aria-label={t('page.searchClear')}
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
          </div>

          <nav
            ref={navRef}
            onKeyDown={handleNavKeyDown}
            className="flex-1 space-y-5 overflow-y-auto px-2.5 pb-2 pt-3"
          >
            {searching ? (
              <SearchResultList results={results} onSelect={goTo} emptyLabel={t('page.searchEmpty')} />
            ) : (
              SETTINGS_NAV_GROUPS.map((group, groupIndex) => (
                <motion.div
                  key={group.id}
                  initial={animationsEnabled ? { opacity: 0, x: -6 } : false}
                  animate={{ opacity: 1, x: 0 }}
                  transition={
                    animationsEnabled
                      ? { duration: 0.2, delay: groupIndex * 0.03, ease: 'easeOut' }
                      : { duration: 0 }
                  }
                  className="space-y-0.5"
                >
                  <p className="mb-1 px-3 text-[11px] font-medium text-muted-foreground/70">
                    {t(group.labelKey)}
                  </p>
                  {group.items.map((item) => (
                    <NavEntry
                      key={item.id}
                      item={item}
                      active={activeTab === item.id}
                      activeSectionId={activeSectionId}
                      animationsEnabled={animationsEnabled}
                      onSelect={goTo}
                    />
                  ))}
                </motion.div>
              ))
            )}
          </nav>

          <div className="border-t border-sidebar-border/60 px-4 py-3 text-[11px] text-muted-foreground/55">
            {t('page.poweredBy')}
          </div>
        </div>

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-5 py-5">
          <AnimatePresence mode="wait">
            {isFullLayout ? (
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden" key="full-panel">
                <SlideIn
                  key={activeTab}
                  direction="right"
                  duration={0.25}
                  className="h-full min-h-0"
                >
                  <ActivePanel />
                </SlideIn>
              </div>
            ) : (
              <div ref={scrollRef} className="flex-1 overflow-y-auto" key="scroll-panel">
                <div className={CONTENT_WIDTH_CLASS[activeItem?.width ?? 'narrow']}>
                  <FadeIn key={activeTab} duration={0.25} className="w-full">
                    <ActivePanel />
                  </FadeIn>
                </div>
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

interface NavEntryProps {
  item: SettingsNavItem
  active: boolean
  activeSectionId: string | null
  animationsEnabled: boolean
  onSelect: (tab: SettingsTabId, sectionId?: string) => void
}

function NavEntry({
  item,
  active,
  activeSectionId,
  animationsEnabled,
  onSelect
}: NavEntryProps): React.JSX.Element {
  const { t } = useTranslation('settings')
  const Icon = item.icon

  return (
    <div>
      <motion.button
        type="button"
        data-nav-item
        onClick={() => onSelect(item.id)}
        whileTap={animationsEnabled ? { scale: 0.985 } : undefined}
        className={cn(
          'group relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-ring',
          active
            ? cn(
                'font-medium text-sidebar-accent-foreground',
                !animationsEnabled && 'bg-sidebar-accent'
              )
            : 'text-muted-foreground hover:bg-sidebar-accent/55 hover:text-foreground'
        )}
      >
        {animationsEnabled && active && (
          <motion.div
            layoutId="settings-nav-active"
            className="absolute inset-0 rounded-lg bg-sidebar-accent"
            transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.7 }}
          />
        )}
        <span
          className={cn(
            'relative z-10 flex shrink-0 items-center justify-center transition-colors',
            active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'
          )}
        >
          <Icon className="size-4" />
        </span>
        <span className="relative z-10 min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
      </motion.button>

      {active && item.sections?.length ? (
        <div className="mb-1 ml-[26px] mt-0.5 space-y-px border-l border-sidebar-border/70 pl-2">
          {item.sections.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => onSelect(item.id, section.id)}
              className={cn(
                'block w-full truncate rounded px-2 py-1 text-left text-[11.5px] transition-colors',
                activeSectionId === section.id
                  ? 'text-foreground'
                  : 'text-muted-foreground/70 hover:text-foreground'
              )}
            >
              {t(section.labelKey)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

interface SearchResultListProps {
  results: SearchResult[]
  onSelect: (tab: SettingsTabId, sectionId?: string) => void
  emptyLabel: string
}

function SearchResultList({
  results,
  onSelect,
  emptyLabel
}: SearchResultListProps): React.JSX.Element {
  if (results.length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-muted-foreground/70">{emptyLabel}</p>
  }

  return (
    <div className="space-y-0.5">
      {results.map((result) => (
        <button
          key={`${result.tab}-${result.sectionId ?? 'root'}`}
          type="button"
          data-nav-item
          onClick={() => onSelect(result.tab, result.sectionId)}
          className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent/55 focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="truncate text-[13px] text-foreground">{result.label}</span>
          <span className="truncate text-[11px] text-muted-foreground/70">{result.context}</span>
        </button>
      ))}
    </div>
  )
}
