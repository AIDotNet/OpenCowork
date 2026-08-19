import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Terminal } from 'lucide-react'
import { AiCodingPanel } from '../AiCodingPanel'
import { SettingsPanel, SettingsSegmented } from '../settings-primitives'

type AiCodingKind = 'claude' | 'codex'

/**
 * Claude Code and Codex used to occupy two sidebar entries that differed only by
 * which config list they edited; they now share one tab.
 */
export function AiCodingWorkbenchPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [kind, setKind] = useState<AiCodingKind>('claude')

  return (
    <SettingsPanel
      title={t('aiCoding.title')}
      description={kind === 'claude' ? t('aiCoding.claudeSubtitle') : t('aiCoding.codexSubtitle')}
      actions={
        <SettingsSegmented<AiCodingKind>
          value={kind}
          onChange={setKind}
          options={[
            {
              value: 'claude',
              label: t('aiCoding.claudeTitle'),
              icon: <Terminal className="size-3.5" />
            },
            {
              value: 'codex',
              label: t('aiCoding.codexTitle'),
              icon: <Sparkles className="size-3.5" />
            }
          ]}
        />
      }
    >
      <AiCodingPanel key={kind} kind={kind} hideHeader />
    </SettingsPanel>
  )
}
