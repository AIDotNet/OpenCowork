import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bot, Loader2, Play, RotateCcw, Sparkles, Volume2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import {
  PET_PROACTIVE_DAILY_CAP,
  usePetAgentStore,
  type PetProactiveFreq,
  type PetVoiceMode
} from '@renderer/stores/pet-agent-store'
import { PET_VOICE_PRESETS, playPetVoice } from '@renderer/lib/pet/pet-voice'
import { usePetStore } from '@renderer/stores/pet-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { BUILTIN_PET_PROMPT } from '@renderer/lib/pet/pet-agent'

const PROJECT_NONE = '__none__'
const VOICE_DEFAULT = '__default__'
const VOICE_CUSTOM = '__custom__'
const ALL_VOICE_PRESETS = [...PET_VOICE_PRESETS.openai, ...PET_VOICE_PRESETS.mimo]

function toOptionValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

function fromOptionValue(value: string): [string, string] {
  const index = value.indexOf('::')
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 2)]
}

export function PetAgentTab(): React.JSX.Element {
  const { t } = useTranslation('pet')
  const providers = useProviderStore((s) => s.providers)
  const projects = useChatStore((s) => s.projects)

  const providerId = usePetAgentStore((s) => s.providerId)
  const modelId = usePetAgentStore((s) => s.modelId)
  const systemPrompt = usePetAgentStore((s) => s.systemPrompt)
  const projectId = usePetAgentStore((s) => s.projectId)
  const proactive = usePetAgentStore((s) => s.proactive)
  const proactiveFreq = usePetAgentStore((s) => s.proactiveFreq)
  const quietStart = usePetAgentStore((s) => s.quietStart)
  const quietEnd = usePetAgentStore((s) => s.quietEnd)

  const [selection, setSelection] = useState(
    providerId && modelId ? toOptionValue(providerId, modelId) : ''
  )
  const [promptDraft, setPromptDraft] = useState(systemPrompt)
  const [projectDraft, setProjectDraft] = useState(projectId ?? PROJECT_NONE)
  const [proactiveDraft, setProactiveDraft] = useState(proactive)
  const [freqDraft, setFreqDraft] = useState<PetProactiveFreq>(proactiveFreq)
  const [quietStartDraft, setQuietStartDraft] = useState(String(quietStart))
  const [quietEndDraft, setQuietEndDraft] = useState(String(quietEnd))

  const voiceEnabled = usePetAgentStore((s) => s.voiceEnabled)
  const voiceProviderId = usePetAgentStore((s) => s.voiceProviderId)
  const voiceModelId = usePetAgentStore((s) => s.voiceModelId)
  const voice = usePetAgentStore((s) => s.voice)
  const voiceMode = usePetAgentStore((s) => s.voiceMode)
  const voiceInstruction = usePetAgentStore((s) => s.voiceInstruction)

  const [voiceEnabledDraft, setVoiceEnabledDraft] = useState(voiceEnabled)
  const [voiceSelection, setVoiceSelection] = useState(
    voiceProviderId && voiceModelId ? toOptionValue(voiceProviderId, voiceModelId) : ''
  )
  const [voiceDraft, setVoiceDraft] = useState(voice)
  const [voiceCustom, setVoiceCustom] = useState(voice !== '' && !ALL_VOICE_PRESETS.includes(voice))
  const voiceTag = usePetAgentStore((s) => s.voiceTag)
  const [voiceModeDraft, setVoiceModeDraft] = useState<PetVoiceMode>(voiceMode)
  const [voiceInstructionDraft, setVoiceInstructionDraft] = useState(voiceInstruction)
  const [voiceTagDraft, setVoiceTagDraft] = useState(voiceTag)
  const [voiceTesting, setVoiceTesting] = useState(false)

  const chatModelGroups = useMemo(
    () =>
      providers
        .filter((provider) => provider.enabled)
        .map((provider) => ({
          provider,
          models: provider.models.filter(
            (model) => model.enabled && (model.category ?? 'chat') === 'chat'
          )
        }))
        .filter((group) => group.models.length > 0),
    [providers]
  )

  // TTS candidates: speech-category models plus anything that looks like a
  // TTS / audio-capable model (e.g. mimo-v2.5-tts used via chat/completions).
  const voiceModelGroups = useMemo(
    () =>
      providers
        .filter((provider) => provider.enabled)
        .map((provider) => ({
          provider,
          models: provider.models.filter(
            (model) =>
              model.enabled &&
              ((model.category ?? 'chat') === 'speech' || /tts|audio/i.test(model.id))
          )
        }))
        .filter((group) => group.models.length > 0),
    [providers]
  )

  const testVoice = async (): Promise<void> => {
    const [testProviderId, testModelId] = fromOptionValue(voiceSelection)
    if (!testProviderId || !testModelId) {
      toast.error(t('agent.voiceModelPlaceholder'))
      return
    }
    setVoiceTesting(true)
    try {
      await playPetVoice(
        {
          providerId: testProviderId,
          modelId: testModelId,
          voice: voiceDraft,
          mode: voiceModeDraft,
          instruction: voiceInstructionDraft,
          tag: voiceTagDraft
        },
        t('agent.voiceTestSample', { name: usePetStore.getState().name })
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setVoiceTesting(false)
    }
  }

  const save = (): void => {
    const [nextProviderId, nextModelId] = fromOptionValue(selection)
    const [nextVoiceProviderId, nextVoiceModelId] = fromOptionValue(voiceSelection)
    const project =
      projectDraft === PROJECT_NONE ? null : (projects.find((p) => p.id === projectDraft) ?? null)
    usePetAgentStore.getState().setConfig({
      providerId: nextProviderId || null,
      modelId: nextModelId || null,
      systemPrompt: promptDraft.trim() === BUILTIN_PET_PROMPT.trim() ? '' : promptDraft,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      projectFolder: project?.workingFolder ?? null,
      proactive: proactiveDraft,
      proactiveFreq: freqDraft,
      quietStart: Number(quietStartDraft),
      quietEnd: Number(quietEndDraft),
      voiceEnabled: voiceEnabledDraft,
      voiceProviderId: nextVoiceProviderId || null,
      voiceModelId: nextVoiceModelId || null,
      voice: voiceDraft.trim(),
      voiceMode: voiceModeDraft,
      voiceInstruction: voiceInstructionDraft.trim(),
      voiceTag: voiceTagDraft.trim()
    })
    void ipcClient.invoke('pet:sync', { kind: 'agent-config' })
    toast.success(t('agent.saved'))
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">{t('agent.desc')}</p>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-sky-400" />
          <p className="text-sm font-medium">{t('agent.model')}</p>
        </div>
        {chatModelGroups.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
            {t('agent.noChatModels')}
          </p>
        ) : (
          <Select value={selection} onValueChange={setSelection}>
            <SelectTrigger className="h-8 w-full text-xs sm:w-72">
              <SelectValue placeholder={t('agent.modelPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {chatModelGroups.map((group) => (
                <SelectGroup key={group.provider.id}>
                  <SelectLabel className="text-[11px] font-normal text-muted-foreground">
                    {group.provider.name}
                  </SelectLabel>
                  {group.models.map((model) => (
                    <SelectItem
                      key={toOptionValue(group.provider.id, model.id)}
                      value={toOptionValue(group.provider.id, model.id)}
                      className="pl-6 text-xs"
                    >
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t('agent.prompt')}</p>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => setPromptDraft(BUILTIN_PET_PROMPT)}
          >
            <RotateCcw className="mr-1 size-3" />
            {t('agent.resetPrompt')}
          </Button>
        </div>
        <Textarea
          value={promptDraft || BUILTIN_PET_PROMPT}
          onChange={(e) => setPromptDraft(e.target.value)}
          rows={10}
          className="text-xs leading-relaxed"
        />
        <p className="text-[11px] text-muted-foreground">{t('agent.promptHint')}</p>
      </section>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <p className="text-sm font-medium">{t('agent.project')}</p>
        <Select value={projectDraft} onValueChange={setProjectDraft}>
          <SelectTrigger className="h-8 w-full text-xs sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PROJECT_NONE} className="text-xs">
              {t('agent.projectNone')}
            </SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id} className="text-xs">
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t('agent.projectHint')}</p>
      </section>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-amber-400" />
              <p className="text-sm font-medium">{t('agent.proactive')}</p>
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {t('agent.proactiveDesc')}
            </p>
          </div>
          <Switch checked={proactiveDraft} onCheckedChange={setProactiveDraft} />
        </div>
        {proactiveDraft ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t('agent.proactiveFreq')}</span>
              <Select value={freqDraft} onValueChange={(v) => setFreqDraft(v as PetProactiveFreq)}>
                <SelectTrigger className="h-7 w-44 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['low', 'medium', 'high'] as const).map((freq) => (
                    <SelectItem key={freq} value={freq} className="text-xs">
                      {t(`agent.freq.${freq}`, { count: PET_PROACTIVE_DAILY_CAP[freq] })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t('agent.quietHours')}</span>
              {[
                [quietStartDraft, setQuietStartDraft] as const,
                [quietEndDraft, setQuietEndDraft] as const
              ].map(([value, setValue], index) => (
                <span key={index} className="flex items-center gap-2">
                  {index === 1 ? (
                    <span className="text-xs text-muted-foreground">{t('agent.quietTo')}</span>
                  ) : null}
                  <Select value={value} onValueChange={setValue}>
                    <SelectTrigger className="h-7 w-20 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 24 }, (_, hour) => (
                        <SelectItem key={hour} value={String(hour)} className="text-xs">
                          {String(hour).padStart(2, '0')}:00
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </span>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{t('agent.proactiveHint')}</p>
          </div>
        ) : null}
      </section>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Volume2 className="size-4 text-emerald-400" />
              <p className="text-sm font-medium">{t('agent.voice')}</p>
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {t('agent.voiceDesc')}
            </p>
          </div>
          <Switch checked={voiceEnabledDraft} onCheckedChange={setVoiceEnabledDraft} />
        </div>
        {voiceEnabledDraft ? (
          <div className="space-y-2">
            {voiceModelGroups.length === 0 ? (
              <p className="rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
                {t('agent.noVoiceModels')}
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{t('agent.voiceModel')}</span>
                <Select value={voiceSelection} onValueChange={setVoiceSelection}>
                  <SelectTrigger className="h-7 w-64 text-xs">
                    <SelectValue placeholder={t('agent.voiceModelPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {voiceModelGroups.map((group) => (
                      <SelectGroup key={group.provider.id}>
                        <SelectLabel className="text-[11px] font-normal text-muted-foreground">
                          {group.provider.name}
                        </SelectLabel>
                        {group.models.map((model) => (
                          <SelectItem
                            key={toOptionValue(group.provider.id, model.id)}
                            value={toOptionValue(group.provider.id, model.id)}
                            className="pl-6 text-xs"
                          >
                            {model.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={voiceModeDraft}
                  onValueChange={(v) => setVoiceModeDraft(v as PetVoiceMode)}
                >
                  <SelectTrigger className="h-7 w-40 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['auto', 'speech', 'chat'] as const).map((mode) => (
                      <SelectItem key={mode} value={mode} className="text-xs">
                        {t(`agent.voiceModes.${mode}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t('agent.voiceName')}</span>
              <Select
                value={voiceCustom ? VOICE_CUSTOM : voiceDraft === '' ? VOICE_DEFAULT : voiceDraft}
                onValueChange={(value) => {
                  if (value === VOICE_CUSTOM) {
                    setVoiceCustom(true)
                  } else {
                    setVoiceCustom(false)
                    setVoiceDraft(value === VOICE_DEFAULT ? '' : value)
                  }
                }}
              >
                <SelectTrigger className="h-7 w-44 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={VOICE_DEFAULT} className="text-xs">
                    {t('agent.voiceDefault')}
                  </SelectItem>
                  <SelectGroup>
                    <SelectLabel className="text-[11px] font-normal text-muted-foreground">
                      OpenAI
                    </SelectLabel>
                    {PET_VOICE_PRESETS.openai.map((item) => (
                      <SelectItem key={item} value={item} className="pl-6 text-xs">
                        {item}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel className="text-[11px] font-normal text-muted-foreground">
                      Xiaomi MiMo
                    </SelectLabel>
                    {PET_VOICE_PRESETS.mimo.map((item) => (
                      <SelectItem key={item} value={item} className="pl-6 text-xs">
                        {item}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectItem value={VOICE_CUSTOM} className="text-xs">
                    {t('agent.voiceCustomOption')}
                  </SelectItem>
                </SelectContent>
              </Select>
              {voiceCustom ? (
                <Input
                  value={voiceDraft}
                  onChange={(e) => setVoiceDraft(e.target.value)}
                  placeholder={t('agent.voiceCustomPlaceholder')}
                  className="h-7 w-40 text-xs"
                />
              ) : null}
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={voiceTesting || !voiceSelection}
                onClick={() => void testVoice()}
              >
                {voiceTesting ? (
                  <Loader2 className="mr-1 size-3 animate-spin" />
                ) : (
                  <Play className="mr-1 size-3" />
                )}
                {t('agent.voiceTest')}
              </Button>
            </div>
            <Input
              value={voiceTagDraft}
              onChange={(e) => setVoiceTagDraft(e.target.value)}
              placeholder={t('agent.voiceTagPlaceholder')}
              maxLength={40}
              className="h-7 text-xs"
            />
            <Input
              value={voiceInstructionDraft}
              onChange={(e) => setVoiceInstructionDraft(e.target.value)}
              placeholder={t('agent.voiceInstructionPlaceholder')}
              maxLength={200}
              className="h-7 text-xs"
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t('agent.voiceHint')}
            </p>
          </div>
        ) : null}
      </section>

      <Button size="sm" className="h-8" onClick={save}>
        {t('agent.save')}
      </Button>
    </div>
  )
}
