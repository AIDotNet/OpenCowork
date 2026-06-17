import * as React from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { FileWarning, Loader2 } from 'lucide-react'
import { useTheme } from 'next-themes'
import { defaultCodeEditorOptions } from '@renderer/lib/monaco/editor-options'
import { guessLanguage } from '@renderer/lib/monaco/languages'
import { initializeMonaco } from '@renderer/lib/monaco/setup'

export interface MonacoDiffEditorProps {
  filePath: string
  original: string
  modified: string
  language?: string
  /** When true the modified (right) side is editable. Original is always read-only. */
  modifiedEditable?: boolean
  /** Split (side-by-side) vs inline (unified) rendering. */
  renderSideBySide?: boolean
  isBinary?: boolean
  height?: string | number
  onModifiedChange?: (value: string) => void
  onSave?: () => void | Promise<void>
}

// Guard rails: Monaco struggles past these sizes, so we show a placeholder
// instead of locking up the renderer.
const MAX_DIFF_BYTES = 2_000_000
const MAX_DIFF_LINES = 50_000

function countLines(text: string): number {
  let lines = 1
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1
  }
  return lines
}

function DiffPlaceholder({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground">
      <FileWarning className="size-5 text-amber-500" />
      <span>{message}</span>
    </div>
  )
}

export function MonacoDiffEditor({
  filePath,
  original,
  modified,
  language,
  modifiedEditable = false,
  renderSideBySide = true,
  isBinary = false,
  height = '100%',
  onModifiedChange,
  onSave
}: MonacoDiffEditorProps): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  const changeListenerRef = React.useRef<import('monaco-editor').IDisposable | null>(null)

  const tooLarge =
    original.length + modified.length > MAX_DIFF_BYTES ||
    countLines(original) + countLines(modified) > MAX_DIFF_LINES

  const mergedOptions = React.useMemo<editor.IDiffEditorConstructionOptions>(
    () => ({
      ...defaultCodeEditorOptions,
      readOnly: !modifiedEditable,
      originalEditable: false,
      renderSideBySide,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: false,
      automaticLayout: true
    }),
    [modifiedEditable, renderSideBySide]
  )

  const handleMount = React.useCallback(
    (
      diffEditor: import('monaco-editor').editor.IStandaloneDiffEditor,
      monacoInstance: typeof import('monaco-editor')
    ) => {
      const modifiedEditor = diffEditor.getModifiedEditor()

      if (onSave) {
        modifiedEditor.addCommand(
          monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
          () => {
            void onSave()
          }
        )
      }

      changeListenerRef.current?.dispose()
      if (onModifiedChange) {
        changeListenerRef.current = modifiedEditor.onDidChangeModelContent(() => {
          onModifiedChange(modifiedEditor.getValue())
        })
      }
    },
    [onModifiedChange, onSave]
  )

  React.useEffect(() => {
    return () => {
      changeListenerRef.current?.dispose()
      changeListenerRef.current = null
    }
  }, [])

  if (isBinary) {
    return <DiffPlaceholder message="Binary file — cannot show a diff." />
  }
  if (tooLarge) {
    return <DiffPlaceholder message="File is too large to diff in the editor." />
  }

  return (
    <DiffEditor
      beforeMount={initializeMonaco}
      height={height}
      language={language ?? guessLanguage(filePath)}
      loading={
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-amber-500" />
        </div>
      }
      modified={modified}
      onMount={handleMount}
      options={mergedOptions}
      original={original}
      theme={resolvedTheme === 'light' ? 'vs' : 'vs-dark'}
    />
  )
}
