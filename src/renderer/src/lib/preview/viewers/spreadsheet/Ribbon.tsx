import { useState } from 'react'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowUpDown,
  Baseline,
  Bold,
  ChevronDown,
  ClipboardPaste,
  Copy,
  Italic,
  Merge,
  Minus,
  PaintBucket,
  Paintbrush,
  Percent,
  Plus,
  Redo2,
  Save,
  Scissors,
  Search,
  Sigma,
  Strikethrough,
  Trash2,
  Underline,
  Undo2
} from 'lucide-react'
import type { CellStyle } from './types'

export type RibbonCommand =
  | { kind: 'style'; patch: Partial<CellStyle> }
  | { kind: 'toggle'; key: 'bold' | 'italic' | 'underline' | 'strike' | 'wrap' }
  | { kind: 'numFmt'; format: string }
  | { kind: 'decimals'; delta: number }
  | { kind: 'merge' }
  | { kind: 'unmerge' }
  | { kind: 'insertRow' }
  | { kind: 'deleteRow' }
  | { kind: 'insertCol' }
  | { kind: 'deleteCol' }
  | { kind: 'autoSum' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'save' }
  | { kind: 'copy' }
  | { kind: 'cut' }
  | { kind: 'paste' }
  | { kind: 'find' }

interface RibbonProps {
  activeStyle: CellStyle | undefined
  canUndo: boolean
  canRedo: boolean
  dirty: boolean
  saving: boolean
  onCommand: (command: RibbonCommand) => void
}

const TABS = ['开始', '插入', '页面布局', '公式', '数据', '审阅', '视图'] as const

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72]
const FONT_NAMES = [
  'Calibri',
  'Arial',
  'Helvetica',
  'Times New Roman',
  'Courier New',
  '微软雅黑',
  '宋体',
  '黑体'
]

const SWATCHES = [
  '#000000',
  '#FFFFFF',
  '#C00000',
  '#FF0000',
  '#FFC000',
  '#FFFF00',
  '#92D050',
  '#00B050',
  '#00B0F0',
  '#0070C0',
  '#002060',
  '#7030A0',
  '#F2F2F2',
  '#D9D9D9',
  '#A6A6A6',
  '#808080',
  '#404040',
  '#217346'
]

function Group({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center border-r border-[#d4d4d4] px-2 dark:border-[#3a3a3a]">
      <div className="flex flex-1 items-center gap-0.5">{children}</div>
      <div className="pb-0.5 text-[10px] leading-none text-[#666] dark:text-[#999]">{label}</div>
    </div>
  )
}

function IconButton({
  icon: Icon,
  title,
  active,
  disabled,
  onClick
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  active?: boolean
  disabled?: boolean
  onClick?: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`flex size-[26px] items-center justify-center rounded-sm border transition-colors ${
        active
          ? 'border-[#217346]/50 bg-[#d3e5db] text-[#217346] dark:bg-[#1f3d30] dark:text-[#4ec98a]'
          : 'border-transparent text-[#333] hover:border-[#c6c6c6] hover:bg-[#e6e6e6] dark:text-[#d0d0d0] dark:hover:border-[#555] dark:hover:bg-[#3a3a3a]'
      } disabled:pointer-events-none disabled:opacity-35`}
    >
      <Icon className="size-[15px]" />
    </button>
  )
}

