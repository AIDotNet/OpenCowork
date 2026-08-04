import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, FunctionSquare, Plus, X } from 'lucide-react'
import type { SheetModel } from './types'

interface FormulaBarProps {
  reference: string
  value: string
  editing: boolean
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
  onBeginEdit: () => void
}

export function FormulaBar({
  reference,
  value,
  editing,
  onChange,
  onCommit,
  onCancel,
  onBeginEdit
}: FormulaBarProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  return (
    <div className="flex h-[24px] shrink-0 items-stretch border-b border-[#b1b1b1] bg-white dark:border-[#4a4a4a] dark:bg-[#1f1f1f]">
      <div className="flex w-[92px] shrink-0 items-center gap-1 border-r border-[#d4d4d4] px-2 dark:border-[#3a3a3a]">
        <span className="flex-1 truncate text-[11px] font-medium text-[#333] dark:text-[#d0d0d0]">
          {reference}
        </span>
        <ChevronDown className="size-3 shrink-0 text-[#888]" />
      </div>
      <div className="flex w-[66px] shrink-0 items-center justify-center gap-0.5 border-r border-[#d4d4d4] dark:border-[#3a3a3a]">
        <button
          type="button"
          title="取消"
          disabled={!editing}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCancel}
          className="flex size-[18px] items-center justify-center rounded-sm text-[#888] hover:bg-[#e6e6e6] disabled:opacity-30 dark:hover:bg-[#3a3a3a]"
        >
          <X className="size-3" />
        </button>
        <button
          type="button"
          title="输入"
          disabled={!editing}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCommit}
          className="flex size-[18px] items-center justify-center rounded-sm text-[#217346] hover:bg-[#e6e6e6] disabled:opacity-30 dark:hover:bg-[#3a3a3a]"
        >
          <Check className="size-3" />
        </button>
        <button
          type="button"
          title="插入函数"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onBeginEdit}
          className="flex size-[18px] items-center justify-center rounded-sm text-[#666] hover:bg-[#e6e6e6] dark:text-[#aaa] dark:hover:bg-[#3a3a3a]"
        >
          <FunctionSquare className="size-3" />
        </button>
      </div>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onBeginEdit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onCommit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
        className="min-w-0 flex-1 bg-transparent px-2 text-[12px] text-[#222] outline-none dark:text-[#e0e0e0]"
      />
    </div>
  )
}

interface SheetTabBarProps {
  sheets: SheetModel[]
  active: string
  onSelect: (name: string) => void
  onAdd: () => void
  onRename: (name: string, next: string) => void
}

export function SheetTabBar({
  sheets,
  active,
  onSelect,
  onAdd,
  onRename
}: SheetTabBarProps): React.JSX.Element {
  const [renaming, setRenaming] = useState<string | null>(null)

  return (
    <div className="flex h-[26px] shrink-0 items-stretch gap-px border-t border-[#b1b1b1] bg-[#f0f0f0] px-1 dark:border-[#4a4a4a] dark:bg-[#252525]">
      {sheets
        .filter((sheet) => !sheet.hidden)
        .map((sheet) => {
          const isActive = sheet.name === active
          return renaming === sheet.name ? (
            <input
              key={sheet.name}
              autoFocus
              defaultValue={sheet.name}
              onBlur={(event) => {
                onRename(sheet.name, event.target.value.trim() || sheet.name)
                setRenaming(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') setRenaming(null)
              }}
              className="w-[92px] self-center rounded-sm border border-[#217346] bg-white px-1 text-[11px] outline-none dark:bg-[#1f1f1f]"
            />
          ) : (
            <button
              key={sheet.name}
              type="button"
              onClick={() => onSelect(sheet.name)}
              onDoubleClick={() => setRenaming(sheet.name)}
              className={`relative max-w-[160px] truncate px-3 text-[11px] transition-colors ${
                isActive
                  ? 'border-t-[2px] border-t-[#217346] bg-white font-semibold text-[#217346] dark:bg-[#1b1b1b] dark:text-[#4ec98a]'
                  : 'text-[#444] hover:bg-[#e2e2e2] dark:text-[#bbb] dark:hover:bg-[#333]'
              }`}
              style={
                sheet.tabColor && !isActive
                  ? { boxShadow: `inset 0 -3px 0 0 ${sheet.tabColor}` }
                  : undefined
              }
            >
              {sheet.name}
            </button>
          )
        })}
      <button
        type="button"
        title="新建工作表"
        onClick={onAdd}
        className="flex w-[24px] items-center justify-center text-[#555] hover:bg-[#e2e2e2] dark:text-[#bbb] dark:hover:bg-[#333]"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}

interface StatusBarProps {
  stats: { count: number; numericCount: number; sum: number; average: number } | null
  zoom: number
  onZoomChange: (zoom: number) => void
  dimensions: string
}

export function StatusBar({
  stats,
  zoom,
  onZoomChange,
  dimensions
}: StatusBarProps): React.JSX.Element {
  const format = (value: number): string =>
    Number.isInteger(value) ? String(value) : value.toFixed(2)

  return (
    <div className="flex h-[22px] shrink-0 items-center gap-4 border-t border-[#b1b1b1] bg-[#f0f0f0] px-3 text-[11px] text-[#444] dark:border-[#4a4a4a] dark:bg-[#252525] dark:text-[#bbb]">
      <span>就绪</span>
      <span className="text-[#888]">{dimensions}</span>
      <div className="flex-1" />
      {stats && stats.numericCount > 0 ? (
        <>
          <span>平均值: {format(stats.average)}</span>
          <span>计数: {stats.count}</span>
          <span>求和: {format(stats.sum)}</span>
        </>
      ) : stats && stats.count > 0 ? (
        <span>计数: {stats.count}</span>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onZoomChange(Math.max(0.5, Number((zoom - 0.1).toFixed(2))))}
          className="px-1 hover:text-[#217346]"
        >
          −
        </button>
        <input
          type="range"
          min={50}
          max={200}
          step={10}
          value={Math.round(zoom * 100)}
          onChange={(event) => onZoomChange(Number(event.target.value) / 100)}
          className="h-1 w-[80px] accent-[#217346]"
        />
        <button
          type="button"
          onClick={() => onZoomChange(Math.min(2, Number((zoom + 0.1).toFixed(2))))}
          className="px-1 hover:text-[#217346]"
        >
          +
        </button>
        <span className="w-[38px] text-right">{Math.round(zoom * 100)}%</span>
      </div>
    </div>
  )
}
