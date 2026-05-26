import { useEffect, useMemo } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import {
  ArrowLeft,
  AlertTriangle,
  BrainCircuit,
  Download,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  Sparkles
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useSoulsStore, type SoulMarketInfo, type SoulsSortBy } from '@renderer/stores/souls-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { SoulInstallDialog, type SoulInstallProjectOption } from './SoulInstallDialog'

const SOULS_MARKET_DOCS_URL = 'https://skills.open-cowork.shop/docs'
const SOULS_MARKET_DASHBOARD_URL = 'https://skills.open-cowork.shop/dashboard'

function areInstallProjectOptionsEqual(
  left: SoulInstallProjectOption[],
  right: SoulInstallProjectOption[]
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a.id !== b.id || a.name !== b.name || a.workingFolder !== b.workingFolder) {
      return false
    }
  }
  return true
}

function formatDate(value?: string): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date)
}

function SoulCard({
  soul,
  onInstall
}: {
  soul: SoulMarketInfo
  onInstall: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const updatedAtLabel = formatDate(soul.updatedAt)

  return (
    <div className="rounded-lg border bg-card p-4 hover:shadow-md transition-shadow flex flex-col h-full">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold truncate">{soul.name}</h3>
          <p className="text-xs font-mono text-muted-foreground truncate">{soul.slug}</p>
        </div>
        <div className="size-8 shrink-0 rounded-lg bg-gradient-to-br from-purple-500/20 to-primary/5 border border-border/60 flex items-center justify-center">
          <BrainCircuit className="size-4 text-primary/70" />
        </div>
      </div>

      {soul.description ? (
        <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{soul.description}</p>
      ) : (
        <div className="mb-3 flex-1" />
      )}

      {soul.category ? (
        <div className="mb-3">
          <Badge variant="outline" className="text-[10px]">
            {soul.category}
          </Badge>
        </div>
      ) : null}

      <div className="flex items-center gap-4 text-xs text-muted-foreground mb-3 py-2 border-t border-b">
        <div className="flex items-center gap-1">
          <Download className="size-3" />
          <span>{soul.downloads}</span>
        </div>
        {updatedAtLabel ? <span className="font-mono text-[11px]">{updatedAtLabel}</span> : null}
      </div>

      <Button size="sm" className="mt-auto w-full gap-1.5 text-xs" onClick={onInstall}>
        <Download className="size-3" />
        {t('soulsPage.install')}
      </Button>
    </div>
  )
}

function SoulMarketConfig(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const apiKey = useSettingsStore((s) => s.skillsMarketApiKey)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const loadSouls = useSoulsStore((s) => s.loadSouls)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
          <Settings2 className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-4 space-y-4">
        <div>
          <p className="text-sm font-semibold">{t('soulmarket.title')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('soulmarket.desc')}</p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium flex items-center gap-1">
            <KeyRound className="size-3" />
            {t('soulmarket.apiKey')}
          </label>
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => updateSettings({ skillsMarketApiKey: event.target.value })}
            placeholder="sk-..."
            className="h-8 text-xs"
          />
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1 text-xs" asChild>
            <a href={SOULS_MARKET_DOCS_URL} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3" />
              {t('soulmarket.openDocs')}
            </a>
          </Button>
          <Button size="sm" className="flex-1 text-xs" asChild>
            <a href={SOULS_MARKET_DASHBOARD_URL} target="_blank" rel="noreferrer">
              <KeyRound className="size-3" />
              {t('soulmarket.getApiKey')}
            </a>
          </Button>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="w-full text-xs"
          onClick={() => void loadSouls(true)}
        >
          <RefreshCw className="size-3" />
          {t('soulmarket.refresh')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export function SoulsPage(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const souls = useSoulsStore((s) => s.souls)
  const total = useSoulsStore((s) => s.total)
  const loading = useSoulsStore((s) => s.loading)
  const error = useSoulsStore((s) => s.error)
  const query = useSoulsStore((s) => s.query)
  const category = useSoulsStore((s) => s.category)
  const sortBy = useSoulsStore((s) => s.sortBy)
  const categories = useSoulsStore((s) => s.categories)
  const loadSouls = useSoulsStore((s) => s.loadSouls)
  const loadMoreSouls = useSoulsStore((s) => s.loadMoreSouls)
  const setQuery = useSoulsStore((s) => s.setQuery)
  const setCategory = useSoulsStore((s) => s.setCategory)
  const setSortBy = useSoulsStore((s) => s.setSortBy)
  const loadCategories = useSoulsStore((s) => s.loadCategories)
  const downloadSoul = useSoulsStore((s) => s.downloadSoul)
  const installProjects = useStoreWithEqualityFn(
    useChatStore,
    (s) =>
      s.projects
        .filter((project) => !project.pluginId)
        .flatMap((project): SoulInstallProjectOption[] => {
          const workingFolder = project.workingFolder?.trim()
          if (!workingFolder) return []
          return [{ id: project.id, name: project.name, workingFolder }]
        }),
    areInstallProjectOptionsEqual
  )

  useEffect(() => {
    void loadCategories()
    void loadSouls(true)
  }, [loadCategories, loadSouls])

  const countLabel = useMemo(
    () => t('soulsPage.count', { loaded: souls.length, total }),
    [souls.length, t, total]
  )

  const handleBack = (): void => {
    useUIStore.getState().closeSoulsPage()
    useUIStore.getState().setActiveNavItem('chat')
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b px-4 py-3 flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            {t('soulsPage.title')}
          </h2>
          <p className="text-xs text-muted-foreground truncate">{t('soulsPage.subtitle')}</p>
        </div>
        <SoulMarketConfig />
      </div>

      <div className="border-b px-4 py-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('soulsPage.searchPlaceholder')}
            className="pl-8 h-9"
          />
        </div>
        <Select
          value={category || 'all'}
          onValueChange={(value) => setCategory(value === 'all' ? '' : value)}
        >
          <SelectTrigger className="h-9 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('soulsPage.allCategories')}</SelectItem>
            {categories.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={(value) => setSortBy(value as SoulsSortBy)}>
          <SelectTrigger className="h-9 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">{t('soulsPage.sortRecent')}</SelectItem>
            <SelectItem value="name">{t('soulsPage.sortName')}</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => void loadSouls(true)} disabled={loading}>
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {t('soulsPage.refresh')}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-4 rounded-xl border bg-gradient-to-br from-primary/10 to-purple-500/5 p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">SOULS</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t('soulsPage.hero')}</p>
            </div>
            <Badge variant="secondary">{countLabel}</Badge>
          </div>
        </div>

        {error ? (
          <Alert variant="destructive" className="mb-4">
            <AlertTriangle />
            <AlertTitle>{t('soulsPage.marketErrorTitle')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {loading && souls.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : souls.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <BrainCircuit className="size-8" />
            <p className="text-sm font-medium">{t('soulsPage.empty')}</p>
            <p className="text-xs">{t('soulsPage.emptyDesc')}</p>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {souls.map((soul) => (
                <SoulCard key={soul.id} soul={soul} onInstall={() => void downloadSoul(soul)} />
              ))}
            </div>
            {souls.length < total ? (
              <div className="mt-6 flex justify-center">
                <Button variant="outline" onClick={() => void loadMoreSouls()} disabled={loading}>
                  {loading ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t('soulsPage.loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <SoulInstallDialog projects={installProjects} />
    </div>
  )
}
