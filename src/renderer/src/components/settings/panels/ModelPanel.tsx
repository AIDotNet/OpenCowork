import { useTranslation } from 'react-i18next'
import { Input } from '@renderer/components/ui/input'
import { Slider } from '@renderer/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { useSettingsStore } from '@renderer/stores/settings-store'
import {
  isProviderAvailableForModelSelection,
  useProviderStore
} from '@renderer/stores/provider-store'
import { ModelIcon, ProviderIcon } from '../provider-icons'
import { SettingsPanel, SettingsSection } from '../settings-primitives'

export function ModelPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const providers = useProviderStore((s) => s.providers)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const activeFastModelId = useProviderStore((s) => s.activeFastModelId)
  const activeFastProviderId = useProviderStore((s) => s.activeFastProviderId)
  const activeTranslationProviderId = useProviderStore((s) => s.activeTranslationProviderId)
  const activeTranslationModelId = useProviderStore((s) => s.activeTranslationModelId)
  const activeSpeechProviderId = useProviderStore((s) => s.activeSpeechProviderId)
  const activeSpeechModelId = useProviderStore((s) => s.activeSpeechModelId)
  const activeImageProviderId = useProviderStore((s) => s.activeImageProviderId)
  const activeImageModelId = useProviderStore((s) => s.activeImageModelId)
  const setActiveProvider = useProviderStore((s) => s.setActiveProvider)
  const setActiveModel = useProviderStore((s) => s.setActiveModel)
  const setActiveFastModel = useProviderStore((s) => s.setActiveFastModel)
  const setActiveFastProvider = useProviderStore((s) => s.setActiveFastProvider)
  const setActiveTranslationProvider = useProviderStore((s) => s.setActiveTranslationProvider)
  const setActiveTranslationModel = useProviderStore((s) => s.setActiveTranslationModel)
  const setActiveSpeechProvider = useProviderStore((s) => s.setActiveSpeechProvider)
  const setActiveSpeechModel = useProviderStore((s) => s.setActiveSpeechModel)
  const setActiveImageProvider = useProviderStore((s) => s.setActiveImageProvider)
  const setActiveImageModel = useProviderStore((s) => s.setActiveImageModel)

  const enabledProviders = providers.filter((p) => isProviderAvailableForModelSelection(p))
  const chatProviderGroups = enabledProviders
    .map((provider) => ({
      provider,
      models: provider.models.filter(
        (model) => model.enabled && (!model.category || model.category === 'chat')
      )
    }))
    .filter((group) => group.models.length > 0)
  const imageProviderGroups = enabledProviders
    .map((provider) => ({
      provider,
      models: provider.models.filter((model) => model.enabled && model.category === 'image')
    }))
    .filter((group) => group.models.length > 0)

  const activeProvider =
    chatProviderGroups.find(({ provider }) => provider.id === activeProviderId)?.provider ?? null
  const fastProvider =
    chatProviderGroups.find(
      ({ provider }) => provider.id === (activeFastProviderId ?? activeProviderId)
    )?.provider ?? activeProvider
  const fastProviderEnabledModels =
    fastProvider?.models.filter((m) => m.enabled && (!m.category || m.category === 'chat')) ?? []

  const hasAnyEnabledModel = chatProviderGroups.length > 0
  const hasImageModels = imageProviderGroups.length > 0
  const buildModelValue = (providerId: string, modelId: string): string =>
    `${providerId}::${modelId}`
  const parseModelValue = (value: string): { providerId: string; modelId: string } | null => {
    const [providerId, modelId] = value.split('::')
    if (!providerId || !modelId) return null
    return { providerId, modelId }
  }
  const recommendationModeDefs: Array<{
    mode: keyof typeof settings.promptRecommendationModels
    labelKey: string
    descKey: string
  }> = [
    {
      mode: 'clarify',
      labelKey: 'model.promptRecommendationModes.clarify',
      descKey: 'model.promptRecommendationModesDesc.clarify'
    },
    {
      mode: 'cowork',
      labelKey: 'model.promptRecommendationModes.cowork',
      descKey: 'model.promptRecommendationModesDesc.cowork'
    },
    {
      mode: 'code',
      labelKey: 'model.promptRecommendationModes.code',
      descKey: 'model.promptRecommendationModesDesc.code'
    },
    {
      mode: 'acp',
      labelKey: 'model.promptRecommendationModes.acp',
      descKey: 'model.promptRecommendationModesDesc.acp'
    }
  ]
  const updatePromptRecommendationModel = (
    mode: keyof typeof settings.promptRecommendationModels,
    value: string
  ): void => {
    settings.updateSettings({
      promptRecommendationModels: {
        ...settings.promptRecommendationModels,
        [mode]:
          value === '__fast__'
            ? null
            : value === '__disabled__'
              ? 'disabled'
              : parseModelValue(value)
      }
    })
  }

  const activeModelValue =
    activeProvider && activeModelId ? buildModelValue(activeProvider.id, activeModelId) : ''
  const newSessionDefaultModelValue = settings.newSessionDefaultModel
    ? settings.newSessionDefaultModel.useGlobalActiveModel
      ? '__global__'
      : buildModelValue(
          settings.newSessionDefaultModel.providerId,
          settings.newSessionDefaultModel.modelId
        )
    : '__global__'
  const translationProvider =
    chatProviderGroups.find(
      ({ provider }) => provider.id === (activeTranslationProviderId ?? activeProviderId)
    )?.provider ?? activeProvider
  const translationProviderEnabledModels =
    translationProvider?.models.filter(
      (m) => m.enabled && (!m.category || m.category === 'chat')
    ) ?? []
  const speechProvider = providers.find((p) => p.id === activeSpeechProviderId)
  const activeSpeechModelValue =
    speechProvider && activeSpeechModelId
      ? buildModelValue(speechProvider.id, activeSpeechModelId)
      : ''
  const imageProvider = providers.find((p) => p.id === activeImageProviderId)
  const activeImageModelValue =
    imageProvider && activeImageModelId ? buildModelValue(imageProvider.id, activeImageModelId) : ''

  const speechProviderGroups = chatProviderGroups
    .filter(
      ({ provider }) => provider.type === 'openai-chat' || provider.type === 'openai-responses'
    )
    .map(({ provider, models }) => ({
      provider,
      models: models.filter((m) => m.category === 'speech')
    }))
    .filter(({ models }) => models.length > 0)
  const hasSpeechModels = speechProviderGroups.length > 0

  const noProviders = enabledProviders.length === 0

  return (
    <SettingsPanel title={t('model.title')} description={t('model.subtitle')}>
      {noProviders ? (
        <div className="rounded-lg border border-dashed p-6 text-center space-y-2">
          <p className="text-sm text-muted-foreground">{t('model.noProviders')}</p>
          <p className="text-xs text-muted-foreground/60">{t('model.noProvidersHint')}</p>
        </div>
      ) : (
        <>
          <SettingsSection
            id="chat-models"
            title={t('model.sections.chat')}
            description={t('model.sections.chatDesc')}
          >
            {/* New Session Default Model */}
            <section className="space-y-3">
              <div>
                <label className="text-sm font-medium">
                  {t('model.newSessionDefaultModel.title')}
                </label>
                <p className="text-xs text-muted-foreground">
                  {t('model.newSessionDefaultModel.desc')}
                </p>
              </div>
              {hasAnyEnabledModel ? (
                <Select
                  value={newSessionDefaultModelValue}
                  onValueChange={(value) => {
                    if (value === '__global__') {
                      settings.updateSettings({
                        newSessionDefaultModel: {
                          providerId: activeProviderId ?? '',
                          modelId: activeModelId ?? '',
                          useGlobalActiveModel: true
                        }
                      })
                      return
                    }
                    const parsed = parseModelValue(value)
                    if (!parsed) return
                    settings.updateSettings({
                      newSessionDefaultModel: {
                        providerId: parsed.providerId,
                        modelId: parsed.modelId,
                        useGlobalActiveModel: false
                      }
                    })
                  }}
                >
                  <SelectTrigger className="w-80 text-xs">
                    <SelectValue placeholder={t('model.newSessionDefaultModel.placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__global__" className="text-xs">
                      {t('model.newSessionDefaultModel.followGlobalActiveModel')}
                    </SelectItem>
                    {chatProviderGroups.map(({ provider, models }) => (
                      <SelectGroup key={`${provider.id}-new-session-default`}>
                        <SelectLabel className="text-[10px] uppercase tracking-wide">
                          {provider.name}
                        </SelectLabel>
                        {models.map((m) => (
                          <SelectItem
                            key={`${provider.id}-new-session-${m.id}`}
                            value={buildModelValue(provider.id, m.id)}
                            className="text-xs"
                          >
                            <div className="flex items-center gap-2">
                              <ModelIcon
                                icon={m.icon}
                                modelId={m.id}
                                providerBuiltinId={provider.builtinId}
                                size={16}
                                className="text-muted-foreground/70"
                              />
                              <div className="flex flex-col text-left">
                                <span>{m.name}</span>
                                <span className="text-[10px] text-muted-foreground/60">{m.id}</span>
                              </div>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
              )}
            </section>

            {/* Main Model */}
            <section className="space-y-3">
              <div>
                <label className="text-sm font-medium">{t('model.mainModel')}</label>
                <p className="text-xs text-muted-foreground">{t('model.mainModelDesc')}</p>
              </div>
              {hasAnyEnabledModel ? (
                <div className="space-y-2">
                  <Select
                    value={activeModelValue}
                    onValueChange={(value) => {
                      const parsed = parseModelValue(value)
                      if (!parsed) return
                      if (parsed.providerId !== activeProviderId) {
                        setActiveProvider(parsed.providerId)
                      }
                      setActiveModel(parsed.modelId)
                    }}
                  >
                    <SelectTrigger className="w-80 text-xs">
                      <SelectValue placeholder={t('model.selectModel')} />
                    </SelectTrigger>
                    <SelectContent>
                      {chatProviderGroups.map(({ provider, models }) => (
                        <SelectGroup key={provider.id}>
                          <SelectLabel className="text-[10px] uppercase tracking-wide">
                            {provider.name}
                          </SelectLabel>
                          {models.map((m) => (
                            <SelectItem
                              key={`${provider.id}-${m.id}`}
                              value={buildModelValue(provider.id, m.id)}
                              className="text-xs"
                            >
                              <div className="flex items-center gap-2">
                                <ModelIcon
                                  icon={m.icon}
                                  modelId={m.id}
                                  providerBuiltinId={provider.builtinId}
                                  size={16}
                                  className="text-muted-foreground/70"
                                />
                                <div className="flex flex-col text-left">
                                  <span>{m.name}</span>
                                  <span className="text-[10px] text-muted-foreground/60">
                                    {m.id}
                                  </span>
                                </div>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
              )}
            </section>

            {/* Fast Model */}
            <section className="space-y-3">
              <div>
                <label className="text-sm font-medium">{t('model.fastModel')}</label>
                <p className="text-xs text-muted-foreground">{t('model.fastModelDesc')}</p>
              </div>
              {chatProviderGroups.length > 0 ? (
                <div className="space-y-2">
                  <Select
                    value={fastProvider?.id ?? ''}
                    onValueChange={(value) => setActiveFastProvider(value)}
                  >
                    <SelectTrigger className="w-80 text-xs">
                      <SelectValue placeholder={t('model.selectProvider')} />
                    </SelectTrigger>
                    <SelectContent>
                      {chatProviderGroups.map(({ provider }) => (
                        <SelectItem key={provider.id} value={provider.id} className="text-xs">
                          <span className="flex items-center gap-2">
                            <ProviderIcon builtinId={provider.builtinId} size={14} />
                            {provider.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {fastProviderEnabledModels.length > 0 ? (
                    <Select
                      value={activeFastModelId || fastProviderEnabledModels[0]?.id || ''}
                      onValueChange={(v) => setActiveFastModel(v)}
                    >
                      <SelectTrigger className="w-80 text-xs">
                        <SelectValue placeholder={t('model.selectFastModel')} />
                      </SelectTrigger>
                      <SelectContent>
                        {fastProviderEnabledModels.map((m) => (
                          <SelectItem key={m.id} value={m.id} className="text-xs">
                            <div className="flex items-center gap-2">
                              <ModelIcon
                                icon={m.icon}
                                modelId={m.id}
                                providerBuiltinId={fastProvider?.builtinId}
                                size={16}
                                className="text-muted-foreground/70"
                              />
                              <div className="flex flex-col">
                                <span>{m.name}</span>
                                <span className="text-[10px] text-muted-foreground/60">{m.id}</span>
                              </div>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
              )}
            </section>
          </SettingsSection>

          <SettingsSection
            id="prompt-recommendation"
            title={t('model.promptRecommendationTitle')}
            description={t('model.promptRecommendationDesc')}
          >
            {chatProviderGroups.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2">
                {recommendationModeDefs.map(({ mode, labelKey, descKey }) => {
                  const binding = settings.promptRecommendationModels[mode]
                  const value =
                    binding === 'disabled'
                      ? '__disabled__'
                      : binding
                        ? buildModelValue(binding.providerId, binding.modelId)
                        : '__fast__'
                  return (
                    <div key={mode} className="rounded-lg border p-3 space-y-2">
                      <div>
                        <p className="text-sm font-medium">{t(labelKey)}</p>
                        <p className="text-xs text-muted-foreground">{t(descKey)}</p>
                      </div>
                      <Select
                        value={value}
                        onValueChange={(nextValue) =>
                          updatePromptRecommendationModel(mode, nextValue)
                        }
                      >
                        <SelectTrigger className="w-full text-xs">
                          <SelectValue placeholder={t('model.selectRecommendationModel')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__fast__" className="text-xs">
                            {t('model.useFastModelRecommendation')}
                          </SelectItem>
                          <SelectItem value="__disabled__" className="text-xs">
                            {t('model.disableRecommendation')}
                          </SelectItem>
                          {chatProviderGroups.map(({ provider, models }) => (
                            <SelectGroup key={`${provider.id}-recommendation-${mode}`}>
                              <SelectLabel className="text-[10px] uppercase tracking-wide">
                                {provider.name}
                              </SelectLabel>
                              {models.map((m) => (
                                <SelectItem
                                  key={`${provider.id}-${mode}-${m.id}`}
                                  value={buildModelValue(provider.id, m.id)}
                                  className="text-xs"
                                >
                                  <div className="flex items-center gap-2">
                                    <ModelIcon
                                      icon={m.icon}
                                      modelId={m.id}
                                      providerBuiltinId={provider.builtinId}
                                      size={16}
                                      className="text-muted-foreground/70"
                                    />
                                    <div className="flex flex-col text-left">
                                      <span>{m.name}</span>
                                      <span className="text-[10px] text-muted-foreground/60">
                                        {m.id}
                                      </span>
                                    </div>
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
            )}
          </SettingsSection>

          <SettingsSection
            id="aux-models"
            title={t('model.sections.auxiliary')}
            description={t('model.sections.auxiliaryDesc')}
          >
            {/* Translation Model */}
            <section className="space-y-3">
              <div>
                <label className="text-sm font-medium">{t('model.translationModel')}</label>
                <p className="text-xs text-muted-foreground">{t('model.translationModelDesc')}</p>
              </div>
              {chatProviderGroups.length > 0 ? (
                <div className="space-y-2">
                  <Select
                    value={translationProvider?.id ?? ''}
                    onValueChange={(value) => setActiveTranslationProvider(value)}
                  >
                    <SelectTrigger className="w-80 text-xs">
                      <SelectValue placeholder={t('model.selectProvider')} />
                    </SelectTrigger>
                    <SelectContent>
                      {chatProviderGroups.map(({ provider }) => (
                        <SelectItem
                          key={`${provider.id}-translation-provider`}
                          value={provider.id}
                          className="text-xs"
                        >
                          <span className="flex items-center gap-2">
                            <ProviderIcon builtinId={provider.builtinId} size={14} />
                            {provider.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {translationProviderEnabledModels.length > 0 ? (
                    <Select
                      value={
                        activeTranslationModelId || translationProviderEnabledModels[0]?.id || ''
                      }
                      onValueChange={(value) => setActiveTranslationModel(value)}
                    >
                      <SelectTrigger className="w-80 text-xs">
                        <SelectValue placeholder={t('model.selectTranslationModel')} />
                      </SelectTrigger>
                      <SelectContent>
                        {translationProviderEnabledModels.map((m) => (
                          <SelectItem
                            key={`translation-model-${m.id}`}
                            value={m.id}
                            className="text-xs"
                          >
                            <div className="flex items-center gap-2">
                              <ModelIcon
                                icon={m.icon}
                                modelId={m.id}
                                providerBuiltinId={translationProvider?.builtinId}
                                size={16}
                                className="text-muted-foreground/70"
                              />
                              <div className="flex flex-col text-left">
                                <span>{m.name}</span>
                                <span className="text-[10px] text-muted-foreground/60">{m.id}</span>
                              </div>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
              )}
            </section>

            {/* Image Model */}
            <section className="space-y-3">
              <div>
                <label className="text-sm font-medium">{t('model.imageModel')}</label>
                <p className="text-xs text-muted-foreground">{t('model.imageModelDesc')}</p>
              </div>
              {hasImageModels ? (
                <Select
                  value={activeImageModelValue}
                  onValueChange={(value) => {
                    const parsed = parseModelValue(value)
                    if (!parsed) return
                    setActiveImageProvider(parsed.providerId)
                    setActiveImageModel(parsed.modelId)
                  }}
                >
                  <SelectTrigger className="w-80 text-xs">
                    <SelectValue placeholder={t('model.selectImageModel')} />
                  </SelectTrigger>
                  <SelectContent>
                    {imageProviderGroups.map(({ provider, models }) => (
                      <SelectGroup key={`${provider.id}-image`}>
                        <SelectLabel className="text-[10px] uppercase tracking-wide">
                          {provider.name}
                        </SelectLabel>
                        {models.map((m) => (
                          <SelectItem
                            key={`${provider.id}-image-${m.id}`}
                            value={buildModelValue(provider.id, m.id)}
                            className="text-xs"
                          >
                            <div className="flex items-center gap-2">
                              <ModelIcon
                                icon={m.icon}
                                modelId={m.id}
                                providerBuiltinId={provider.builtinId}
                                size={16}
                                className="text-muted-foreground/70"
                              />
                              <div className="flex flex-col text-left">
                                <span>{m.name}</span>
                                <span className="text-[10px] text-muted-foreground/60">{m.id}</span>
                              </div>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground/60">{t('model.noImageModels')}</p>
              )}
            </section>

            {/* Speech Model */}
            <section className="space-y-3">
              <div>
                <label className="text-sm font-medium">{t('model.speechModel')}</label>
                <p className="text-xs text-muted-foreground">{t('model.speechModelDesc')}</p>
              </div>
              {hasSpeechModels ? (
                <Select
                  value={activeSpeechModelValue}
                  onValueChange={(value) => {
                    const parsed = parseModelValue(value)
                    if (!parsed) return
                    setActiveSpeechProvider(parsed.providerId)
                    setActiveSpeechModel(parsed.modelId)
                  }}
                >
                  <SelectTrigger className="w-80 text-xs">
                    <SelectValue placeholder={t('model.selectSpeechModel')} />
                  </SelectTrigger>
                  <SelectContent>
                    {speechProviderGroups.map(({ provider, models }) => (
                      <SelectGroup key={`${provider.id}-speech`}>
                        <SelectLabel className="text-[10px] uppercase tracking-wide">
                          {provider.name}
                        </SelectLabel>
                        {models.map((m) => (
                          <SelectItem
                            key={`${provider.id}-speech-${m.id}`}
                            value={buildModelValue(provider.id, m.id)}
                            className="text-xs"
                          >
                            <div className="flex items-center gap-2">
                              <ModelIcon
                                icon={m.icon}
                                modelId={m.id}
                                providerBuiltinId={provider.builtinId}
                                size={16}
                                className="text-muted-foreground/70"
                              />
                              <div className="flex flex-col text-left">
                                <span>{m.name}</span>
                                <span className="text-[10px] text-muted-foreground/60">{m.id}</span>
                              </div>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground/60">
                  {t('model.speechModelNoProviders')}
                </p>
              )}
            </section>
          </SettingsSection>
        </>
      )}

      <SettingsSection
        id="sampling"
        title={t('model.sections.sampling')}
        description={t('model.sections.samplingDesc')}
      >
        {/* Temperature */}
        <section className="space-y-3">
          <div className="flex items-center justify-between max-w-lg">
            <div>
              <label className="text-sm font-medium">{t('model.temperature')}</label>
              <p className="text-xs text-muted-foreground">{t('model.temperatureDesc')}</p>
            </div>
            <span className="text-sm font-mono text-muted-foreground">{settings.temperature}</span>
          </div>
          <Slider
            value={[settings.temperature]}
            onValueChange={([v]) => settings.updateSettings({ temperature: v })}
            min={0}
            max={1}
            step={0.1}
            className="max-w-lg"
          />
          <div className="flex items-center justify-between max-w-lg">
            {[
              { v: 0, label: t('model.precise') },
              { v: 0.3, label: t('model.balanced') },
              { v: 0.7, label: t('model.creative') },
              { v: 1, label: t('model.random') }
            ].map(({ v, label }) => (
              <button
                key={v}
                onClick={() => settings.updateSettings({ temperature: v })}
                className={`text-[10px] transition-colors ${settings.temperature === v ? 'text-foreground font-medium' : 'text-muted-foreground/50 hover:text-muted-foreground'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        {/* Max Tokens */}
        <section className="space-y-3">
          <div>
            <label className="text-sm font-medium">{t('model.maxTokens')}</label>
            <p className="text-xs text-muted-foreground">{t('model.maxTokensDesc')}</p>
          </div>
          <Input
            type="number"
            value={settings.maxTokens}
            onChange={(e) =>
              settings.updateSettings({ maxTokens: parseInt(e.target.value) || 32000 })
            }
            className="max-w-60"
          />
          <div className="flex items-center gap-1">
            {[8192, 16384, 32000, 64000, 128000].map((v) => (
              <button
                key={v}
                onClick={() => settings.updateSettings({ maxTokens: v })}
                className={`rounded px-2 py-0.5 text-[10px] transition-colors ${settings.maxTokens === v ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
              >
                {v >= 1000 ? `${Math.round(v / 1024)}K` : v}
              </button>
            ))}
          </div>
        </section>
      </SettingsSection>
    </SettingsPanel>
  )
}
