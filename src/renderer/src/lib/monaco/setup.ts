import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

const RENDERER_GLOBALS_D_TS = `
declare interface OpenCoworkIpcRenderer {
  send: (channel: string, ...args: unknown[]) => void
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void
  once: (channel: string, listener: (...args: unknown[]) => void) => () => void
  off: (channel: string, listener: (...args: unknown[]) => void) => void
  removeListener: (channel: string, listener: (...args: unknown[]) => void) => void
  removeAllListeners: (channel: string) => void
}

declare interface OpenCoworkElectronApi {
  ipcRenderer: OpenCoworkIpcRenderer
}

declare global {
  interface Window {
    electron: OpenCoworkElectronApi
    api: unknown
  }
}

export {}
`

type MonacoDiagnosticOptions = {
  noSemanticValidation?: boolean
  noSyntaxValidation?: boolean
  noSuggestionDiagnostics?: boolean
  diagnosticCodesToIgnore?: number[]
  onlyVisible?: boolean
}

type MonacoLanguageDefaults = {
  setEagerModelSync: (enabled: boolean) => void
  setCompilerOptions: (options: Record<string, unknown>) => void
  setDiagnosticsOptions: (options: MonacoDiagnosticOptions) => void
  addExtraLib: (content: string, filePath?: string) => { dispose: () => void }
}

type MonacoTypeScriptLanguage = {
  typescriptDefaults: MonacoLanguageDefaults
  javascriptDefaults: MonacoLanguageDefaults
  JsxEmit: {
    ReactJSX: number
  }
  ModuleKind: {
    ESNext: number
  }
  ModuleResolutionKind: {
    NodeJs: number
  }
  ScriptTarget: {
    ES2022: number
  }
}

let initialized = false

export function initializeMonaco(): void {
  if (initialized) return
  initialized = true

  const monacoGlobal = globalThis as typeof globalThis & {
    MonacoEnvironment?: {
      getWorker: (_workerId: string | undefined, label: string) => Worker
    }
  }

  monacoGlobal.MonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === 'json') return new jsonWorker()
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
      if (label === 'typescript' || label === 'javascript') return new tsWorker()
      return new editorWorker()
    }
  }

  loader.config({ monaco })

  const monacoTypeScript = (monaco.languages as unknown as { typescript: MonacoTypeScriptLanguage })
    .typescript

  const compilerOptions = {
    allowJs: true,
    allowNonTsExtensions: true,
    jsx: monacoTypeScript.JsxEmit.ReactJSX,
    module: monacoTypeScript.ModuleKind.ESNext,
    moduleResolution: monacoTypeScript.ModuleResolutionKind.NodeJs,
    target: monacoTypeScript.ScriptTarget.ES2022
  }

  const diagnosticsOptions: MonacoDiagnosticOptions = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
    diagnosticCodesToIgnore: [2307, 2792, 7016],
    onlyVisible: true
  }

  monacoTypeScript.typescriptDefaults.setEagerModelSync(false)
  monacoTypeScript.javascriptDefaults.setEagerModelSync(false)
  monacoTypeScript.typescriptDefaults.setCompilerOptions(compilerOptions)
  monacoTypeScript.javascriptDefaults.setCompilerOptions(compilerOptions)
  monacoTypeScript.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
  monacoTypeScript.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
  monacoTypeScript.typescriptDefaults.addExtraLib(
    RENDERER_GLOBALS_D_TS,
    'file:///opencowork/renderer-globals.d.ts'
  )
  monacoTypeScript.javascriptDefaults.addExtraLib(
    RENDERER_GLOBALS_D_TS,
    'file:///opencowork/renderer-globals.d.ts'
  )
}
