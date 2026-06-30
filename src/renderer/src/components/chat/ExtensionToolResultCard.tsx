import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Coffee,
  CreditCard,
  ExternalLink,
  MapPin,
  PackageSearch,
  Puzzle,
  ReceiptText,
  Store
} from 'lucide-react'
import type { ToolResultContent } from '@renderer/lib/api/types'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useExtensionStore } from '@renderer/stores/extension-store'
import { MONO_FONT } from '@renderer/lib/constants'
import { parseExtensionToolResult } from '@renderer/lib/extensions/extension-result'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import type { ExtensionToolResult } from '../../../../shared/extension-types'

const HTML_RENDERER_SOURCE = 'open_cowork_extension_renderer'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringifyData(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function readString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function readStringProp(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = readString(source[key]).trim()
    if (value) return value
  }
  return ''
}

function readArrayProp(source: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = source[key]
    if (Array.isArray(value)) return value.filter(isRecord)
  }
  return []
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => readString(item).trim()).filter(Boolean)
}

function safeHttpUrl(value: unknown): string {
  const raw = readString(value).trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

function formatFieldValue(value: unknown): string {
  const text = readString(value)
  if (text) return text
  return stringifyData(value)
}

function buildHtmlRendererDocument(html: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https: http:;" />
    <style>
      html, body { margin: 0; padding: 0; background: transparent; color: #e5e7eb; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      * { box-sizing: border-box; }
    </style>
  </head>
  <body>
    ${html}
    <script>
      (() => {
        const source = ${JSON.stringify(HTML_RENDERER_SOURCE)};
        const post = (type, extra = {}) => window.parent.postMessage({ source, type, ...extra }, '*');
        const measureHeight = () => {
          const children = Array.from(document.body.children).filter((node) => {
            const tag = node.tagName;
            return tag !== 'SCRIPT' && tag !== 'STYLE';
          });
          if (children.length === 0) return 80;
          const bodyTop = document.body.getBoundingClientRect().top;
          return Math.ceil(
            Math.max(
              ...children.map((node) => {
                const rect = node.getBoundingClientRect();
                const marginBottom = Number.parseFloat(window.getComputedStyle(node).marginBottom || '0') || 0;
                return rect.bottom - bodyTop + marginBottom;
              }),
              80
            )
          );
        };
        const reportSize = () => {
          const height = measureHeight();
          post('resize', { height });
        };
        window.addEventListener('message', (event) => {
          const data = event.data;
          if (!data || data.source !== source || data.type !== 'props') return;
          window.extensionProps = data.props || {};
          window.dispatchEvent(new CustomEvent('extension-props', { detail: window.extensionProps }));
          reportSize();
        });
        if (typeof ResizeObserver !== 'undefined') {
          new ResizeObserver(reportSize).observe(document.body);
        }
        post('ready');
        requestAnimationFrame(reportSize);
        setTimeout(reportSize, 120);
      })();
    </script>
  </body>
</html>`
}

function ExtensionAssetHtmlRenderer({
  extensionId,
  assetPath,
  title,
  props
}: {
  extensionId: string
  assetPath?: string
  title: string
  props: Record<string, unknown>
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const iframeRef = React.useRef<HTMLIFrameElement>(null)
  const [srcDoc, setSrcDoc] = React.useState('')
  const [height, setHeight] = React.useState(96)
  const [error, setError] = React.useState<string | null>(null)
  const loaded = useExtensionStore((state) => state.loaded)
  const loadExtensions = useExtensionStore((state) => state.loadExtensions)

  React.useEffect(() => {
    if (!loaded) void loadExtensions()
  }, [loadExtensions, loaded])

  React.useEffect(() => {
    let canceled = false
    setError(null)
    setSrcDoc('')
    setHeight(96)
    if (!loaded) return
    if (!assetPath) {
      setError(t('extensionResult.rendererMissing', { defaultValue: 'Renderer not found' }))
      return
    }
    ipcClient
      .invoke(IPC.EXTENSION_READ_ASSET, {
        id: extensionId,
        path: assetPath
      })
      .then((response) => {
        const data = response as { content?: string; error?: string }
        if (canceled) return
        if (data.error) {
          setError(data.error)
        } else {
          setSrcDoc(buildHtmlRendererDocument(data.content ?? ''))
        }
      })
      .catch((err) => {
        if (!canceled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      canceled = true
    }
  }, [assetPath, extensionId, loaded, t])

  React.useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data
      if (!isRecord(data) || data.source !== HTML_RENDERER_SOURCE) return
      if (data.type === 'ready') {
        iframeRef.current?.contentWindow?.postMessage(
          {
            source: HTML_RENDERER_SOURCE,
            type: 'props',
            props
          },
          '*'
        )
      }
      if (data.type === 'resize' && typeof data.height === 'number') {
        setHeight(Math.max(80, Math.min(1200, data.height)))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [props])

  if (error) {
    return (
      <div className="rounded-md border border-destructive/20 p-3 text-xs text-destructive">
        {error}
      </div>
    )
  }
  if (!srcDoc) {
    return (
      <div className="rounded-md border border-border/60 p-3 text-xs text-muted-foreground">
        {t('extensionResult.loadingRenderer', { defaultValue: 'Loading renderer...' })}
      </div>
    )
  }
  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className="block w-full rounded-lg border border-border/60 bg-transparent"
      style={{ height }}
      title={title || t('extensionResult.rendererTitle', { defaultValue: 'Extension renderer' })}
    />
  )
}

function ExtensionHtmlRenderer({
  result,
  ui
}: {
  result: ExtensionToolResult
  ui: Record<string, unknown>
}): React.JSX.Element {
  const rendererName = readStringProp(ui, ['renderer', 'name'])
  const extension = useExtensionStore((state) =>
    state.extensions.find((item) => item.id === result.extensionId)
  )
  const renderer = extension?.manifest.renderers?.find((item) => item.name === rendererName)

  return (
    <ExtensionAssetHtmlRenderer
      extensionId={result.extensionId}
      assetPath={renderer?.entry}
      title={rendererName}
      props={isRecord(ui.props) ? ui.props : { result, ui }}
    />
  )
}

function CardRenderer({ ui }: { ui: Record<string, unknown> }): React.JSX.Element {
  const title = typeof ui.title === 'string' ? ui.title : ''
  const subtitle = typeof ui.subtitle === 'string' ? ui.subtitle : ''
  const body = typeof ui.body === 'string' ? ui.body : ''
  const items = Array.isArray(ui.items) ? ui.items : []
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      {title && <div className="text-sm font-semibold text-foreground">{title}</div>}
      {subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>}
      {body && <p className="mt-2 whitespace-pre-wrap text-xs text-foreground/80">{body}</p>}
      {items.length > 0 && (
        <div className="mt-2 space-y-1">
          {items.slice(0, 12).map((item, index) => (
            <div key={index} className="rounded-md bg-background/60 px-2 py-1 text-xs">
              {stringifyData(item)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TableRenderer({
  ui,
  fallbackData
}: {
  ui: Record<string, unknown>
  fallbackData: unknown
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const rows = Array.isArray(ui.rows)
    ? ui.rows.filter(isRecord)
    : Array.isArray(fallbackData)
      ? fallbackData.filter(isRecord)
      : []
  const configuredColumns = Array.isArray(ui.columns)
    ? ui.columns.filter((item): item is string => typeof item === 'string')
    : []
  const columns =
    configuredColumns.length > 0
      ? configuredColumns
      : Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 8)

  if (rows.length === 0 || columns.length === 0) {
    return (
      <CardRenderer
        ui={{
          title: t('extensionResult.tableTitle', { defaultValue: 'Table' }),
          body: t('extensionResult.emptyTable', { defaultValue: 'No rows to display' })
        }}
      />
    )
  }

  return (
    <div className="overflow-auto rounded-lg border border-border/60">
      <table className="w-full min-w-[420px] border-collapse text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th
                key={column}
                className="border-b border-border/60 px-2 py-1.5 text-left font-medium"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 30).map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-muted/10">
              {columns.map((column) => (
                <td key={column} className="border-b border-border/40 px-2 py-1.5 align-top">
                  {stringifyData(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FormRenderer({ ui }: { ui: Record<string, unknown> }): React.JSX.Element {
  const fields = Array.isArray(ui.fields) ? ui.fields.filter(isRecord) : []
  return (
    <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/10 p-3">
      {fields.slice(0, 12).map((field, index) => {
        const label = String(field.label ?? field.name ?? `field_${index + 1}`)
        const value = String(field.value ?? '')
        return (
          <label key={index} className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{label}</span>
            <input
              value={value}
              readOnly
              className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-foreground"
            />
          </label>
        )
      })}
    </div>
  )
}

function ChartRenderer({ ui }: { ui: Record<string, unknown> }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const data = Array.isArray(ui.data) ? ui.data.filter(isRecord) : []
  const values = data.map((item) => Number(item.value ?? 0)).filter(Number.isFinite)
  const max = Math.max(...values, 1)
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/10 p-3">
      {data.slice(0, 12).map((item, index) => {
        const label = String(
          item.label ??
            item.name ??
            t('extensionResult.chartItem', {
              defaultValue: 'Item {{index}}',
              index: index + 1
            })
        )
        const value = Number(item.value ?? 0)
        const width = `${Math.max(2, Math.min(100, (value / max) * 100))}%`
        return (
          <div key={index} className="grid grid-cols-[120px_1fr_auto] items-center gap-2 text-xs">
            <span className="truncate text-muted-foreground" title={label}>
              {label}
            </span>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary/70" style={{ width }} />
            </div>
            <span className="font-mono text-muted-foreground" style={{ fontFamily: MONO_FONT }}>
              {Number.isFinite(value) ? value : 0}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function ComponentShell({
  icon,
  title,
  subtitle,
  children,
  action
}: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  children: React.ReactNode
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-background">
      <div className="flex items-start justify-between gap-3 border-b border-border/50 bg-muted/20 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/70 text-muted-foreground">
            {icon}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{title}</div>
            {subtitle ? (
              <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
            ) : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="p-3">{children}</div>
    </div>
  )
}

function FieldGrid({ fields }: { fields: Record<string, unknown>[] }): React.JSX.Element {
  if (fields.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border/60 bg-muted/10 px-2.5 py-2 text-xs text-muted-foreground">
        No display fields matched this result.
      </div>
    )
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {fields.slice(0, 12).map((field, index) => {
        const label = readStringProp(field, ['label', 'name', 'key']) || `Field ${index + 1}`
        const value = formatFieldValue(field.value ?? field.text)
        if (!value) return null
        return (
          <div key={index} className="rounded-md border border-border/50 bg-muted/10 px-2.5 py-2">
            <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
            <div className="mt-0.5 break-words text-xs text-foreground">{value}</div>
          </div>
        )
      })}
    </div>
  )
}

function SectionList({
  sections
}: {
  sections: Record<string, unknown>[]
}): React.JSX.Element | null {
  if (sections.length === 0) return null

  return (
    <div className="space-y-3">
      {sections.slice(0, 6).map((section, index) => {
        const title = readStringProp(section, ['title', 'name']) || `Section ${index + 1}`
        const items = readArrayProp(section, ['items', 'rows'])
        if (items.length === 0) return null
        return (
          <div
            key={`${title}-${index}`}
            className="rounded-md border border-border/50 bg-muted/10 p-3"
          >
            <div className="text-xs font-semibold text-foreground">{title}</div>
            <div className="mt-2 space-y-2">
              {items.slice(0, 12).map((item, itemIndex) => {
                const label =
                  readStringProp(item, ['label', 'name', 'key']) || `Field ${itemIndex + 1}`
                const value = formatFieldValue(item.value ?? item.text)
                const badge = readStringProp(item, ['badge'])
                const imageUrl = safeHttpUrl(
                  readStringProp(item, [
                    'imageUrl',
                    'pictureUrl',
                    'breviaryPicUrl',
                    'bigPicUrl',
                    'picture'
                  ])
                )
                const details = readStringArray(item.details)
                if (!value && details.length === 0 && !imageUrl && !badge) return null
                return (
                  <div
                    key={itemIndex}
                    className="rounded-md border border-border/50 bg-background/70 p-2.5"
                  >
                    <div
                      className={
                        imageUrl ? 'grid gap-3 sm:grid-cols-[56px_minmax(0,1fr)]' : 'grid gap-2'
                      }
                    >
                      {imageUrl ? (
                        <div className="overflow-hidden rounded-md border border-border/50 bg-muted/10">
                          <img src={imageUrl} alt={label} className="h-14 w-14 object-cover" />
                        </div>
                      ) : null}
                      <div className="min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-medium text-foreground">{label}</div>
                          {badge ? <Badge variant="outline">{badge}</Badge> : null}
                        </div>
                        <div className="mt-1 break-words text-xs text-foreground">{value}</div>
                        {details.length ? (
                          <div className="mt-2 space-y-1">
                            {details.map((detail, detailIndex) => (
                              <div
                                key={detailIndex}
                                className="break-words text-[11px] text-muted-foreground"
                              >
                                {detail}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LuckinShopListComponent({ props }: { props: Record<string, unknown> }): React.JSX.Element {
  const shops = readArrayProp(props, ['shops', 'items', 'rows'])
  const title = readStringProp(props, ['title']) || 'Luckin stores'
  const subtitle = readStringProp(props, ['subtitle'])

  return (
    <ComponentShell icon={<Store className="size-4" />} title={title} subtitle={subtitle}>
      <div className="space-y-2">
        {shops.slice(0, 8).map((shop, index) => {
          const name =
            readStringProp(shop, ['deptName', 'name', 'storeName']) || `Store ${index + 1}`
          const address = readStringProp(shop, ['address', 'deptAddress', 'storeAddress'])
          const businessTime = readStringProp(shop, ['businessTime', 'openingHours', 'hours'])
          const distance = readStringProp(shop, ['distanceText', 'distance'])
          const deptId = readStringProp(shop, ['deptId', 'id'])
          return (
            <div
              key={`${deptId || name}-${index}`}
              className="rounded-md border border-border/50 p-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{name}</div>
                  {address ? (
                    <div className="mt-1 flex gap-1.5 text-xs leading-5 text-muted-foreground">
                      <MapPin className="mt-0.5 size-3 shrink-0" />
                      <span className="break-words">{address}</span>
                    </div>
                  ) : null}
                </div>
                {deptId ? <Badge variant="outline">{deptId}</Badge> : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {businessTime ? <Badge variant="secondary">{businessTime}</Badge> : null}
                {distance ? <Badge variant="outline">{distance}</Badge> : null}
              </div>
            </div>
          )
        })}
      </div>
    </ComponentShell>
  )
}

function LuckinProductListComponent({
  props
}: {
  props: Record<string, unknown>
}): React.JSX.Element {
  const products = readArrayProp(props, ['products', 'items', 'rows'])
  const title = readStringProp(props, ['title']) || 'Luckin products'
  const subtitle = readStringProp(props, ['subtitle'])

  return (
    <ComponentShell icon={<Coffee className="size-4" />} title={title} subtitle={subtitle}>
      <div className="grid gap-2 sm:grid-cols-2">
        {products.slice(0, 10).map((product, index) => {
          const name =
            readStringProp(product, ['productName', 'name', 'title']) || `Product ${index + 1}`
          const sku = readStringProp(product, ['attributeSummary', 'skuName', 'skuCode', 'spec'])
          const productId = readStringProp(product, ['productId', 'id'])
          const price = readStringProp(product, [
            'badgeText',
            'estimatePrice',
            'discountPrice',
            'price',
            'initialPriceText'
          ])
          const imageUrl = safeHttpUrl(
            readStringProp(product, [
              'imageUrl',
              'pictureUrl',
              'breviaryPicUrl',
              'bigPicUrl',
              'picture'
            ])
          )
          const tags = readStringProp(product, ['tagsText'])
          const initialPrice = readStringProp(product, ['initialPriceText'])
          const details = readStringArray(product.details)
          return (
            <div
              key={`${productId || name}-${index}`}
              className="rounded-md border border-border/50 p-2.5"
            >
              <div
                className={imageUrl ? 'grid gap-3 sm:grid-cols-[64px_minmax(0,1fr)]' : 'grid gap-2'}
              >
                {imageUrl ? (
                  <div className="overflow-hidden rounded-md border border-border/50 bg-muted/10">
                    <img src={imageUrl} alt={name} className="h-16 w-16 object-cover" />
                  </div>
                ) : null}
                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{name}</div>
                      {sku ? (
                        <div className="mt-1 break-words text-xs text-muted-foreground">{sku}</div>
                      ) : null}
                    </div>
                    {price ? <Badge variant="secondary">{price}</Badge> : null}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {productId ? <Badge variant="outline">productId: {productId}</Badge> : null}
                    {tags ? <Badge variant="outline">{tags}</Badge> : null}
                    {initialPrice && initialPrice !== price ? (
                      <Badge variant="outline">原价 {initialPrice}</Badge>
                    ) : null}
                  </div>
                  {details.length ? (
                    <div className="mt-2 space-y-1">
                      {details.slice(0, 4).map((detail, detailIndex) => (
                        <div
                          key={detailIndex}
                          className="break-words text-[11px] text-muted-foreground"
                        >
                          {detail}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </ComponentShell>
  )
}

function LuckinSummaryComponent({
  props,
  fallbackTitle,
  icon
}: {
  props: Record<string, unknown>
  fallbackTitle: string
  icon: React.ReactNode
}): React.JSX.Element {
  const title = readStringProp(props, ['title']) || fallbackTitle
  const subtitle = readStringProp(props, ['subtitle'])
  const fields = readArrayProp(props, ['fields', 'items'])
  const sections = readArrayProp(props, ['sections'])
  return (
    <ComponentShell icon={icon} title={title} subtitle={subtitle}>
      <div className="space-y-3">
        <FieldGrid fields={fields} />
        <SectionList sections={sections} />
      </div>
    </ComponentShell>
  )
}

function LuckinPaymentComponent({ props }: { props: Record<string, unknown> }): React.JSX.Element {
  const qrCodeUrl = safeHttpUrl(readStringProp(props, ['qrCodeUrl', 'payOrderQrCodeUrl']))
  const openUrl = safeHttpUrl(readStringProp(props, ['openUrl'])) || qrCodeUrl
  const title = readStringProp(props, ['title']) || 'Luckin payment'
  const subtitle = readStringProp(props, ['subtitle'])
  const fields = readArrayProp(props, ['fields', 'items'])

  return (
    <ComponentShell
      icon={<CreditCard className="size-4" />}
      title={title}
      subtitle={subtitle}
      action={
        openUrl ? (
          <Button asChild size="xs" variant="outline">
            <a href={openUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3" />
              Open
            </a>
          </Button>
        ) : null
      }
    >
      <div className="grid gap-3 md:grid-cols-[160px_1fr]">
        {qrCodeUrl ? (
          <div className="flex items-center justify-center rounded-md border border-border/50 bg-white p-2">
            <img src={qrCodeUrl} alt="Payment QR code" className="size-36 object-contain" />
          </div>
        ) : null}
        <div className="min-w-0 space-y-3">
          <FieldGrid fields={fields} />
          {openUrl ? (
            <a
              href={openUrl}
              target="_blank"
              rel="noreferrer"
              className="block break-all rounded-md border border-border/50 bg-muted/10 px-2.5 py-2 text-xs text-primary"
            >
              {openUrl}
            </a>
          ) : null}
        </div>
      </div>
    </ComponentShell>
  )
}

function ExtensionComponentRenderer({
  result,
  ui
}: {
  result: ExtensionToolResult
  ui: Record<string, unknown>
}): React.JSX.Element | null {
  const props = isRecord(ui.props) ? ui.props : ui
  const component = readStringProp(ui, ['component', 'name', 'renderer'])
  const extension = useExtensionStore((state) =>
    state.extensions.find((item) => item.id === result.extensionId)
  )
  const customComponent = extension?.manifest.components?.find((item) => item.name === component)

  if (customComponent) {
    return (
      <ExtensionAssetHtmlRenderer
        extensionId={result.extensionId}
        assetPath={customComponent.entry}
        title={customComponent.title ?? customComponent.name}
        props={props}
      />
    )
  }

  if (component === 'luckin_shop_list') return <LuckinShopListComponent props={props} />
  if (component === 'luckin_product_list') return <LuckinProductListComponent props={props} />
  if (component === 'luckin_payment') return <LuckinPaymentComponent props={props} />
  if (component === 'luckin_order_summary') {
    return (
      <LuckinSummaryComponent
        props={props}
        fallbackTitle="Luckin order"
        icon={<ReceiptText className="size-4" />}
      />
    )
  }
  if (component === 'luckin_status') {
    return (
      <LuckinSummaryComponent
        props={props}
        fallbackTitle="Luckin status"
        icon={<PackageSearch className="size-4" />}
      />
    )
  }

  return (
    <CardRenderer
      ui={{
        title: component || 'Extension component',
        subtitle: result.extensionId,
        body: stringifyData(props)
      }}
    />
  )
}

function SchemaRenderer({ result }: { result: ExtensionToolResult }): React.JSX.Element | null {
  const ui = isRecord(result.ui) ? result.ui : null
  if (!ui) return null
  const kind = ui.kind
  if (kind === 'card') return <CardRenderer ui={ui} />
  if (kind === 'table') return <TableRenderer ui={ui} fallbackData={result.data} />
  if (kind === 'form') return <FormRenderer ui={ui} />
  if (kind === 'chart') return <ChartRenderer ui={ui} />
  if (kind === 'html') return <ExtensionHtmlRenderer result={result} ui={ui} />
  if (kind === 'component') return <ExtensionComponentRenderer result={result} ui={ui} />
  return null
}

export function ExtensionToolResultCard({
  output
}: {
  output?: ToolResultContent
}): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const result = parseExtensionToolResult(output)
  if (!result) return null
  const dataText = stringifyData(result.data)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex size-6 items-center justify-center rounded-md border border-border/60 bg-muted/30">
          <Puzzle className="size-3.5" />
        </span>
        <span className="font-medium text-foreground/80">
          {t('extensionResult.title', { defaultValue: 'Extension result' })}
        </span>
        <span className="font-mono text-[11px]">{result.extensionId}</span>
      </div>
      {result.text ? (
        <div className="whitespace-pre-wrap rounded-md border border-border/60 bg-muted/15 px-3 py-2 text-xs text-foreground/80">
          {result.text}
        </div>
      ) : null}
      <SchemaRenderer result={result} />
      {dataText && !result.ui ? (
        <pre
          className="max-h-60 overflow-auto rounded-md border border-border/60 bg-muted/15 p-2 text-xs"
          style={{ fontFamily: MONO_FONT }}
        >
          {dataText}
        </pre>
      ) : null}
    </div>
  )
}
