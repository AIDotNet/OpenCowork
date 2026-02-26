import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowLeftRight,
  Bot,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  FileText,
  Loader2,
  Pencil,
  Settings,
  Sparkles,
  Square,
  Upload,
  X,
  Zap
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { Badge } from '@renderer/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ModelIcon, ProviderIcon } from '@renderer/components/settings/provider-icons'
import { cn } from '@renderer/lib/utils'
import { useUIStore } from '@renderer/stores/ui-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useTranslateStore } from '@renderer/stores/translate-store'
import type { AgentStep } from '@renderer/stores/translate-store'

// ── Agent timeline sidebar ─────────────────────────────────────────────────

function AgentTimeline({
  steps,
  isRunning
}: {
  steps: AgentStep[]
  isRunning: boolean
}): React.JSX.Element {
  // Group steps: each 'iteration' starts a group
  type Group = { iterLabel: string; items: AgentStep[] }
  const groups: Group[] = []
  for (const step of steps) {
    if (step.type === 'iteration') {
      groups.push({ iterLabel: step.label, items: [] })
    } else if (groups.length > 0) {
      groups[groups.length - 1].items.push(step)
    }
  }

  const toolIcon = (name: string): React.JSX.Element => {
    if (name === 'Write') return <FileText className="size-3 text-blue-400" />
    if (name === 'Edit' || name === 'MultiEdit')
      return <Pencil className="size-3 text-emerald-400" />
    if (name === 'FileRead') return <Upload className="size-3 text-amber-400" />
    return <Bot className="size-3 text-muted-foreground" />
  }

  return (
    <div className="flex flex-col gap-3 py-1">
      {groups.map((group, gi) => {
        const isLastGroup = gi === groups.length - 1
        return (
          <div key={gi} className="relative pl-5">
            {/* vertical connector line */}
            {gi < groups.length - 1 && (
              <span className="absolute left-[7px] top-5 bottom-0 w-px bg-border/60" />
            )}
            {/* iteration dot */}
            <div className="absolute left-0 top-0.5 flex size-3.5 items-center justify-center rounded-full border border-primary/40 bg-primary/10">
              <span className="size-1.5 rounded-full bg-primary/60" />
            </div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-1">
              {group.iterLabel}
            </p>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    'flex items-start gap-1.5 rounded px-1.5 py-1 text-[11px]',
                    item.isError ? 'text-destructive' : 'text-foreground/70'
                  )}
                >
                  {item.isError ? (
                    <X className="size-3 text-destructive shrink-0 mt-0.5" />
                  ) : (
                    toolIcon(item.label)
                  )}
                  <div className="min-w-0 leading-tight">
                    <span className="font-mono">{item.label}()</span>
                    {item.detail && (
                      <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                        {item.detail}
                      </p>
                    )}
                  </div>
                </div>
              ))}
              {isLastGroup && isRunning && (
                <div className="flex items-center gap-1.5 px-1.5 py-1">
                  <Loader2 className="size-3 animate-spin text-primary/60 shrink-0" />
                  <span className="text-[11px] text-muted-foreground/50">…</span>
                </div>
              )}
            </div>
          </div>
        )
      })}
      {groups.length === 0 && isRunning && (
        <div className="flex items-center gap-1.5 pl-1">
          <Loader2 className="size-3 animate-spin text-primary/60 shrink-0" />
          <span className="text-[11px] text-muted-foreground/50">Starting…</span>
        </div>
      )}
    </div>
  )
}

// ── File drop-zone ─────────────────────────────────────────────────────────

