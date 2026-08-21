import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { ModelIcon } from '@renderer/components/settings/provider-icons'
import { useChannelStore } from '@renderer/stores/channel-store'
import { useChatStore } from '@renderer/stores/chat-store'
import {
  isProviderAvailableForModelSelection,
  useProviderStore
} from '@renderer/stores/provider-store'
import { resolveSessionModelSelection } from '@renderer/lib/session-model-resolution'
import type { AIModelConfig, AIProvider } from '@renderer/lib/api/types'

export type PlanExecutionModelSelection = { providerId: string; modelId: string }

interface ConfirmPlanExecutionOptions {
  sessionId: string
  newSession?: boolean
  initialSelection?: PlanExecutionModelSelection
}

interface DialogRequest extends ConfirmPlanExecutionOptions {
  resolve: (selection: PlanExecutionModelSelection | null) => void
}

let _setDialog: React.Dispatch<React.SetStateAction<DialogRequest | null>> | null = null

function buildModelValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

function parseModelValue(value: string): { providerId: string; modelId: string } | null {
  const separator = value.indexOf('::')
  if (separator <= 0) return null
  const providerId = value.slice(0, separator)
  const modelId = value.slice(separator + 2)
  if (!providerId || !modelId) return null
  return { providerId, modelId }
}

function firstAvailableSelection(
  groups: Array<{ provider: AIProvider; models: AIModelConfig[] }>
): PlanExecutionModelSelection {
  const firstGroup = groups[0]
  const firstModel = firstGroup?.models[0]
  return {
    providerId: firstGroup?.provider.id ?? '',
    modelId: firstModel?.id ?? ''
  }
}

function listChatModelGroups(
  providers: AIProvider[]
): Array<{ provider: AIProvider; models: AIModelConfig[] }> {
  return providers
    .filter((provider) => isProviderAvailableForModelSelection(provider))
    .map((provider) => ({
      provider,
      models: provider.models.filter(
        (model) => model.enabled && (!model.category || model.category === 'chat')
      )
    }))
    .filter((group) => group.models.length > 0)
}

export function resolvePlanExecutionDefaultModel(sessionId: string): PlanExecutionModelSelection {
  const session = useChatStore.getState().sessions.find((item) => item.id === sessionId)
  const providerStore = useProviderStore.getState()
  const channel = session?.pluginId
    ? (useChannelStore.getState().channels.find((item) => item.id === session.pluginId) ?? null)
    : null
  const selection = resolveSessionModelSelection({
    session,
    providers: providerStore.providers,
    activeProviderId: providerStore.activeProviderId,
    activeModelId: providerStore.activeModelId,
    channelProviderId: channel?.providerId,
    channelModelId: channel?.model
  })

  if (selection.providerId && selection.modelId) {
    return { providerId: selection.providerId, modelId: selection.modelId }
  }
  const firstGroup = listChatModelGroups(providerStore.providers)[0]
  const firstModel = firstGroup?.models[0]
  return {
    providerId: firstGroup?.provider.id ?? providerStore.activeProviderId ?? '',
    modelId: firstModel?.id ?? providerStore.activeModelId
  }
}

export function applyPlanExecutionModel(
  sessionId: string,
  selection: PlanExecutionModelSelection
): void {
  const chatStore = useChatStore.getState()
  chatStore.setSessionModelManual(sessionId, selection.providerId, selection.modelId)
}

function selectionToValue(selection: PlanExecutionModelSelection): string {
  return buildModelValue(selection.providerId, selection.modelId)
}

function valueToSelection(value: string): PlanExecutionModelSelection | null {
  return parseModelValue(value)
}

function isSelectionAvailable(
  selection: PlanExecutionModelSelection,
  groups: Array<{ provider: AIProvider; models: AIModelConfig[] }>
): boolean {
  return groups.some(
    (group) =>
      group.provider.id === selection.providerId &&
      group.models.some((model) => model.id === selection.modelId)
  )
}

/**
 * Confirm plan execution and let the user pick the implementation model.
 * Resolves to the chosen model, or null when cancelled.
 */
export function confirmPlanExecution(
  options: ConfirmPlanExecutionOptions
): Promise<PlanExecutionModelSelection | null> {
  return new Promise((resolve) => {
    if (!_setDialog) {
      const accepted = window.confirm(
        options.newSession ? 'Execute approved plan in a new session?' : 'Execute approved plan?'
      )
      resolve(accepted ? resolvePlanExecutionDefaultModel(options.sessionId) : null)
      return
    }
    _setDialog({
      sessionId: options.sessionId,
      newSession: options.newSession === true,
      initialSelection: options.initialSelection,
      resolve
    })
  })
}

