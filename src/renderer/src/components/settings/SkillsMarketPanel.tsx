import { useState, useCallback } from 'react'
import { ExternalLink, Key, RefreshCw, Wand2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { SettingHint, SettingRow, SettingsSection } from './settings-primitives'

const SKILLS_MARKET_DOCS_URL = 'https://skills.open-cowork.shop/docs'
const SKILLS_MARKET_DASHBOARD_URL = 'https://skills.open-cowork.shop/dashboard'
const SKILLS_MARKET_BASE_URL = 'https://skills.open-cowork.shop'

/**
 * Renders as a section rather than a page: the skills market is only an API key
 * plus a connectivity check, so it lives inside the Extensions tab.
 */
export function SkillsMarketPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const [testing, setTesting] = useState(false)

  const handleTestConnection = useCallback(async () => {
    setTesting(true)
    try {
      const result = (await ipcClient.invoke('skills:market-list', {
        offset: 0,
        limit: 5,
        query: '',
        provider: 'skillsmp',
        apiKey: settings.skillsMarketApiKey
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
    <SettingsSection
      id="skills-market"
      icon={<Wand2 className="size-4" />}
      title={t('skillsmarket.title')}
      description={t('skillsmarket.subtitle')}
      actions={
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => void handleTestConnection()}
          disabled={testing}
        >
          <RefreshCw className={`size-3.5 ${testing ? 'animate-spin' : ''}`} />
          {testing ? t('skillsmarket.testing') : t('skillsmarket.test')}
        </Button>
      }
    >
      <SettingRow
        layout="stack"
        label={
          <span className="flex items-center gap-2">
            <Key className="size-3.5 text-muted-foreground" />
            {t('skillsmarket.apiKey')}
          </span>
        }
        description={t('skillsmarket.apiKeyDesc')}
      >
        <Input
          type="password"
          placeholder={t('skillsmarket.apiKeyPlaceholder')}
          value={settings.skillsMarketApiKey}
          onChange={(e) => settings.updateSettings({ skillsMarketApiKey: e.target.value })}
          className="max-w-sm"
        />
        <div className="mt-2 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => window.open(SKILLS_MARKET_DASHBOARD_URL, '_blank', 'noopener')}
          >
            <ExternalLink className="size-3" />
            {t('skillsmarket.getApiKey')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => window.open(SKILLS_MARKET_DOCS_URL, '_blank', 'noopener')}
          >
            <ExternalLink className="size-3" />
            {t('skillsmarket.openDocs')}
          </Button>
        </div>
      </SettingRow>

      <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
        <p className="text-xs text-muted-foreground">{t('skillsmarket.skillsmpInfo')}</p>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs text-primary"
          onClick={() => window.open(SKILLS_MARKET_BASE_URL, '_blank', 'noopener')}
        >
          skills.open-cowork.shop <ExternalLink className="ml-1 size-2.5" />
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">
          <strong>{t('skillsmarket.apiKey')}:</strong>{' '}
          {settings.skillsMarketApiKey ? '********' : t('skillsmarket.notSet')}
        </p>
      </div>

      <SettingHint>{t('skillsmarket.testDesc')}</SettingHint>
    </SettingsSection>
  )
}
