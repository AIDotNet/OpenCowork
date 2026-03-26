import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  Bot,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  RefreshCw,
  RotateCcw,
  Save,
  Square
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { useChatStore } from '@renderer/stores/chat-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { CodeEditor } from '@renderer/components/editor/CodeEditor'
import {
  cancelWikiGeneration,
  runWikiGeneration,
  type WikiDocumentRow,
  type WikiGenerationProgress
} from '@renderer/lib/wiki/wiki-generator'

interface WikiProjectStateRow {
  project_id: string
  wiki_enabled: number
  wiki_search_enabled: number
  last_full_generated_commit_id: string | null
  last_incremental_generated_commit_id: string | null
  last_exported_at: number | null
  last_generation_status: string
  last_generation_error: string | null
  updated_at: number
}

interface WikiSectionSourceRow {
  id: string
  section_id: string
  file_path: string
  symbol_hint: string | null
  reason: string
}

interface WikiSectionRow {
  id: string
  title: string
  anchor: string
  summary: string
  content_markdown: string
  sources: WikiSectionSourceRow[]
}

interface WikiTreeNode extends WikiDocumentRow {
  children: WikiTreeNode[]
}

function buildWikiTree(documents: WikiDocumentRow[]): WikiTreeNode[] {
  const byId = new Map<string, WikiTreeNode>()
  const roots: WikiTreeNode[] = []
  for (const document of documents) {
    byId.set(document.id, { ...document, children: [] })
  }
  for (const document of documents) {
    const node = byId.get(document.id)
    if (!node) continue
    if (document.parent_id) {
      const parent = byId.get(document.parent_id)
      if (parent) parent.children.push(node)
      else roots.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortNodes = (nodes: WikiTreeNode[]): void => {
    nodes.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    for (const node of nodes) sortNodes(node.children)
  }
  sortNodes(roots)
  return roots
}

function findFirstLeaf(nodes: WikiTreeNode[]): WikiTreeNode | null {
  for (const node of nodes) {
    if (node.is_leaf === 1) return node
    const child = findFirstLeaf(node.children)
    if (child) return child
  }
  return null
}

function parseSourceFiles(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

export function ProjectWikiPage(): React.JSX.Element {
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const projects = useChatStore((state) => state.projects)
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const [documents, setDocuments] = useState<WikiDocumentRow[]>([])
  const [projectState, setProjectState] = useState<WikiProjectStateRow | null>(null)
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [draftContent, setDraftContent] = useState('')
  const [sections, setSections] = useState<WikiSectionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [runningAction, setRunningAction] = useState<
    'generate' | 'regenerate' | 'incremental' | null
  >(null)
  const [generationProgress, setGenerationProgress] = useState<WikiGenerationProgress | null>(null)
  const [expandedIds, setExpandedIds] = useState<string[]>([])

  const wikiTree = useMemo(() => buildWikiTree(documents), [documents])
  const activeDocument = useMemo(
    () => documents.find((document) => document.id === activeDocumentId) ?? null,
    [activeDocumentId, documents]
  )

  const loadData = useCallback(async (): Promise<void> => {
    if (!activeProjectId) {
      setDocuments([])
      setProjectState(null)
      setActiveDocumentId(null)
      setDraftContent('')
      setLoading(false)
      return
    }
    setLoading(true)
    const [docs, state] = await Promise.all([
      ipcClient.invoke(IPC.DB_WIKI_LIST_DOCUMENTS, activeProjectId),
      ipcClient.invoke(IPC.DB_WIKI_GET_PROJECT_STATE, activeProjectId)
    ])
    const nextDocuments = (docs as WikiDocumentRow[]) ?? []
    const nextState = (state as WikiProjectStateRow | null) ?? null
    setDocuments(nextDocuments)
    setProjectState(nextState)
    const nextTree = buildWikiTree(nextDocuments)
    const nextActive = findFirstLeaf(nextTree)?.id ?? null
    setActiveDocumentId((current) => {
      if (
        current &&
        nextDocuments.some((document) => document.id === current && document.is_leaf === 1)
      ) {
        return current
      }
      return nextActive
    })
    setDraftContent(
      nextDocuments.find((document) => document.id === nextActive)?.content_markdown ?? ''
    )
    setExpandedIds((current) => {
      if (current.length > 0) return current
      return nextDocuments
        .filter((document) => document.is_leaf === 0)
        .map((document) => document.id)
    })
    setLoading(false)
  }, [activeProjectId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    setDraftContent(activeDocument?.content_markdown ?? '')
  }, [activeDocument?.id, activeDocument?.content_markdown])

  useEffect(() => {
    const loadDetail = async (): Promise<void> => {
      if (!activeDocumentId) {
        setSections([])
        return
      }
      const detail = (await ipcClient.invoke(
        IPC.DB_WIKI_GET_DOCUMENT_DETAIL,
        activeDocumentId
      )) as {
        document: WikiDocumentRow
        sections: WikiSectionRow[]
      } | null
      setSections(detail?.sections ?? [])
    }
    void loadDetail()
  }, [activeDocumentId])

  const handleSave = async (): Promise<void> => {
    if (!activeProjectId || !activeDocument) return
    setSaving(true)
    const updated = (await ipcClient.invoke(IPC.DB_WIKI_SAVE_DOCUMENT, {
      id: activeDocument.id,
      projectId: activeProjectId,
      name: activeDocument.name,
      slug: activeDocument.slug,
      description: activeDocument.description,
      status: 'edited',
      contentMarkdown: draftContent,
      generationMode: activeDocument.generation_mode,
      lastGeneratedCommitId: activeDocument.last_generated_commit_id,
      parentId: activeDocument.parent_id,
      sortOrder: activeDocument.sort_order,
      level: activeDocument.level,
      isLeaf: activeDocument.is_leaf === 1,
      sourceFiles: parseSourceFiles(activeDocument.source_files_json),
      preserveCreatedAt: true
    })) as WikiDocumentRow
    setDocuments((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    setSaving(false)
  }

  const toggleWikiSearch = async (enabled: boolean): Promise<void> => {
    if (!activeProjectId) return
    const nextState = (await ipcClient.invoke(IPC.DB_WIKI_SAVE_PROJECT_STATE, {
      projectId: activeProjectId,
      patch: { wikiSearchEnabled: enabled, wikiEnabled: true }
    })) as WikiProjectStateRow
    setProjectState(nextState)
    window.dispatchEvent(
      new CustomEvent('opencowork:wiki-search-changed', {
        detail: { projectId: activeProjectId, enabled }
      })
    )
  }

  const toggleExpand = (id: string): void => {
    setExpandedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    )
  }

  const runLocalGeneration = async (
    mode: 'full' | 'regenerate' | 'incremental',
    action: 'generate' | 'regenerate' | 'incremental'
  ): Promise<void> => {
    if (!activeProjectId || !activeProject?.workingFolder) return
    setRunningAction(action)
    setGenerationProgress({
      stage: 'preparing',
      message: '正在启动 Wiki 生成流程',
      totalLeafCount: 0,
      completedLeafCount: 0
    })
    try {
      await runWikiGeneration(
        {
          projectId: activeProjectId,
          projectName: activeProject.name,
          workingFolder: activeProject.workingFolder,
          mode
        },
        {
          onProgress: setGenerationProgress,
          onDocumentsUpdated: async () => {
            await loadData()
          }
        }
      )
      toast.success(
        mode === 'incremental'
          ? 'Wiki 已增量更新'
          : mode === 'full'
            ? 'Wiki 已生成（旧结构已自动升级为树形）'
            : 'Wiki 已重新生成'
      )
      await loadData()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(message)
    } finally {
      setRunningAction(null)
    }
  }

  const handleGenerate = async (): Promise<void> => {
    await runLocalGeneration('full', 'generate')
  }

  const handleRegenerate = async (): Promise<void> => {
    await runLocalGeneration('regenerate', 'regenerate')
  }

  const handleIncrementalGenerate = async (): Promise<void> => {
    await runLocalGeneration('incremental', 'incremental')
  }

  const handleCancelGeneration = (): void => {
    cancelWikiGeneration()
    setRunningAction(null)
    setGenerationProgress((current) =>
      current ? { ...current, stage: 'cancelled', message: 'Wiki 生成已取消' } : current
    )
    toast.info('Wiki 生成已取消')
  }

  const renderTreeNode = (node: WikiTreeNode): React.JSX.Element => {
    const expanded = expandedIds.includes(node.id)
    const isActive = node.id === activeDocumentId
    const hasChildren = node.children.length > 0
    const paddingLeft = `${node.level * 12 + 8}px`
    return (
      <div key={node.id}>
        <button
          className={`flex w-full items-start gap-2 rounded-lg border px-2 py-2 text-left ${isActive ? 'border-primary/30 bg-primary/8' : 'border-transparent hover:border-border hover:bg-background/60'}`}
          style={{ paddingLeft }}
          onClick={() => {
            if (hasChildren) toggleExpand(node.id)
            if (node.is_leaf === 1) setActiveDocumentId(node.id)
          }}
        >
          {hasChildren ? (
            <ChevronRight
              className={`mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          {node.is_leaf === 1 ? (
            <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          ) : expanded ? (
            <FolderOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{node.name}</div>
            <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
              {node.description || '无描述'}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground/80">状态：{node.status}</div>
          </div>
        </button>
        {hasChildren && expanded && (
          <div className="space-y-1">{node.children.map(renderTreeNode)}</div>
        )}
      </div>
    )
  }

  if (!activeProject) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        先选择项目
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-80 shrink-0 flex-col border-r bg-muted/20">
        <div className="border-b p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <BookOpen className="size-4 text-primary" />
            <span>项目 Wiki</span>
          </div>
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
            <div className="flex items-center justify-between rounded-md border px-2 py-1.5">
              <span className="flex items-center gap-1">
                <Bot className="size-3.5" />
                启用 Wiki 搜索
              </span>
              <Switch
                checked={projectState?.wiki_search_enabled === 1}
                onCheckedChange={toggleWikiSearch}
              />
            </div>
            <div className="rounded-md border px-2 py-1.5">
              <div className="flex items-center gap-1">
                <GitCommitHorizontal className="size-3.5" />
                上次全量 Commit
              </div>
              <div className="mt-1 break-all text-[11px]">
                {projectState?.last_full_generated_commit_id ?? '—'}
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 flex-1 text-[11px]"
                onClick={() => void handleIncrementalGenerate()}
                disabled={runningAction !== null}
              >
                <RefreshCw className="size-3.5" />
                {runningAction === 'incremental' ? '增量中' : '增量生成'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 flex-1 text-[11px]"
                onClick={() => void handleGenerate()}
                disabled={runningAction !== null}
              >
                <RotateCcw className="size-3.5" />
                {runningAction === 'generate' ? '生成中' : '全量生成'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 flex-1 text-[11px]"
                onClick={() => void handleRegenerate()}
                disabled={runningAction !== null}
              >
                <RotateCcw className="size-3.5" />
                {runningAction === 'regenerate' ? '重建中' : '重新生成'}
              </Button>
            </div>
            {generationProgress && (
              <div className="rounded-md border px-2 py-2 text-[11px]">
                <div className="font-medium text-foreground">{generationProgress.message}</div>
                <div className="mt-1 text-muted-foreground">
                  阶段：{generationProgress.stage} · 进度：{generationProgress.completedLeafCount}/
                  {generationProgress.totalLeafCount}
                </div>
                {generationProgress.currentNodeTitle && (
                  <div className="mt-1 break-all text-muted-foreground">
                    当前节点：{generationProgress.currentNodeTitle}
                  </div>
                )}
                {runningAction !== null && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 h-7 w-full text-[11px]"
                    onClick={handleCancelGeneration}
                  >
                    <Square className="size-3.5" />
                    取消生成
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="px-2 py-6 text-xs text-muted-foreground">正在加载 Wiki...</div>
          ) : documents.length === 0 ? (
            <div className="px-2 py-6 text-xs text-muted-foreground">暂无 Wiki 文档</div>
          ) : (
            <div className="space-y-1">{wikiTree.map(renderTreeNode)}</div>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {activeDocument?.name ?? '项目 Wiki'}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {activeDocument?.description ?? activeProject.workingFolder ?? '尚未生成文档'}
            </div>
            <div className="text-[11px] text-muted-foreground">
              文档状态：{activeDocument?.status ?? '—'}
            </div>
          </div>
          <Button
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={() => void handleSave()}
            disabled={!activeDocument || saving}
          >
            <Save className="size-3.5" />
            保存
          </Button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            {activeDocument ? (
              <CodeEditor
                filePath={`${activeDocument.slug}.md`}
                language="markdown"
                content={draftContent}
                onChange={setDraftContent}
                onSave={handleSave}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                请选择叶子 Wiki 节点
              </div>
            )}
          </div>
          <div className="w-72 shrink-0 border-l bg-muted/10 p-3">
            <div className="text-xs font-medium">章节来源文件</div>
            <div className="mt-2 space-y-3 overflow-y-auto text-[11px] text-muted-foreground">
              {sections.length === 0 ? (
                <div>暂无章节来源</div>
              ) : (
                sections.map((section) => (
                  <div key={section.id} className="rounded-md border bg-background/70 p-2">
                    <div className="font-medium text-foreground">{section.title}</div>
                    <div className="mt-1 space-y-1">
                      {section.sources.length === 0 ? (
                        <div>无来源文件</div>
                      ) : (
                        section.sources.map((source) => (
                          <div key={source.id} className="break-all">
                            `{source.file_path}`
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
