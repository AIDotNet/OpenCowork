import { useRef, useState } from 'react'
import {
  BookMarked,
  Download,
  FileText,
  Grid3x3,
  Image as ImageIcon,
  ImagePlus,
  Images,
  Maximize,
  MessageSquareText,
  Sparkles,
  Minus,
  Plus,
  Redo2,
  Square,
  Undo2,
  Upload,
  Video
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Slider } from '@renderer/components/ui/slider'
import { cn } from '@renderer/lib/utils'
import { clampScale, fitCamera, screenToWorld } from './graph-geometry'
import { GRAPH_MAX_SCALE, GRAPH_MIN_SCALE, useGraphStore } from './graph-store'
import { createCanvasNode } from './node-factory'
import { exportGraphJson, importGraphJson } from './graph-persistence'
import { PromptLibraryDialog } from './prompt-library/PromptLibraryDialog'
import { AssetPickerDialog, type PickedAsset } from './assets/AssetPickerDialog'
import { useAssistantStore } from './assistant/assistant-store'
import {
  type BackgroundMode,
  type CanvasNode,
  type CanvasNodeKind,
  type ConfigNodeData
} from './graph-types'

export function GraphControls(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [assetsOpen, setAssetsOpen] = useState(false)
  const camera = useGraphStore((s) => s.camera)
  const stageSize = useGraphStore((s) => s.stageSize)
  const nodes = useGraphStore((s) => s.nodes)
  const background = useGraphStore((s) => s.background)
  const setBackground = useGraphStore((s) => s.setBackground)
  const setCamera = useGraphStore((s) => s.setCamera)
  const addNode = useGraphStore((s) => s.addNode)
  const undo = useGraphStore((s) => s.undo)
  const redo = useGraphStore((s) => s.redo)
  const past = useGraphStore((s) => s.past.length)
  const future = useGraphStore((s) => s.future.length)

  const createNode = (kind: CanvasNodeKind): void => {
    const center = screenToWorld({ x: stageSize.width / 2, y: stageSize.height / 2 }, camera)
    addNode(createCanvasNode(kind, center), { select: true })
  }

  const createGenerationNode = (mode: ConfigNodeData['mode']): void => {
    const center = screenToWorld({ x: stageSize.width / 2, y: stageSize.height / 2 }, camera)
    addNode(createCanvasNode('config', center, mode), { select: true })
  }

  const insertPrompt = (prompt: string): void => {
    const { nodes, selection, updateNode } = useGraphStore.getState()
    const selectedText = selection.length === 1 && nodes.find((n) => n.id === selection[0])
    if (selectedText && selectedText.kind === 'text') {
      const existing = selectedText.data.text.trim()
      updateNode(selectedText.id, (n) =>
        n.kind === 'text'
          ? { ...n, data: { ...n.data, text: existing ? `${existing}\n${prompt}` : prompt } }
          : n
      )
      return
    }
    const center = screenToWorld({ x: stageSize.width / 2, y: stageSize.height / 2 }, camera)
    const node = createCanvasNode('text', center)
    if (node.kind === 'text') node.data.text = prompt
    addNode(node, { select: true })
  }

  const insertAsset = (asset: PickedAsset): void => {
    const center = screenToWorld({ x: stageSize.width / 2, y: stageSize.height / 2 }, camera)
    if (asset.kind === 'video') {
      const base = createCanvasNode('video', center)
      const node: CanvasNode = {
        ...base,
        kind: 'video',
        data: { filePath: asset.filePath, mediaType: asset.mediaType, prompt: asset.prompt }
      }
      addNode(node, { select: true })
      return
    }
    const base = createCanvasNode('image', center)
    const node: CanvasNode = {
      ...base,
      kind: 'image',
      data: {
        src: asset.src,
        filePath: asset.filePath,
        mediaType: asset.mediaType,
        prompt: asset.prompt
      }
    }
    addNode(node, { select: true })
  }

  const zoomBy = (factor: number): void => {
    const center = { x: stageSize.width / 2, y: stageSize.height / 2 }
    setCamera((cam) => {
      const scale = clampScale(cam.scale * factor)
      const world = screenToWorld(center, cam)
      return { scale, x: center.x - world.x * scale, y: center.y - world.y * scale }
    })
  }

  const backgrounds: { mode: BackgroundMode; icon: React.ReactNode }[] = [
    { mode: 'dots', icon: <Grid3x3 className="size-3.5" /> },
    { mode: 'grid', icon: <Grid3x3 className="size-3.5" /> },
    { mode: 'blank', icon: <Square className="size-3.5" /> }
  ]

  const exportJson = (): void => {
    const blob = new Blob([exportGraphJson()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'canvas.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const importJson = async (file: File): Promise<void> => {
    const text = await file.text()
    if (!importGraphJson(text)) {
      toast.error(t('drawPage.importFailed', { defaultValue: 'Invalid canvas file' }))
    }
  }

  return (
    <>
      {/* add-node toolbar (top-left) */}
      <div className="absolute left-4 top-4 flex flex-col gap-1 rounded-xl border bg-background/85 p-1 shadow-md backdrop-blur">
        <ToolBtn
          label={t('drawPage.addText', { defaultValue: 'Add text' })}
          onClick={() => createNode('text')}
        >
          <FileText className="size-4" />
        </ToolBtn>
        <ToolBtn
          label={t('drawPage.addImage', { defaultValue: 'Add image' })}
          onClick={() => createNode('image')}
        >
          <ImageIcon className="size-4" />
        </ToolBtn>
        <ToolBtn
          label={t('drawPage.addImageGeneration', { defaultValue: 'Add image generation' })}
          onClick={() => createGenerationNode('image')}
        >
          <ImagePlus className="size-4" />
        </ToolBtn>
        <ToolBtn
          label={t('drawPage.addVideoGeneration', { defaultValue: 'Add video generation' })}
          onClick={() => createGenerationNode('video')}
        >
          <Video className="size-4" />
        </ToolBtn>
        <ToolBtn
          label={t('drawPage.addTextGeneration', { defaultValue: 'Add text generation' })}
          onClick={() => createGenerationNode('text')}
        >
          <MessageSquareText className="size-4" />
        </ToolBtn>
        <div className="my-0.5 h-px w-full bg-border" />
        <ToolBtn
          label={t('drawPage.promptLibrary', { defaultValue: 'Prompt library' })}
          onClick={() => setLibraryOpen(true)}
        >
          <BookMarked className="size-4" />
        </ToolBtn>
        <ToolBtn
          label={t('drawPage.myAssets', { defaultValue: 'My materials' })}
          onClick={() => setAssetsOpen(true)}
        >
          <Images className="size-4" />
        </ToolBtn>
        <ToolBtn
          label={t('drawPage.assistant', { defaultValue: 'Canvas assistant' })}
          onClick={() => useAssistantStore.getState().toggle()}
        >
          <Sparkles className="size-4" />
        </ToolBtn>
      </div>

      <PromptLibraryDialog open={libraryOpen} onOpenChange={setLibraryOpen} onPick={insertPrompt} />
      <AssetPickerDialog open={assetsOpen} onOpenChange={setAssetsOpen} onPick={insertAsset} />

      {/* zoom + history cluster (bottom-left) */}
      <div className="absolute bottom-4 left-4 flex items-center gap-1 rounded-xl border bg-background/85 p-1 shadow-md backdrop-blur">
        <ToolBtn
          label={t('action.undo', { ns: 'common', defaultValue: 'Undo' })}
          disabled={past === 0}
          onClick={undo}
        >
          <Undo2 className="size-4" />
        </ToolBtn>
        <ToolBtn
          label={t('action.redo', { ns: 'common', defaultValue: 'Redo' })}
          disabled={future === 0}
          onClick={redo}
        >
          <Redo2 className="size-4" />
        </ToolBtn>
        <div className="mx-1 h-5 w-px bg-border" />
        <ToolBtn label="-" onClick={() => zoomBy(1 / 1.2)}>
          <Minus className="size-4" />
        </ToolBtn>
        <Slider
          className="w-24"
          min={GRAPH_MIN_SCALE}
          max={GRAPH_MAX_SCALE}
          step={0.01}
          value={[camera.scale]}
          onValueChange={([value]) => {
            if (typeof value !== 'number') return
            const center = { x: stageSize.width / 2, y: stageSize.height / 2 }
            setCamera((cam) => {
              const world = screenToWorld(center, cam)
              return { scale: value, x: center.x - world.x * value, y: center.y - world.y * value }
            })
          }}
        />
        <ToolBtn label="+" onClick={() => zoomBy(1.2)}>
          <Plus className="size-4" />
        </ToolBtn>
        <span className="w-10 text-center text-[11px] tabular-nums text-muted-foreground">
          {Math.round(camera.scale * 100)}%
        </span>
        <div className="mx-1 h-5 w-px bg-border" />
        <ToolBtn
          label={t('drawPage.fitView', { defaultValue: 'Fit view' })}
          onClick={() => setCamera(fitCamera(nodes, stageSize))}
        >
          <Maximize className="size-4" />
        </ToolBtn>
      </div>

      {/* background toggle (top-right) */}
      <div className="absolute right-4 top-4 flex items-center gap-0.5 rounded-xl border bg-background/85 p-1 shadow-md backdrop-blur">
        {backgrounds.map((bg) => (
          <button
            key={bg.mode}
            type="button"
            onClick={() => setBackground(bg.mode)}
            className={cn(
              'grid size-7 place-items-center rounded-lg transition-colors',
              background === bg.mode
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted'
            )}
            title={bg.mode}
          >
            {bg.icon}
          </button>
        ))}
        <div className="mx-0.5 h-5 w-px bg-border" />
        <button
          type="button"
          onClick={() => importInputRef.current?.click()}
          className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted"
          title={t('drawPage.importCanvas', { defaultValue: 'Import canvas' })}
        >
          <Upload className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={exportJson}
          className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted"
          title={t('drawPage.exportCanvas', { defaultValue: 'Export canvas' })}
        >
          <Download className="size-3.5" />
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void importJson(file)
            event.target.value = ''
          }}
        />
      </div>
    </>
  )
}

interface ToolBtnProps {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}

function ToolBtn({ label, disabled, onClick, children }: ToolBtnProps): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  )
}