function FileDropZone({
  fileName,
  onSelect,
  onClear,
  disabled
}: {
  fileName: string | null
  onSelect: () => void
  onClear: () => void
  disabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [dragging, setDragging] = useState(false)

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragging(true)
  }
  const handleDragLeave = (): void => setDragging(false)
  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    // The store's selectFile handles dialog — for drag-drop we just trigger the same dialog
    // since IPC file reading needs the main process path. Fallback: open dialog.
    if (!disabled) onSelect()
  }

  if (fileName) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
        <FileText className="size-4 text-primary/60 shrink-0" />
        <span className="flex-1 truncate text-xs font-medium">{fileName}</span>
        <Badge variant="secondary" className="text-[10px] shrink-0">
          {t('translatePage.agentFileLoaded')}
        </Badge>
        {!disabled && (
          <button
            onClick={onClear}
            className="ml-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    )
  }

  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed py-4 text-center transition-colors',
        dragging
          ? 'border-primary/60 bg-primary/5 text-primary'
          : 'border-border/60 text-muted-foreground hover:border-primary/40 hover:bg-muted/20',
        disabled && 'pointer-events-none opacity-50'
      )}
    >
      <Upload className="size-5 opacity-60" />
      <span className="text-xs font-medium">{t('translatePage.agentDropZone')}</span>
      <span className="text-[10px] opacity-50">{t('translatePage.agentDropZoneFormats')}</span>
    </button>
  )
}

interface LanguageOption {
  value: string
  label: string
}