export function PlanExecutionModelSelect({
  sessionId,
  value,
  onChange,
  className
}: {
  sessionId: string
  value?: PlanExecutionModelSelection
  onChange?: (selection: PlanExecutionModelSelection) => void
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const providers = useProviderStore((s) => s.providers)
  const groups = React.useMemo(() => listChatModelGroups(providers), [providers])
  const [uncontrolled, setUncontrolled] = React.useState<PlanExecutionModelSelection>(() => {
    const initial = value ?? resolvePlanExecutionDefaultModel(sessionId)
    if (isSelectionAvailable(initial, listChatModelGroups(useProviderStore.getState().providers))) {
      return initial
    }
    return firstAvailableSelection(listChatModelGroups(useProviderStore.getState().providers))
  })
  const selection = value ?? uncontrolled

  const setSelection = (next: PlanExecutionModelSelection): void => {
    if (!value) setUncontrolled(next)
    onChange?.(next)
  }

  return (
    <Select
      value={selectionToValue(selection)}
      onValueChange={(nextValue) => {
        const next = valueToSelection(nextValue)
        if (next) setSelection(next)
      }}
    >
      <SelectTrigger className={className ?? 'w-full text-xs'}>
        <SelectValue
          placeholder={t('plan.executeModelPlaceholder', { defaultValue: 'Select a model' })}
        />
      </SelectTrigger>
      <SelectContent position="popper" className="z-[60] max-h-72">
        {groups.map(({ provider, models }) => (
          <SelectGroup key={provider.id}>
            <SelectLabel className="text-[10px] uppercase tracking-wide">
              {provider.name}
            </SelectLabel>
            {models.map((model) => (
              <SelectItem
                key={`${provider.id}-${model.id}`}
                value={buildModelValue(provider.id, model.id)}
                className="text-xs"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <ModelIcon
                    icon={model.icon}
                    modelId={model.id}
                    providerBuiltinId={provider.builtinId}
                    size={16}
                    className="text-muted-foreground/70"
                  />
                  <span className="truncate">{model.name || model.id}</span>
                </div>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

function PlanExecuteDialogForm({
  sessionId,
  newSession,
  initialSelection,
  onCancel,
  onConfirm
}: {
  sessionId: string
  newSession: boolean
  initialSelection?: PlanExecutionModelSelection
  onCancel: () => void
  onConfirm: (selection: PlanExecutionModelSelection) => void
}): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const { t: tCommon } = useTranslation('common')
  const [selection, setSelection] = React.useState<PlanExecutionModelSelection>(() => {
    const initial = initialSelection ?? resolvePlanExecutionDefaultModel(sessionId)
    if (isSelectionAvailable(initial, listChatModelGroups(useProviderStore.getState().providers))) {
      return initial
    }
    return firstAvailableSelection(listChatModelGroups(useProviderStore.getState().providers))
  })

  const canConfirm = isSelectionAvailable(
    selection,
    listChatModelGroups(useProviderStore.getState().providers)
  )

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t(newSession ? 'plan.confirmExecuteInNewSessionTitle' : 'plan.confirmExecuteTitle', {
            defaultValue: newSession
              ? 'Execute approved plan in a new session?'
              : 'Execute approved plan?'
          })}
        </DialogTitle>
        <DialogDescription>
          {t(newSession ? 'plan.confirmExecuteInNewSessionDesc' : 'plan.confirmExecuteDesc', {
            defaultValue: newSession
              ? 'This will create a new session and start implementation from the approved plan.'
              : 'This will start implementation in the current session.'
          })}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <div className="text-sm font-medium">
          {t('plan.executeModel', { defaultValue: 'Execution model' })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('plan.executeModelDesc', {
            defaultValue: 'Choose which model should implement this plan.'
          })}
        </p>
        <PlanExecutionModelSelect sessionId={sessionId} value={selection} onChange={setSelection} />
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {tCommon('action.cancel', { defaultValue: 'Cancel' })}
        </Button>
        <Button size="sm" disabled={!canConfirm} onClick={() => onConfirm(selection)}>
          {t(newSession ? 'plan.executeInNewSession' : 'plan.confirmExecute', {
            defaultValue: newSession ? 'New Session Execute' : 'Confirm Execute'
          })}
        </Button>
      </DialogFooter>
    </>
  )
}

export function PlanExecuteDialogProvider(): React.JSX.Element {
  const [dialog, setDialog] = React.useState<DialogRequest | null>(null)

  React.useEffect(() => {
    _setDialog = setDialog
    return () => {
      _setDialog = null
    }
  }, [])

  const finish = React.useCallback((selection: PlanExecutionModelSelection | null) => {
    setDialog((current) => {
      current?.resolve(selection)
      return null
    })
  }, [])

  return (
    <Dialog
      open={!!dialog}
      onOpenChange={(open) => {
        if (!open) finish(null)
      }}
    >
      <DialogContent showCloseButton className="sm:max-w-md">
        {dialog ? (
          <PlanExecuteDialogForm
            key={`${dialog.sessionId}:${dialog.newSession ? 'new' : 'current'}`}
            sessionId={dialog.sessionId}
            newSession={dialog.newSession === true}
            initialSelection={dialog.initialSelection}
            onCancel={() => finish(null)}
            onConfirm={(selection) => finish(selection)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
