import { useState, useCallback } from 'react'
import { Key, ExternalLink, Wand2, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Separator } from '@renderer/components/ui/separator'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

export function SkillsMarketPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const [testing, setTesting] = useState(false)

  const handleTestConnection = useCallback(async () => {
    if (!settings.skillsMarketApiKey) {
      toast.error(t('skillsmarket.apiKeyRequired'))
      return
    }

    setTesting(true)
    try {
      const result = (await ipcClient.invoke('skills:market-list', {
        offset: 0,
        limit: 5,
        query: '',
        provider: 'skillsmp',
        apiKey: settings.skillsMarketApiKey,
      })) as { total: number; skills: unknown[] }

      if (result && result.total >= 0) {
        toast.success(t('skillsmarket.testSuccess', { count: result.total }))
      } else {
        toast.error(t('skillsmarket.testFailed', { error: 'No results returned' }))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t('skillsmarket.testFailed', { error: message }))
    } finally {
      setTesting(false)
    }
  }, [settings, t])

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold">{t('skillsmarket.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('skillsmarket.subtitle')}</p>
      </div>

      <Separator />
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium">{t('skillsmarket.apiKey')}</label>
            <p className="text-xs text-muted-foreground">{t('skillsmarket.apiKeyDesc')}</p>
          </div>
          <Key className="size-4 text-muted-foreground" />
        </div>
        <Input
          type="password"
          placeholder={t('skillsmarket.apiKeyPlaceholder')}
          value={settings.skillsMarketApiKey}
          onChange={(e) => settings.updateSettings({ skillsMarketApiKey: e.target.value })}
          className="max-w-sm"
        />
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() =>
              window.open('https://skillsmp.com/zh/docs/api', '_blank', 'noopener')
            }
          >
            <ExternalLink className="size-3" />
            {t('skillsmarket.getApiKey')}
          </Button>
        </div>

        {/* Info card */}
        <div className="rounded-lg border border-border/60 bg-muted/30 p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Wand2 className="size-4 text-primary" />
            SkillsMP
          </div>
          <p className="text-xs text-muted-foreground">
            {t('skillsmarket.skillsmpInfo')}
          </p>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs text-primary"
            onClick={() =>
              window.open('https://skillsmp.com', '_blank', 'noopener')
            }
          >
            skillsmp.com <ExternalLink className="ml-1 size-2.5" />
          </Button>
        </div>
      </section>

      <Separator />

      {/* Test Connection */}
      <section className="space-y-3">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => void handleTestConnection()}
          disabled={testing || !settings.skillsMarketApiKey}
        >
          <RefreshCw className={`size-3.5 ${testing ? 'animate-spin' : ''}`} />
          {testing ? t('skillsmarket.testing') : t('skillsmarket.test')}
        </Button>
        <p className="text-xs text-muted-foreground/70">{t('skillsmarket.testDesc')}</p>
      </section>

      <Separator />

      {/* Configuration Summary */}
      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <h3 className="text-sm font-medium">{t('skillsmarket.configSummary')}</h3>
        <div className="text-xs space-y-1 text-muted-foreground">
          <p>
            <strong>{t('skillsmarket.provider')}:</strong>{' '}
            SkillsMP
          </p>
          <p>
            <strong>{t('skillsmarket.apiKey')}:</strong>{' '}
            {settings.skillsMarketApiKey ? '********' : t('skillsmarket.notSet')}
          </p>
        </div>
      </section>
    </div>
  )
}
