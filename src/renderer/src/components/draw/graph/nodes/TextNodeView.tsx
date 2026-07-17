import { useState } from 'react'
import { AArrowDown, AArrowUp, FileText, Image as ImageIcon, Loader2, Wand2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TextNode } from '../graph-types'
import { useGraphStore } from '../graph-store'
import { useGraphActions } from '../graph-actions'

interface Props {
  node: TextNode
}

const FONT_MIN = 0.7
const FONT_MAX = 2

export function TextNodeView({ node }: Props): React.JSX.Element {
  const { t } = useTranslation('layout')
  const updateNode = useGraphStore((s) => s.updateNode)
  const actions = useGraphActions()
  const [rewriting, setRewriting] = useState(false)

  const rewrite = (): void => {
    if (rewriting) return
    setRewriting(true)
    void actions.rewriteText(node.id).finally(() => setRewriting(false))
  }

  const fontScale = node.data.fontScale ?? 1
  const bumpFont = (delta: number): void =>
    updateNode(node.id, (n) =>
      n.kind === 'text'
        ? {
            ...n,
            data: {
              ...n.data,
              fontScale: Math.min(
                FONT_MAX,
                Math.max(FONT_MIN, Math.round((fontScale + delta) * 10) / 10)
              )
            }
          }
        : n
    )

  return (
    <>
      <div className="flex items-center gap-1.5 border-b bg-muted/40 px-2.5 py-1.5">
        <FileText className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('drawPage.nodeText', { defaultValue: 'Text' })}
        </span>
        <div className="ml-auto flex items-center gap-1" data-nodrag>
          <button
            type="button"
            title={t('drawPage.fontSmaller', { defaultValue: 'Smaller text' })}
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            disabled={fontScale <= FONT_MIN}
            onClick={() => bumpFont(-0.1)}
          >
            <AArrowDown className="size-3.5" />
          </button>
          <button
            type="button"
            title={t('drawPage.fontLarger', { defaultValue: 'Larger text' })}
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            disabled={fontScale >= FONT_MAX}
            onClick={() => bumpFont(0.1)}
          >
            <AArrowUp className="size-3.5" />
          </button>
          <button
            type="button"
            title={t('drawPage.rewriteText', { defaultValue: 'Rewrite' })}
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            disabled={rewriting}
            onClick={rewrite}
          >
            {rewriting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Wand2 className="size-3.5" />
            )}
          </button>
          <button
            type="button"
            title={t('drawPage.textToImage', { defaultValue: 'Generate image' })}
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => actions.generateFromText(node.id)}
          >
            <ImageIcon className="size-3.5" />
          </button>
        </div>
      </div>
      <textarea
        data-nodrag
        value={node.data.text}
        onChange={(event) =>
          updateNode(node.id, (n) =>
            n.kind === 'text' ? { ...n, data: { ...n.data, text: event.target.value } } : n
          )
        }
        placeholder={t('drawPage.textNodePlaceholder', { defaultValue: 'Write a prompt or note…' })}
        className="flex-1 resize-none bg-transparent p-2.5 outline-none placeholder:text-muted-foreground/60"
        style={{ fontSize: `${14 * fontScale}px`, lineHeight: 1.5 }}
      />
    </>
  )
}
