import { t } from '../i18n.js'
import type { ModelConfiguration, ModelConfigurationPatch } from '../types.js'

export interface ThinkingIntensityOption {
  description: string
  label: string
  value: string
}

const SESSION_ONLY_LEVELS = new Set(['max'])

export function isSessionOnlyEffort(level: string): boolean {
  return SESSION_ONLY_LEVELS.has(level)
}

export function formatEffortLevelLabel(level: string): string {
  if (level === 'xhigh') return 'XHigh'
  if (!level) return level
  return level[0]!.toLocaleUpperCase() + level.slice(1)
}

function effortDescription(level: string): string {
  if (level === 'none') {
    return t('cli.effort.none', 'Ask the provider for no extra reasoning on the next turns.')
  }
  if (level === 'minimal') {
    return t('cli.effort.minimal', 'Use the smallest available reasoning allocation.')
  }
  if (level === 'low') {
    return t('cli.effort.low', 'Prefer faster, lower-cost responses for straightforward work.')
  }
  if (level === 'medium') {
    return t('cli.effort.medium', 'Use moderate reasoning for routine multi-step work.')
  }
  if (level === 'high') {
    return t('cli.effort.high', 'Spend more reasoning on complex implementation and verification.')
  }
  if (level === 'xhigh') {
    return t('cli.effort.xhigh', 'Use extended reasoning for difficult or ambiguous work.')
  }
  if (level === 'max') {
    return t('cli.effort.max', 'Use the highest reasoning level for the current session only.')
  }
  if (level === 'ultra') return t('cli.effort.ultra', 'Use this provider’s ultra reasoning level.')
  return t('cli.effort.other', 'Use the model-provided {{level}} reasoning level.', { level })
}

function defaultIntensitySummary(configuration: ModelConfiguration): string {
  if (!configuration.defaultThinkingEnabled) return t('cli.common.off', 'Off')
  if (configuration.reasoningEffortLevels.length === 0) return t('cli.common.on', 'On')
  return formatEffortLevelLabel(configuration.defaultReasoningEffort)
}

export function thinkingIntensityOptions(
  configuration: ModelConfiguration
): ThinkingIntensityOption[] {
  const options: ThinkingIntensityOption[] = [
    {
      description: t(
        'cli.effort.off',
        'Disable thinking for this model. Later turns will not request reasoning.'
      ),
      label: t('cli.common.off', 'Off'),
      value: 'off'
    }
  ]

  if (configuration.reasoningEffortLevels.length === 0) {
    options.push({
      description: t('cli.effort.on', 'Enable thinking for this model.'),
      label: t('cli.common.on', 'On'),
      value: 'on'
    })
    return options
  }

  options.push({
    description: t('cli.effort.followDefault', 'Follow this model’s default ({{level}}).', {
      level: defaultIntensitySummary(configuration)
    }),
    label: t('cli.common.auto', 'Auto'),
    value: 'auto'
  })

  for (const level of configuration.reasoningEffortLevels) {
    options.push({
      description: effortDescription(level),
      label: formatEffortLevelLabel(level),
      value: level
    })
  }

  return options
}

export function resolveThinkingIntensity(configuration: ModelConfiguration): string {
  if (
    configuration.reasoningEffortLevels.length > 0 &&
    !configuration.reasoningEffortCustomized &&
    !configuration.thinkingEnabledCustomized
  ) {
    return 'auto'
  }
  if (!configuration.thinkingEnabled) return 'off'
  if (configuration.reasoningEffortLevels.length === 0) return 'on'
  return configuration.reasoningEffort
}

export function applyThinkingIntensity(
  configuration: ModelConfiguration,
  intensity: string
): ModelConfiguration {
  const normalized = intensity.toLocaleLowerCase()
  if (normalized === 'off') {
    return { ...configuration, thinkingEnabled: false, thinkingEnabledCustomized: true }
  }
  if (normalized === 'on') {
    return { ...configuration, thinkingEnabled: true, thinkingEnabledCustomized: true }
  }
  if (normalized === 'auto') {
    return {
      ...configuration,
      reasoningEffort: configuration.defaultReasoningEffort,
      reasoningEffortCustomized: false,
      thinkingEnabled: configuration.defaultThinkingEnabled,
      thinkingEnabledCustomized: false
    }
  }
  return {
    ...configuration,
    reasoningEffort: normalized,
    reasoningEffortCustomized: true,
    thinkingEnabled: true,
    thinkingEnabledCustomized: true
  }
}

export function thinkingIntensityPatch(
  _configuration: ModelConfiguration,
  intensity: string
): ModelConfigurationPatch {
  const normalized = intensity.toLocaleLowerCase()
  if (normalized === 'off') return { thinkingEnabled: false }
  if (normalized === 'on') return { thinkingEnabled: true }
  if (normalized === 'auto') {
    return {
      reasoningEffort: null,
      thinkingEnabled: null
    }
  }
  return {
    reasoningEffort: normalized,
    thinkingEnabled: true
  }
}

export function parseThinkingIntensity(
  configuration: ModelConfiguration,
  requested: string
): string | null {
  const normalized = requested.toLocaleLowerCase()
  return thinkingIntensityOptions(configuration).some((option) => option.value === normalized)
    ? normalized
    : null
}

export function thinkingIntensityUsage(configuration: ModelConfiguration): string {
  return `/effort ${thinkingIntensityOptions(configuration)
    .map((option) => option.value)
    .join('|')}`
}

export function formatThinkingStatus(input: {
  reasoningEffort: string
  reasoningEffortLevels: string[]
  supportsThinking: boolean
  thinkingEnabled: boolean
}): string | null {
  if (!input.supportsThinking) return null
  const think = t('cli.statusLine.think', 'think')
  if (!input.thinkingEnabled) return `${think} ${t('cli.statusLine.off', 'off')}`
  if (input.reasoningEffortLevels.length > 0) return `${think} ${input.reasoningEffort}`
  return `${think} ${t('cli.statusLine.on', 'on')}`
}

export function formatThinkingNotice(
  configuration: ModelConfiguration,
  intensity: string,
  resolved: ModelConfiguration | null
): string {
  const effective = resolved ?? applyThinkingIntensity(configuration, intensity)
  if (intensity === 'off') return t('cli.effort.noticeOff', 'Thinking off')
  if (intensity === 'on') return t('cli.effort.noticeOn', 'Thinking on')
  if (intensity === 'auto') {
    return t('cli.effort.noticeAuto', 'Thinking auto → {{level}} model default', {
      level: defaultIntensitySummary(effective)
    })
  }
  if (isSessionOnlyEffort(intensity)) {
    return t('cli.effort.noticeSession', 'Thinking {{level}} · current session', {
      level: formatEffortLevelLabel(intensity)
    })
  }
  return t('cli.effort.noticeLevel', 'Thinking set to {{level}}', {
    level: formatEffortLevelLabel(intensity)
  })
}