export function TranslatePage(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [modelPickerOpen, setModelPickerOpen] = useState(false)

  const sourceLanguage = useTranslateStore((s) => s.sourceLanguage)
  const targetLanguage = useTranslateStore((s) => s.targetLanguage)
  const sourceText = useTranslateStore((s) => s.sourceText)
  const translatedText = useTranslateStore((s) => s.translatedText)
  const isTranslating = useTranslateStore((s) => s.isTranslating)
  const overrideProviderId = useTranslateStore((s) => s.overrideProviderId)
  const overrideModelId = useTranslateStore((s) => s.overrideModelId)
  const agentMode = useTranslateStore((s) => s.agentMode)
  const agentSteps = useTranslateStore((s) => s.agentSteps)
  const selectedFileName = useTranslateStore((s) => s.selectedFileName)
  const setSourceLanguage = useTranslateStore((s) => s.setSourceLanguage)
  const setTargetLanguage = useTranslateStore((s) => s.setTargetLanguage)
  const swapLanguages = useTranslateStore((s) => s.swapLanguages)
  const setSourceText = useTranslateStore((s) => s.setSourceText)
  const setOverrideModel = useTranslateStore((s) => s.setOverrideModel)
  const setAgentMode = useTranslateStore((s) => s.setAgentMode)
  const selectFile = useTranslateStore((s) => s.selectFile)
  const clearSelectedFile = useTranslateStore((s) => s.clearSelectedFile)
  const translate = useTranslateStore((s) => s.translate)
  const stopTranslation = useTranslateStore((s) => s.stopTranslation)
  const clearAll = useTranslateStore((s) => s.clearAll)

  const closeTranslatePage = useUIStore((s) => s.closeTranslatePage)
  const openSettingsPage = useUIStore((s) => s.openSettingsPage)

  const providers = useProviderStore((s) => s.providers)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const activeTranslationProviderId = useProviderStore((s) => s.activeTranslationProviderId)
  const activeTranslationModelId = useProviderStore((s) => s.activeTranslationModelId)

  const sourceLanguageOptions = useMemo<LanguageOption[]>(
    () => [
      { value: 'auto', label: t('translatePage.language.auto') },
      { value: 'zh', label: t('translatePage.language.zh') },
      { value: 'en', label: t('translatePage.language.en') },
      { value: 'ja', label: t('translatePage.language.ja') },
      { value: 'ko', label: t('translatePage.language.ko') },
      { value: 'fr', label: t('translatePage.language.fr') },
      { value: 'de', label: t('translatePage.language.de') },
      { value: 'es', label: t('translatePage.language.es') },
      { value: 'pt', label: t('translatePage.language.pt') },
      { value: 'ru', label: t('translatePage.language.ru') },
      { value: 'ar', label: t('translatePage.language.ar') }
    ],
    [t]
  )

  const targetLanguageOptions = useMemo(
    () => sourceLanguageOptions.filter((option) => option.value !== 'auto'),
    [sourceLanguageOptions]
  )

  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled),
    [providers]
  )

  const providerModelGroups = useMemo(
    () =>
      enabledProviders
        .map((provider) => ({
          provider,
          models: provider.models.filter((model) => model.enabled)
        }))
        .filter((group) => group.models.length > 0),
    [enabledProviders]
  )

  const hasAnyEnabledModel = providerModelGroups.length > 0

  const defaultProviderId = activeTranslationProviderId ?? activeProviderId
  const defaultModelId = activeTranslationModelId || activeModelId

  const effectiveProviderId = overrideProviderId ?? defaultProviderId
  const effectiveModelId = overrideModelId ?? defaultModelId

  const effectiveProvider =
    providers.find((provider) => provider.id === effectiveProviderId) ?? null
  const effectiveModel =
    effectiveProvider?.models.find((model) => model.id === effectiveModelId) ?? null

  const isUsingOverride = Boolean(overrideProviderId && overrideModelId)

  const sourceCharacters = sourceText.length

  const handleTranslate = (): void => {
    void translate()
  }

  const handleCopyResult = async (): Promise<void> => {
    if (!translatedText.trim()) return
    await navigator.clipboard.writeText(translatedText)
    toast.success(t('translatePage.copied'))
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-3 border-b px-4 py-2.5 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={closeTranslatePage}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <ArrowLeft className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('translatePage.back')}</TooltipContent>
        </Tooltip>

        <div className="min-w-0">
          <h2 className="text-sm font-semibold leading-none">{t('translatePage.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('translatePage.subtitle')}</p>
        </div>

        <div className="flex-1" />

        {/* Mode toggle */}
        <div className="flex items-center rounded-md border bg-muted/30 p-0.5 gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setAgentMode(false)}
                className={cn(
                  'flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors',
                  !agentMode
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Zap className="size-3" />
                {t('translatePage.modeSimple')}
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('translatePage.modeSimpleDesc')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setAgentMode(true)}
                className={cn(
                  'flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors',
                  agentMode
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Bot className="size-3" />
                {t('translatePage.modeAgent')}
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('translatePage.modeAgentDesc')}</TooltipContent>
          </Tooltip>
        </div>

        <Popover open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
          <PopoverTrigger asChild>
            <button
              className="inline-flex max-w-[320px] items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/40"
              disabled={!hasAnyEnabledModel}
            >
              <ModelIcon
                icon={effectiveModel?.icon}
                modelId={effectiveModel?.id || ''}
                providerBuiltinId={effectiveProvider?.builtinId}
                size={14}
                className="opacity-80"
              />
              <span className="truncate">
                {effectiveModel?.name || effectiveModel?.id || t('translatePage.noModel')}
              </span>
              <ChevronDown className="size-3.5 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-1 max-h-80 overflow-y-auto" align="end">
            {!hasAnyEnabledModel ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {t('translatePage.noModels')}
              </div>
            ) : (
              <div className="space-y-1">
                {isUsingOverride && (
                  <button
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/60"
                    onClick={() => {
                      setOverrideModel(null, null)
                      setModelPickerOpen(false)
                    }}
                  >
                    <Check className="size-3 text-primary" />
                    <span>{t('translatePage.useDefaultModel')}</span>
                  </button>
                )}

                {providerModelGroups.map(({ provider, models }) => (
                  <div key={provider.id}>
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                      <ProviderIcon builtinId={provider.builtinId} size={12} />
                      {provider.name}
                    </div>
                    {models.map((model) => {
                      const isActive =
                        provider.id === effectiveProviderId && model.id === effectiveModelId
                      return (
                        <button
                          key={`${provider.id}-${model.id}`}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted/60 transition-colors',
                            isActive && 'bg-muted/40 font-medium'
                          )}
                          onClick={() => {
                            setOverrideModel(provider.id, model.id)
                            setModelPickerOpen(false)
                          }}
                        >
                          {isActive ? (
                            <Check className="size-3 text-primary" />
                          ) : (
                            <ModelIcon
                              icon={model.icon}
                              modelId={model.id}
                              providerBuiltinId={provider.builtinId}
                              size={12}
                              className="opacity-60"
                            />
                          )}
                          <span className="truncate">{model.name || model.id}</span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {!hasAnyEnabledModel ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md rounded-xl border border-dashed p-6 text-center space-y-3">
            <p className="text-sm text-muted-foreground">{t('translatePage.noProviders')}</p>
            <Button
              variant="outline"
              size="sm"
              className="text-xs gap-1.5"
              onClick={() => openSettingsPage('provider')}
            >
              <Settings className="size-3.5" />
              {t('translatePage.openProviderSettings')}
            </Button>
          </div>
        </div>
      ) : agentMode ? (
        /* ── AGENT MODE UI ─────────────────────────────────────────── */
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left: agent timeline */}
          <div className="flex w-52 shrink-0 flex-col border-r bg-muted/5">
            {/* Status badge */}
            <div className="flex items-center justify-between border-b px-3 py-2.5 shrink-0">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                {t('translatePage.agentSteps')}
              </span>
              {isTranslating ? (
                <Badge variant="secondary" className="gap-1 text-[10px] py-0 px-1.5">
                  <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {t('translatePage.agentRunning')}
                </Badge>
              ) : agentSteps.length > 0 ? (
                <Badge variant="secondary" className="gap-1 text-[10px] py-0 px-1.5">
                  <CircleCheck className="size-3 text-emerald-500" />
                  {t('translatePage.agentDone')}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] py-0 px-1.5 text-muted-foreground">
                  {t('translatePage.agentIdle')}
                </Badge>
              )}
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2">
              <AgentTimeline steps={agentSteps} isRunning={isTranslating} />
            </div>
          </div>

          {/* Center: source + output stacked */}
          <div className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden">
            {/* Language bar */}
            <div className="flex items-center gap-2 border-b bg-muted/10 px-4 py-2 shrink-0">
              <Select value={sourceLanguage} onValueChange={setSourceLanguage}>
                <SelectTrigger className="h-7 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sourceLanguageOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className="text-xs">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={swapLanguages}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted"
                  >
                    <ArrowLeftRight className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t('translatePage.swapLanguages')}</TooltipContent>
              </Tooltip>
              <Select value={targetLanguage} onValueChange={setTargetLanguage}>
                <SelectTrigger className="h-7 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targetLanguageOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className="text-xs">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={clearAll}
                disabled={!sourceText && !translatedText}
              >
                {t('translatePage.clear')}
              </Button>
            </div>

            {/* Source panel */}
            <div className="flex flex-col border-b overflow-hidden" style={{ flex: '0 0 40%', minHeight: 0 }}>
              <div className="flex items-center justify-between px-4 py-2 shrink-0 border-b bg-muted/5">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                  {t('translatePage.agentSourceLabel')}
                </span>
                <span className="text-[11px] text-muted-foreground/50">
                  {t('translatePage.characters', { count: sourceCharacters })}
                </span>
              </div>
              {/* File drop-zone */}
              <div className="shrink-0 px-3 pt-2">
                <FileDropZone
                  fileName={selectedFileName}
                  onSelect={() => void selectFile()}
                  onClear={clearSelectedFile}
                  disabled={isTranslating}
                />
              </div>
              <div className="flex-1 overflow-auto px-3 pb-2 pt-1 min-h-0">
                <Textarea
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                  placeholder={t('translatePage.inputPlaceholder')}
                  className="h-full min-h-[80px] resize-none border-0 p-0 shadow-none focus-visible:ring-0 text-sm"
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isTranslating) {
                      e.preventDefault()
                      handleTranslate()
                    }
                  }}
                />
              </div>
            </div>

            {/* Output panel */}
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 shrink-0 border-b bg-muted/5">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                  {t('translatePage.agentOutputLabel')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => void handleCopyResult()}
                  disabled={!translatedText.trim()}
                >
                  <Copy className="mr-1 size-3" />
                  {t('translatePage.copy')}
                </Button>
              </div>
              <div className="flex-1 overflow-auto p-3">
                {translatedText ? (
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">
                    {translatedText}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/10">
                    {isTranslating ? (
                      <div className="flex flex-col items-center gap-2 text-muted-foreground/60">
                        <Loader2 className="size-5 animate-spin" />
                        <span className="text-xs">{t('translatePage.agentTranslating')}</span>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2 text-muted-foreground/40">
                        <Bot className="size-6" />
                        <span className="text-xs">{t('translatePage.outputPlaceholder')}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Action bar */}
            <div className="flex items-center justify-between border-t px-4 py-2.5 shrink-0 bg-muted/5">
              <p className="text-xs text-muted-foreground/60">{t('translatePage.aiOnlyNotice')}</p>
              {isTranslating ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  onClick={stopTranslation}
                >
                  <Square className="size-3.5" />
                  {t('translatePage.stop')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  onClick={handleTranslate}
                  disabled={!sourceText.trim()}
                >
                  <Bot className="size-3.5" />
                  {t('translatePage.translate')}
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* ── SIMPLE MODE UI ────────────────────────────────────────── */
        <>
          <div className="flex items-center gap-3 border-b px-4 py-2.5 shrink-0 bg-muted/10">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-xs text-muted-foreground">
                {t('translatePage.source')}
              </span>
              <Select value={sourceLanguage} onValueChange={setSourceLanguage}>
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sourceLanguageOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value} className="text-xs">
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={swapLanguages}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <ArrowLeftRight className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t('translatePage.swapLanguages')}</TooltipContent>
            </Tooltip>

            <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
              <span className="shrink-0 text-xs text-muted-foreground">
                {t('translatePage.target')}
              </span>
              <Select value={targetLanguage} onValueChange={setTargetLanguage}>
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targetLanguageOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value} className="text-xs">
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-1 overflow-hidden">
            <div className="flex w-1/2 min-w-0 flex-col border-r">
              <div className="flex items-center justify-between border-b px-4 py-2 shrink-0">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('translatePage.input')}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground/70">
                    {t('translatePage.characters', { count: sourceCharacters })}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={clearAll}
                    disabled={!sourceText && !translatedText}
                  >
                    {t('translatePage.clear')}
                  </Button>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-4">
                <Textarea
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                  placeholder={t('translatePage.inputPlaceholder')}
                  className="h-full min-h-[280px] resize-none border-0 p-0 shadow-none focus-visible:ring-0"
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isTranslating) {
                      e.preventDefault()
                      handleTranslate()
                    }
                  }}
                />
              </div>
            </div>

            <div className="flex w-1/2 min-w-0 flex-col">
              <div className="flex items-center justify-between border-b px-4 py-2 shrink-0">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('translatePage.output')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => void handleCopyResult()}
                  disabled={!translatedText.trim()}
                >
                  <Copy className="mr-1 size-3" />
                  {t('translatePage.copy')}
                </Button>
              </div>
              <div className="flex-1 overflow-auto p-4">
                {translatedText ? (
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">
                    {translatedText}
                  </div>
                ) : (
                  <div className="h-full rounded-lg border border-dashed border-border/70 bg-muted/15 p-6 text-sm text-muted-foreground/70">
                    {isTranslating ? (
                      <div className="inline-flex items-center gap-2">
                        <Loader2 className="size-4 animate-spin" />
                        {t('translatePage.translating')}
                      </div>
                    ) : (
                      <div className="inline-flex items-center gap-2">
                        <Sparkles className="size-4" />
                        {t('translatePage.outputPlaceholder')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between border-t px-4 py-2.5 shrink-0">
            <p className="text-xs text-muted-foreground">{t('translatePage.aiOnlyNotice')}</p>
            <div className="flex items-center gap-2">
              {isTranslating ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  onClick={stopTranslation}
                >
                  <Square className="size-3.5" />
                  {t('translatePage.stop')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  onClick={handleTranslate}
                  disabled={!sourceText.trim()}
                >
                  <Sparkles className="size-3.5" />
                  {t('translatePage.translate')}
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
