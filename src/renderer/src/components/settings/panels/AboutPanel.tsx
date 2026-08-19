import { useTranslation } from 'react-i18next'
import { Github, Layers, ShieldCheck, Sparkles } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Separator } from '@renderer/components/ui/separator'
import { SettingsPanel } from '../settings-primitives'
import packageJson from '../../../../../../package.json'

export function AboutPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const appVersion = packageJson.version ?? '0.0.0'
  const meta = [
    { label: t('about.version'), value: appVersion },
    { label: t('about.framework'), value: 'Electron · React · TypeScript' },
    { label: t('about.ui'), value: 'shadcn/ui · TailwindCSS' },
    { label: t('about.license'), value: 'Apache 2.0' }
  ]
  const featureCards = [
    {
      icon: Sparkles,
      title: t('about.featureCards.orchestration.title'),
      desc: t('about.featureCards.orchestration.desc')
    },
    {
      icon: ShieldCheck,
      title: t('about.featureCards.sandbox.title'),
      desc: t('about.featureCards.sandbox.desc')
    },
    {
      icon: Layers,
      title: t('about.featureCards.channels.title'),
      desc: t('about.featureCards.channels.desc')
    }
  ]
  return (
    <SettingsPanel
      title={t('about.title')}
      description={t('about.subtitle')}
      actions={
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() =>
            window.open('https://github.com/AIDotNet/OpenCowork', '_blank', 'noopener')
          }
        >
          <Github className="size-3.5" /> GitHub
        </Button>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="relative overflow-hidden rounded-3xl border border-border/60 bg-gradient-to-br from-muted/60 via-background to-muted/40 p-6 shadow-inner">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="relative">
              <div className="size-16 rounded-2xl bg-gradient-to-br from-primary/40 via-primary/60 to-primary p-[2px] shadow-lg shadow-primary/30">
                <div className="flex h-full w-full items-center justify-center rounded-2xl bg-background text-lg font-semibold tracking-wide text-foreground">
                  OC
                </div>
              </div>
              <div
                className="absolute -inset-1 rounded-3xl bg-primary/10 blur-2xl"
                aria-hidden="true"
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                {t('about.heroTagline')}
              </p>
              <h3 className="text-2xl font-semibold text-foreground">OpenCowork</h3>
              <p className="text-sm text-muted-foreground">{t('about.heroDescription')}</p>
            </div>
          </div>
          <Separator className="my-6 border-border/40" />
          <div className="grid gap-4 sm:grid-cols-2">
            {meta.map((item) => (
              <div
                key={item.label}
                className="rounded-2xl border border-border/50 bg-card px-4 py-3 text-sm"
              >
                <p className="text-xs uppercase text-muted-foreground/70">{item.label}</p>
                <p className="mt-1 font-medium text-foreground">{item.value}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-border/70 bg-card/60 p-5 shadow-lg shadow-slate-900/5">
          <p className="text-xs uppercase tracking-[0.3em] text-primary">
            {t('about.workflowLabel')}
          </p>
          <h4 className="mt-2 text-lg font-semibold">{t('about.workflowTitle')}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{t('about.workflowDescription')}</p>
          <div className="mt-4 space-y-3">
            {featureCards.map((card) => (
              <div
                key={card.title}
                className="flex gap-3 rounded-2xl border border-border/80 bg-background/70 px-3 py-2"
              >
                <card.icon className="mt-0.5 size-4 text-primary" />
                <div>
                  <p className="text-sm font-medium">{card.title}</p>
                  <p className="text-xs text-muted-foreground">{card.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <Button
            className="mt-4 h-9 w-full text-xs"
            variant="secondary"
            onClick={() =>
              window.open('https://github.com/AIDotNet/OpenCowork/releases', '_blank', 'noopener')
            }
          >
            {t('about.workflowCta')}
          </Button>
        </section>

        <section className="rounded-3xl border border-dashed border-border/60 bg-muted/20 p-5 lg:col-span-2">
          <p className="text-sm text-muted-foreground">{t('about.summary')}</p>
        </section>
      </div>
    </SettingsPanel>
  )
}
