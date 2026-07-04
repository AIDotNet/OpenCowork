import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bath,
  Briefcase,
  Check,
  Coins,
  Cookie,
  GraduationCap,
  Heart,
  Lock,
  Moon,
  Sparkles,
  Utensils,
  Waves
} from 'lucide-react'
import {
  SOAK_MIN_LEVEL,
  STUDY_MIN_LEVEL,
  WORK_MIN_LEVEL,
  getGrowthForLevel,
  getLevelProgress,
  getPetLevel,
  usePetStore
} from '@renderer/stores/pet-store'
import { usePetExpStore } from '@renderer/stores/pet-exp-store'

function StatRow({
  icon,
  label,
  value,
  barClass
}: {
  icon: React.ReactNode
  label: string
  value: number
  barClass: string
}): React.JSX.Element {
  const pct = Math.round(value)
  return (
    <div className="flex items-center gap-3">
      <span className="flex w-24 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${pct < 30 ? 'bg-red-400' : barClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {pct} / 100
      </span>
    </div>
  )
}

function InfoCard({
  label,
  value,
  icon
}: {
  label: string
  value: string
  icon: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/60 p-3">
      <span className="text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-medium">{value}</p>
      </div>
    </div>
  )
}

export function PetStatsTab(): React.JSX.Element {
  const { t } = useTranslation('pet')
  const [, setNow] = useState(Date.now())

  const hunger = usePetStore((s) => s.hunger)
  const cleanliness = usePetStore((s) => s.cleanliness)
  const mood = usePetStore((s) => s.mood)
  const growth = usePetStore((s) => s.growth)
  const coins = usePetStore((s) => s.coins)
  const sleeping = usePetStore((s) => s.sleeping)
  const awayTask = usePetStore((s) => s.awayTask)
  const adoptedAt = usePetStore((s) => s.adoptedAt)
  const totalExp = usePetExpStore((s) => s.totalExp)
  const totalTokens = usePetExpStore((s) => s.totalTokens)
  const expLog = usePetExpStore((s) => s.log)

  // The pet window owns the live simulation and persists every tick;
  // refresh this window's copy periodically so the panel stays current.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void usePetStore.persist.rehydrate()
      setNow(Date.now())
    }, 5000)
    return () => window.clearInterval(timer)
  }, [])

  const combinedGrowth = growth + totalExp
  const level = getPetLevel(combinedGrowth)
  const nextLevelGrowth = getGrowthForLevel(level + 1)
  const days = Math.max(1, Math.ceil((Date.now() - adoptedAt) / 86_400_000))

  const status = awayTask
    ? t(awayTask.kind === 'work' ? 'stats.statusWorking' : 'stats.statusStudying', {
        minutes: Math.max(1, Math.ceil((awayTask.endsAt - Date.now()) / 60_000))
      })
    : sleeping
      ? t('stats.statusSleeping')
      : t('stats.statusActive')

  const unlocks = [
    { icon: <Waves className="size-3.5" />, label: t('menu.soak'), level: SOAK_MIN_LEVEL },
    { icon: <Briefcase className="size-3.5" />, label: t('menu.work'), level: WORK_MIN_LEVEL },
    { icon: <GraduationCap className="size-3.5" />, label: t('menu.study'), level: STUDY_MIN_LEVEL }
  ]

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <p className="text-sm font-medium">{t('stats.condition')}</p>
        <StatRow
          icon={<Utensils className="size-3.5" />}
          label={t('hud.hunger')}
          value={hunger}
          barClass="bg-amber-400"
        />
        <StatRow
          icon={<Bath className="size-3.5" />}
          label={t('hud.clean')}
          value={cleanliness}
          barClass="bg-sky-400"
        />
        <StatRow
          icon={<Heart className="size-3.5" />}
          label={t('hud.mood')}
          value={mood}
          barClass="bg-pink-400"
        />
      </section>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t('stats.growthTitle')}</p>
          <span className="text-xs text-muted-foreground">
            {t('stats.growthValue', {
              current: Math.floor(combinedGrowth),
              next: nextLevelGrowth
            })}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-sm font-semibold text-violet-400">
            <Sparkles className="size-4" />
            Lv.{level}
          </span>
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-violet-400 transition-all"
              style={{ width: `${Math.round(getLevelProgress(combinedGrowth) * 100)}%` }}
            />
          </div>
          <span className="text-sm text-muted-foreground">Lv.{level + 1}</span>
        </div>
        <p className="text-[11px] text-muted-foreground">{t('stats.expRule')}</p>
      </section>

      <section className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t('stats.expLog')}</p>
          <span className="text-[11px] text-muted-foreground">
            {t('stats.expTotal', { exp: Math.floor(totalExp) })}
          </span>
        </div>
        {expLog.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('stats.expLogEmpty')}</p>
        ) : (
          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {expLog.slice(0, 50).map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-2 rounded-md bg-background/60 px-2 py-1.5 text-[11px]"
              >
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {new Date(entry.at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
                <span className="min-w-0 flex-1 truncate">{entry.model}</span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${
                    entry.premium
                      ? 'bg-violet-400/15 text-violet-400'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {t(entry.premium ? 'stats.premium' : 'stats.base')}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {entry.tokens.toLocaleString()} tok
                </span>
                <span className="shrink-0 tabular-nums font-medium text-emerald-500">
                  +{entry.exp}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <InfoCard
          label={t('stats.coins')}
          value={String(Math.floor(coins))}
          icon={<Coins className="size-4 text-amber-500" />}
        />
        <InfoCard
          label={t('stats.tokensEaten')}
          value={totalTokens.toLocaleString()}
          icon={<Cookie className="size-4 text-orange-400" />}
        />
        <InfoCard
          label={t('stats.days')}
          value={t('stats.daysValue', { count: days })}
          icon={<Heart className="size-4 text-pink-400" />}
        />
        <InfoCard
          label={t('stats.status')}
          value={status}
          icon={<Moon className="size-4 text-sky-400" />}
        />
      </div>

      <section className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-4">
        <p className="text-sm font-medium">{t('stats.unlocks')}</p>
        <div className="space-y-1.5">
          {unlocks.map((entry) => {
            const unlocked = level >= entry.level
            return (
              <div key={entry.label} className="flex items-center gap-2 text-xs">
                <span className={unlocked ? 'text-foreground' : 'text-muted-foreground'}>
                  {entry.icon}
                </span>
                <span className={unlocked ? '' : 'text-muted-foreground'}>{entry.label}</span>
                <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
                  {unlocked ? (
                    <>
                      <Check className="size-3 text-emerald-500" />
                      {t('stats.unlocked')}
                    </>
                  ) : (
                    <>
                      <Lock className="size-3" />
                      {t('stats.unlockedAt', { level: entry.level })}
                    </>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
