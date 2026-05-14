import { useCallback, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Languages, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import changelogMd from '../../../../../CHANGELOG.md?raw'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import {
  createMarkdownComponents,
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from '../../lib/preview/viewers/markdown-components'
import { streamAiTranslation } from '../../lib/translate-service'
import { useProviderStore } from '../../stores/provider-store'
import { useSettingsStore } from '../../stores/settings-store'

interface ChangelogDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ChangelogDialog({ open, onOpenChange }: ChangelogDialogProps): React.JSX.Element {
  const { t } = useTranslation('common')
  const language = useSettingsStore((s) => s.language)
  const [translatedContent, setTranslatedContent] = useState<string | null>(null)
  const [translating, setTranslating] = useState(false)
  const [showTranslation, setShowTranslation] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const needsTranslation = language !== 'en'

  const handleTranslate = useCallback(async () => {
    if (translating) return

    const providerConfig = useProviderStore.getState().getActiveProviderConfig()
    if (!providerConfig) {
      toast.error(t('app.changelog.noProvider'))
      return
    }

    const ac = new AbortController()
    abortRef.current = ac
    setTranslating(true)
    setShowTranslation(true)
    setTranslatedContent('')

    try {
      let accumulated = ''
      await streamAiTranslation({
        text: changelogMd,
        sourceLanguage: 'en',
        targetLanguage: language,
        providerConfig,
        signal: ac.signal,
        onTextDelta: (chunk) => {
          accumulated += chunk
          setTranslatedContent(accumulated)
        }
      })
      setTranslatedContent(accumulated)
    } catch (err) {
      if (ac.signal.aborted) return
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t('app.changelog.translateError'), { description: msg })
    } finally {
      setTranslating(false)
      abortRef.current = null
    }
  }, [language, t, translating])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
        setTranslating(false)
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange]
  )

  const toggleView = useCallback(() => {
    setShowTranslation((prev) => !prev)
  }, [])

  const displayContent = showTranslation && translatedContent ? translatedContent : changelogMd

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <div className="flex items-center justify-between">
            <DialogTitle>{t('app.changelog.title')}</DialogTitle>
            {needsTranslation && (
              <div className="flex items-center gap-2">
                {translatedContent && !translating && (
                  <Button variant="ghost" size="sm" onClick={toggleView}>
                    {showTranslation
                      ? t('app.changelog.showOriginal')
                      : t('app.changelog.showTranslation')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTranslate}
                  disabled={translating}
                >
                  {translating ? (
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  ) : (
                    <Languages className="mr-1.5 size-3.5" />
                  )}
                  {translating ? t('app.changelog.translating') : t('app.changelog.translate')}
                </Button>
              </div>
            )}
          </div>
        </DialogHeader>

        <div className="max-h-[min(70vh,42rem)] overflow-y-auto px-6 py-4">
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown
              remarkPlugins={MARKDOWN_REMARK_PLUGINS}
              rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
              components={createMarkdownComponents()}
            >
              {displayContent}
            </ReactMarkdown>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