function ColorPicker({
  icon: Icon,
  title,
  swatch,
  onPick
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  swatch: string
  onPick: (color: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        title={title}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className="flex h-[26px] w-[30px] flex-col items-center justify-center rounded-sm border border-transparent text-[#333] hover:border-[#c6c6c6] hover:bg-[#e6e6e6] dark:text-[#d0d0d0] dark:hover:border-[#555] dark:hover:bg-[#3a3a3a]"
      >
        <Icon className="size-[13px]" />
        <span className="h-[3px] w-[15px]" style={{ background: swatch }} />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 grid w-[152px] grid-cols-6 gap-1 rounded border border-[#c6c6c6] bg-white p-2 shadow-lg dark:border-[#555] dark:bg-[#2b2b2b]">
            {SWATCHES.map((color) => (
              <button
                key={color}
                type="button"
                className="size-5 rounded-sm border border-black/20 hover:ring-2 hover:ring-[#217346]"
                style={{ background: color }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onPick(color)
                  setOpen(false)
                }}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

export function Ribbon({
  activeStyle,
  canUndo,
  canRedo,
  dirty,
  saving,
  onCommand
}: RibbonProps): React.JSX.Element {
  const [tab, setTab] = useState<(typeof TABS)[number]>('开始')
  const enabled = tab === '开始'

  return (
    <div className="shrink-0 border-b border-[#b1b1b1] bg-[#f5f5f5] dark:border-[#4a4a4a] dark:bg-[#252525]">
      {/* Quick access + tab strip */}
      <div className="flex h-[26px] items-center gap-1 border-b border-[#e0e0e0] px-2 dark:border-[#3a3a3a]">
        <IconButton
          icon={Save}
          title="保存 (Ctrl+S)"
          disabled={!dirty || saving}
          onClick={() => onCommand({ kind: 'save' })}
        />
        <IconButton
          icon={Undo2}
          title="撤销 (Ctrl+Z)"
          disabled={!canUndo}
          onClick={() => onCommand({ kind: 'undo' })}
        />
        <IconButton
          icon={Redo2}
          title="恢复 (Ctrl+Y)"
          disabled={!canRedo}
          onClick={() => onCommand({ kind: 'redo' })}
        />
        <div className="mx-1 h-4 w-px bg-[#d4d4d4] dark:bg-[#3a3a3a]" />
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`h-full border-b-[2px] px-3 text-[12px] transition-colors ${
              tab === name
                ? 'border-[#217346] font-semibold text-[#217346] dark:text-[#4ec98a]'
                : 'border-transparent text-[#444] hover:bg-[#e6e6e6] dark:text-[#c0c0c0] dark:hover:bg-[#333]'
            }`}
          >
            {name}
          </button>
        ))}
        {dirty ? (
          <span className="ml-auto text-[11px] text-[#c00]">● 未保存</span>
        ) : (
          <span className="ml-auto text-[11px] text-[#888]">已保存</span>
        )}
      </div>

      {/* Ribbon body */}
      <div className="flex h-[62px] items-stretch overflow-x-auto px-1">
        <Group label="剪贴板">
          <IconButton
            icon={ClipboardPaste}
            title="粘贴"
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'paste' })}
          />
          <IconButton
            icon={Scissors}
            title="剪切"
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'cut' })}
          />
          <IconButton
            icon={Copy}
            title="复制"
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'copy' })}
          />
          <IconButton icon={Paintbrush} title="格式刷（未实现）" disabled />
        </Group>

        <Group label="字体">
          <select
            value={activeStyle?.fontName ?? 'Calibri'}
            disabled={!enabled}
            onChange={(event) =>
              onCommand({ kind: 'style', patch: { fontName: event.target.value } })
            }
            className="h-[24px] w-[104px] rounded-sm border border-[#c6c6c6] bg-white px-1 text-[11px] dark:border-[#555] dark:bg-[#1f1f1f]"
          >
            {FONT_NAMES.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
          <select
            value={activeStyle?.fontSize ?? 11}
            disabled={!enabled}
            onChange={(event) =>
              onCommand({ kind: 'style', patch: { fontSize: Number(event.target.value) } })
            }
            className="h-[24px] w-[48px] rounded-sm border border-[#c6c6c6] bg-white px-1 text-[11px] dark:border-[#555] dark:bg-[#1f1f1f]"
          >
            {FONT_SIZES.map((size) => (
              <option key={size}>{size}</option>
            ))}
          </select>
          <IconButton
            icon={Bold}
            title="加粗 (Ctrl+B)"
            active={activeStyle?.bold}
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'toggle', key: 'bold' })}
          />
          <IconButton
            icon={Italic}
            title="倾斜 (Ctrl+I)"
            active={activeStyle?.italic}
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'toggle', key: 'italic' })}
          />
          <IconButton
            icon={Underline}
            title="下划线 (Ctrl+U)"
            active={activeStyle?.underline}
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'toggle', key: 'underline' })}
          />
          <IconButton
            icon={Strikethrough}
            title="删除线"
            active={activeStyle?.strike}
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'toggle', key: 'strike' })}
          />
          <ColorPicker
            icon={PaintBucket}
            title="填充颜色"
            swatch={activeStyle?.fill ?? '#FFFF00'}
            onPick={(fill) => onCommand({ kind: 'style', patch: { fill } })}
          />
          <ColorPicker
            icon={Baseline}
            title="字体颜色"
            swatch={activeStyle?.color ?? '#C00000'}
            onPick={(color) => onCommand({ kind: 'style', patch: { color } })}
          />
        </Group>

        <Group label="对齐方式">
          <IconButton
            icon={AlignLeft}
            title="左对齐"
            active={activeStyle?.hAlign === 'left'}
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'style', patch: { hAlign: 'left' } })}
          />
          <IconButton
            icon={AlignCenter}
            title="居中"
            active={activeStyle?.hAlign === 'center'}
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'style', patch: { hAlign: 'center' } })}
          />
          <IconButton
            icon={AlignRight}
            title="右对齐"
            active={activeStyle?.hAlign === 'right'}
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'style', patch: { hAlign: 'right' } })}
          />
          <IconButton
            icon={AlignJustify}
            title="自动换行"
            active={activeStyle?.wrap}
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'toggle', key: 'wrap' })}
          />
          <IconButton
            icon={Merge}
            title="合并后居中"
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'merge' })}
          />
          <IconButton
            icon={Trash2}
            title="取消合并"
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'unmerge' })}
          />
        </Group>

        <Group label="数字">
          <select
            value={activeStyle?.numFmt ?? 'General'}
            disabled={!enabled}
            onChange={(event) => onCommand({ kind: 'numFmt', format: event.target.value })}
            className="h-[24px] w-[96px] rounded-sm border border-[#c6c6c6] bg-white px-1 text-[11px] dark:border-[#555] dark:bg-[#1f1f1f]"
          >
            <option value="General">常规</option>
            <option value="0">整数</option>
            <option value="0.00">数值</option>
            <option value="#,##0.00">千分位</option>
            <option value="0.00%">百分比</option>
            <option value="¥#,##0.00">货币</option>
            <option value="yyyy-mm-dd">日期</option>
            <option value="hh:mm:ss">时间</option>
          </select>
          <IconButton
            icon={Percent}
            title="百分比样式"
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'numFmt', format: '0.00%' })}
          />
          <IconButton
            icon={Plus}
            title="增加小数位数"
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'decimals', delta: 1 })}
          />
          <IconButton
            icon={Minus}
            title="减少小数位数"
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'decimals', delta: -1 })}
          />
        </Group>

        <Group label="单元格">
          <button
            type="button"
            disabled={!enabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onCommand({ kind: 'insertRow' })}
            className="h-[24px] rounded-sm border border-transparent px-2 text-[11px] text-[#333] hover:border-[#c6c6c6] hover:bg-[#e6e6e6] disabled:opacity-35 dark:text-[#d0d0d0] dark:hover:bg-[#3a3a3a]"
          >
            插入行
          </button>
          <button
            type="button"
            disabled={!enabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onCommand({ kind: 'deleteRow' })}
            className="h-[24px] rounded-sm border border-transparent px-2 text-[11px] text-[#333] hover:border-[#c6c6c6] hover:bg-[#e6e6e6] disabled:opacity-35 dark:text-[#d0d0d0] dark:hover:bg-[#3a3a3a]"
          >
            删除行
          </button>
          <button
            type="button"
            disabled={!enabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onCommand({ kind: 'insertCol' })}
            className="h-[24px] rounded-sm border border-transparent px-2 text-[11px] text-[#333] hover:border-[#c6c6c6] hover:bg-[#e6e6e6] disabled:opacity-35 dark:text-[#d0d0d0] dark:hover:bg-[#3a3a3a]"
          >
            插入列
          </button>
          <button
            type="button"
            disabled={!enabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onCommand({ kind: 'deleteCol' })}
            className="h-[24px] rounded-sm border border-transparent px-2 text-[11px] text-[#333] hover:border-[#c6c6c6] hover:bg-[#e6e6e6] disabled:opacity-35 dark:text-[#d0d0d0] dark:hover:bg-[#3a3a3a]"
          >
            删除列
          </button>
        </Group>

        <Group label="编辑">
          <IconButton
            icon={Sigma}
            title="自动求和"
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'autoSum' })}
          />
          <IconButton icon={ArrowUpDown} title="排序和筛选（未实现）" disabled />
          <IconButton
            icon={Search}
            title="查找"
            disabled={!enabled}
            onClick={() => onCommand({ kind: 'find' })}
          />
          <ChevronDown className="size-3 text-[#999]" />
        </Group>
      </div>
    </div>
  )
}
