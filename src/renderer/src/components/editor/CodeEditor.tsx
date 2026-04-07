import * as React from 'react'
import type { editor } from 'monaco-editor'
import { Loader2 } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { defaultCodeEditorOptions } from '@renderer/lib/monaco/editor-options'
import { guessLanguage } from '@renderer/lib/monaco/languages'
import {
  findImportPathAtPosition,
  resolveImportTarget
} from '@renderer/lib/monaco/source-navigation'
import { initializeMonaco } from '@renderer/lib/monaco/setup'
import { createModelUri, type EditorWorkspace } from '@renderer/lib/monaco/workspace'

const MonacoEditor = React.lazy(async () => {
  const mod = await import('@monaco-editor/react')
  return { default: mod.default }
})

export interface CodeEditorProps {
  filePath: string
  content: string
  height?: string | number
  language?: string
  workspace?: EditorWorkspace | null
  options?: editor.IStandaloneEditorConstructionOptions
  onChange?: (value: string) => void
  onSave?: () => void | Promise<void>
  onOpenFile?: (filePath: string) => void | Promise<void>
}

export interface CodeEditorHandle {
  undo: () => void
  redo: () => void
  focus: () => void
}

export const CodeEditor = React.forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  {
    filePath,
    content,
    height = '100%',
    language,
    workspace,
    options,
    onChange,
    onSave,
    onOpenFile
  },
  ref
): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  const editorWorkspaceEnabled = useSettingsStore((s) => s.editorWorkspaceEnabled)
  const editorRemoteLanguageServiceEnabled = useSettingsStore(
    (s) => s.editorRemoteLanguageServiceEnabled
  )
  const editorRef = React.useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null)

  const path = React.useMemo(
    () =>
      createModelUri({
        filePath,
        workspace,
        workspaceEnabled: editorWorkspaceEnabled,
        remoteLanguageServiceEnabled: editorRemoteLanguageServiceEnabled
      }),
    [editorRemoteLanguageServiceEnabled, editorWorkspaceEnabled, filePath, workspace]
  )

  const mergedOptions = React.useMemo(
    () => ({
      ...defaultCodeEditorOptions,
      ...options,
      minimap: options?.minimap ?? defaultCodeEditorOptions.minimap
    }),
    [options]
  )

  React.useImperativeHandle(
    ref,
    () => ({
      undo: () => {
        editorRef.current?.focus()
        editorRef.current?.trigger('history-toolbar', 'undo', null)
      },
      redo: () => {
        editorRef.current?.focus()
        editorRef.current?.trigger('history-toolbar', 'redo', null)
      },
      focus: () => {
        editorRef.current?.focus()
      }
    }),
    []
  )

  const openImportSource = React.useCallback(
    async (monacoEditor: import('monaco-editor').editor.IStandaloneCodeEditor) => {
      if (!onOpenFile) return

      const position = monacoEditor.getPosition()
      const model = monacoEditor.getModel()
      if (!position || !model) return

      const importMatch = findImportPathAtPosition(
        model.getLineContent(position.lineNumber),
        position.column
      )
      if (!importMatch) return

      const targetPath = await resolveImportTarget({
        currentFilePath: filePath,
        specifier: importMatch.specifier,
        workspace
      })
      if (!targetPath) return

      await onOpenFile(targetPath)
    },
    [filePath, onOpenFile, workspace]
  )

  const handleMount = React.useCallback(
    (
      monacoEditor: import('monaco-editor').editor.IStandaloneCodeEditor,
      monacoInstance: typeof import('monaco-editor')
    ) => {
      editorRef.current = monacoEditor

      if (onSave) {
        monacoEditor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
          void onSave()
        })
      }

      if (onOpenFile) {
        monacoEditor.addCommand(monacoInstance.KeyCode.F12, () => {
          void openImportSource(monacoEditor)
        })

        monacoEditor.onMouseDown((event) => {
          if (!event.target.position) return
          if (!(event.event.ctrlKey || event.event.metaKey)) return
          monacoEditor.setPosition(event.target.position)
          void openImportSource(monacoEditor)
        })
      }
    },
    [onOpenFile, onSave, openImportSource]
  )

  return (
    <React.Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-amber-500" />
        </div>
      }
    >
      <MonacoEditor
        beforeMount={initializeMonaco}
        height={height}
        language={language ?? guessLanguage(filePath)}
        onChange={(value) => onChange?.(value ?? '')}
        onMount={handleMount}
        options={mergedOptions}
        path={path}
        theme={resolvedTheme === 'light' ? 'vs' : 'vs-dark'}
        value={content}
      />
    </React.Suspense>
  )
})

CodeEditor.displayName = 'CodeEditor'
