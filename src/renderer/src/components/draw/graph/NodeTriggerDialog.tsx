import { useEffect, useMemo, useState } from 'react'
import { nanoid } from 'nanoid'
import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { getCanvasNodeSubscriptionCount, onCanvasSubscriptionChange } from './canvas-events'
import { createsTriggerCycle } from './canvas-triggers'
import { useGraphStore } from './graph-store'
import type { CanvasNodeEventType } from './graph-types'

const TRIGGER_EVENTS: CanvasNodeEventType[] = [
  'run.queued',
  'run.started',
  'run.progress',
  'run.succeeded',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'node.updated'
]

const TRIGGER_EVENT_LABEL_KEYS: Record<CanvasNodeEventType, string> = {
  'run.queued': 'drawPage.triggerEvents.queued',
  'run.started': 'drawPage.triggerEvents.started',
  'run.progress': 'drawPage.triggerEvents.progress',
  'run.succeeded': 'drawPage.triggerEvents.succeeded',
  'run.failed': 'drawPage.triggerEvents.failed',
  'run.cancelled': 'drawPage.triggerEvents.cancelled',
  'run.interrupted': 'drawPage.triggerEvents.interrupted',
  'node.updated': 'drawPage.triggerEvents.updated'
}

export function NodeTriggerDialog({
  nodeId,
  open,
  onOpenChange
}: {
  nodeId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const nodes = useGraphStore((state) => state.nodes)
  const triggers = useGraphStore((state) => state.triggers)
  const addTrigger = useGraphStore((state) => state.addTrigger)
  const removeTrigger = useGraphStore((state) => state.removeTrigger)
  const [event, setEvent] = useState<CanvasNodeEventType>('run.succeeded')
  const [targetNodeId, setTargetNodeId] = useState('')
  const outgoing = useMemo(
    () => triggers.filter((trigger) => trigger.sourceNodeId === nodeId),
    [nodeId, triggers]
  )
  const sourceNode = nodes.find((node) => node.id === nodeId)
  const executionStatus = sourceNode?.execution?.status ?? 'idle'
  const [subscriptionCount, setSubscriptionCount] = useState(() =>
    getCanvasNodeSubscriptionCount(nodeId)
  )
  const targets = nodes.filter((node) => node.id !== nodeId)
  const nodeLabel = (node: (typeof nodes)[number]): string =>
    node.kind === 'text'
      ? t('drawPage.nodeText', { defaultValue: 'Text' })
      : node.kind === 'image'
        ? t('drawPage.nodeImage', { defaultValue: 'Image' })
        : node.kind === 'video'
          ? t('drawPage.modeVideo', { defaultValue: 'Video' })
          : node.data.mode === 'video'
            ? t('drawPage.nodeVideoGeneration', { defaultValue: 'Video generation' })
            : node.data.mode === 'text'
              ? t('drawPage.nodeTextGeneration', { defaultValue: 'Text generation' })
              : t('drawPage.nodeImageGeneration', { defaultValue: 'Image generation' })

  useEffect(() => {
    const update = (): void => setSubscriptionCount(getCanvasNodeSubscriptionCount(nodeId))
    update()
    return onCanvasSubscriptionChange(update)
  }, [nodeId])

  const add = (): void => {
    if (!targetNodeId) return
    if (
      triggers.some(
        (trigger) =>
          trigger.sourceNodeId === nodeId &&
          trigger.targetNodeId === targetNodeId &&
          trigger.event === event
      )
    ) {
      toast.error(t('drawPage.triggerDuplicate', { defaultValue: 'This trigger already exists' }))
      return
    }
    if (createsTriggerCycle(triggers, nodeId, targetNodeId)) {
      toast.error(t('drawPage.triggerCycle', { defaultValue: 'This trigger would create a cycle' }))
      return
    }
    addTrigger({
      id: nanoid(),
      sourceNodeId: nodeId,
      event,
      targetNodeId,
      enabled: true,
      createdAt: Date.now()
    })
    setTargetNodeId('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('drawPage.nodeTriggers', { defaultValue: 'Node event triggers' })}
          </DialogTitle>
          <DialogDescription>
            {t('drawPage.nodeTriggersDesc', {
              defaultValue: 'Run another node when this node changes execution state.'
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-muted/50 px-3 py-2 text-xs">
          <span>
            {t('drawPage.triggerLastRun', { defaultValue: 'Last run' })}:{' '}
            <strong>
              {t(`drawPage.triggerStatuses.${executionStatus}`, {
                defaultValue: executionStatus
              })}
            </strong>
          </span>
          {sourceNode?.execution?.runId && (
            <span className="text-muted-foreground">{sourceNode.execution.runId.slice(0, 8)}</span>
          )}
          <span className="text-muted-foreground">
            {t('drawPage.triggerSubscriptions', {
              count: subscriptionCount,
              defaultValue: '{{count}} active subscription(s)'
            })}
          </span>
        </div>
        <div className="flex gap-2">
          <select
            className="h-9 flex-1 rounded-md border bg-background px-2 text-xs"
            value={event}
            onChange={(value) => setEvent(value.target.value as CanvasNodeEventType)}
          >
            {TRIGGER_EVENTS.map((item) => (
              <option key={item} value={item}>
                {t(TRIGGER_EVENT_LABEL_KEYS[item], { defaultValue: item })}
              </option>
            ))}
          </select>
          <select
            className="h-9 flex-1 rounded-md border bg-background px-2 text-xs"
            value={targetNodeId}
            onChange={(value) => setTargetNodeId(value.target.value)}
          >
            <option value="">
              {t('drawPage.triggerTarget', { defaultValue: 'Choose target node' })}
            </option>
            {targets.map((node) => (
              <option key={node.id} value={node.id}>
                {nodeLabel(node)} · {node.id.slice(0, 8)}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={add} disabled={!targetNodeId}>
            {t('drawPage.triggerAdd', { defaultValue: 'Add' })}
          </Button>
        </div>
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {outgoing.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {t('drawPage.triggerEmpty', { defaultValue: 'No triggers for this node' })}
            </p>
          ) : (
            outgoing.map((trigger) => (
              <div
                key={trigger.id}
                className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
              >
                <span className="font-medium">
                  {t(TRIGGER_EVENT_LABEL_KEYS[trigger.event], { defaultValue: trigger.event })}
                </span>
                <span className="text-muted-foreground">→</span>
                <span className="min-w-0 flex-1 truncate">
                  {(() => {
                    const target = nodes.find((node) => node.id === trigger.targetNodeId)
                    return target
                      ? `${nodeLabel(target)} · ${trigger.targetNodeId.slice(0, 8)}`
                      : trigger.targetNodeId.slice(0, 8)
                  })()}
                </span>
                <button
                  type="button"
                  className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => removeTrigger(trigger.id)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
