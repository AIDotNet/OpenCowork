/**
 * Resolves a file-type icon from a file name or path.
 *
 * Icon geometry is stored as lucide `IconNode` tuples so the same definition can drive both a
 * React element (`<Icon iconNode={...} />` from lucide-react) and a raw SVG string for the
 * imperative chips built inside the contenteditable composer.
 */

export type FileTypeIconTag = 'path' | 'circle' | 'rect' | 'line' | 'polyline' | 'polygon'

export type FileTypeIconNode = [tag: FileTypeIconTag, attrs: Record<string, string>][]

export type FileTypeIconKind =
  | 'document'
  | 'pdf'
  | 'markdown'
  | 'text'
  | 'spreadsheet'
  | 'presentation'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'code'
  | 'data'
  | 'config'
  | 'shell'
  | 'secret'
  | 'font'
  | 'unknown'

export interface FileTypeIconDescriptor {
  kind: FileTypeIconKind
  /** Lowercase extension without the leading dot; empty when the name has none. */
  extension: string
  iconNode: FileTypeIconNode
  /** Tailwind text color for the glyph. */
  className: string
}

const FILE_BODY: FileTypeIconNode = [
  [
    'path',
    {
      d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
      key: 'body'
    }
  ],
  ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5', key: 'fold' }]
]

function withFileBody(...marks: FileTypeIconNode): FileTypeIconNode {
  return [...FILE_BODY, ...marks]
}

const ICON_FILE: FileTypeIconNode = FILE_BODY

const ICON_FILE_TEXT = withFileBody(
  ['path', { d: 'M10 9H8', key: 'l1' }],
  ['path', { d: 'M16 13H8', key: 'l2' }],
  ['path', { d: 'M16 17H8', key: 'l3' }]
)

const ICON_FILE_TYPE = withFileBody(
  ['path', { d: 'M11 18h2', key: 't1' }],
  ['path', { d: 'M12 12v6', key: 't2' }],
  ['path', { d: 'M9 13v-.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v.5', key: 't3' }]
)

const ICON_FILE_SPREADSHEET = withFileBody(
  ['path', { d: 'M8 13h2', key: 's1' }],
  ['path', { d: 'M14 13h2', key: 's2' }],
  ['path', { d: 'M8 17h2', key: 's3' }],
  ['path', { d: 'M14 17h2', key: 's4' }]
)

const ICON_FILE_CHART = withFileBody(
  ['path', { d: 'M8 18v-1', key: 'c1' }],
  ['path', { d: 'M12 18v-6', key: 'c2' }],
  ['path', { d: 'M16 18v-3', key: 'c3' }]
)

const ICON_FILE_IMAGE = withFileBody(
  ['circle', { cx: '10', cy: '12', r: '2', key: 'i1' }],
  ['path', { d: 'm20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22', key: 'i2' }]
)

const ICON_FILE_PLAY = withFileBody([
  'path',
  {
    d: 'M15.033 13.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56v-4.704a.645.645 0 0 1 .967-.56z',
    key: 'p1'
  }
])

const ICON_FILE_MUSIC: FileTypeIconNode = [
  [
    'path',
    {
      d: 'M11.65 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v10.35',
      key: 'body'
    }
  ],
  ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5', key: 'fold' }],
  ['path', { d: 'M8 20v-7l3 1.474', key: 'm1' }],
  ['circle', { cx: '6', cy: '20', r: '2', key: 'm2' }]
]

const ICON_FILE_ARCHIVE: FileTypeIconNode = [
  [
    'path',
    {
      d: 'M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5',
      key: 'body'
    }
  ],
  ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5', key: 'fold' }],
  ['path', { d: 'M8 12v-1', key: 'a1' }],
  ['path', { d: 'M8 18v-2', key: 'a2' }],
  ['path', { d: 'M8 7V6', key: 'a3' }],
  ['circle', { cx: '8', cy: '20', r: '2', key: 'a4' }]
]

const ICON_FILE_CODE = withFileBody(
  ['path', { d: 'M10 12.5 8 15l2 2.5', key: 'k1' }],
  ['path', { d: 'm14 12.5 2 2.5-2 2.5', key: 'k2' }]
)

const ICON_FILE_BRACES = withFileBody(
  ['path', { d: 'M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1', key: 'b1' }],
  ['path', { d: 'M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1', key: 'b2' }]
)

const ICON_FILE_TERMINAL = withFileBody(
  ['path', { d: 'm8 16 2-2-2-2', key: 'x1' }],
  ['path', { d: 'M12 18h4', key: 'x2' }]
)

const ICON_FILE_COG: FileTypeIconNode = [
  [
    'path',
    {
      d: 'M13.85 22H18a2 2 0 0 0 2-2V8a2 2 0 0 0-.586-1.414l-4-4A2 2 0 0 0 14 2H6a2 2 0 0 0-2 2v6.6',
      key: 'body'
    }
  ],
  ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5', key: 'fold' }],
  ['path', { d: 'm3.305 19.53.923-.382', key: 'g1' }],
  ['path', { d: 'm4.228 16.852-.924-.383', key: 'g2' }],
  ['path', { d: 'm5.852 15.228-.383-.923', key: 'g3' }],
  ['path', { d: 'm5.852 20.772-.383.924', key: 'g4' }],
  ['path', { d: 'm8.148 15.228.383-.923', key: 'g5' }],
  ['path', { d: 'm8.53 21.696-.382-.924', key: 'g6' }],
  ['path', { d: 'm9.773 16.852.922-.383', key: 'g7' }],
  ['path', { d: 'm9.773 19.148.922.383', key: 'g8' }],
  ['circle', { cx: '7', cy: '18', r: '3', key: 'g9' }]
]

const ICON_FILE_LOCK: FileTypeIconNode = [
  [
    'path',
    {
      d: 'M4 9.8V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3',
      key: 'body'
    }
  ],
  ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5', key: 'fold' }],
  ['path', { d: 'M9 17v-2a2 2 0 0 0-4 0v2', key: 'w1' }],
  ['rect', { width: '8', height: '5', x: '3', y: '17', rx: '1', key: 'w2' }]
]

interface KindStyle {
  iconNode: FileTypeIconNode
  className: string
}

const KIND_STYLES: Record<FileTypeIconKind, KindStyle> = {
  document: { iconNode: ICON_FILE_TEXT, className: 'text-blue-500 dark:text-blue-400' },
  pdf: { iconNode: ICON_FILE_TEXT, className: 'text-red-500 dark:text-red-400' },
  markdown: { iconNode: ICON_FILE_TYPE, className: 'text-violet-500 dark:text-violet-400' },
  text: { iconNode: ICON_FILE_TEXT, className: 'text-muted-foreground' },
  spreadsheet: {
    iconNode: ICON_FILE_SPREADSHEET,
    className: 'text-emerald-600 dark:text-emerald-400'
  },
  presentation: { iconNode: ICON_FILE_CHART, className: 'text-orange-500 dark:text-orange-400' },
  image: { iconNode: ICON_FILE_IMAGE, className: 'text-pink-500 dark:text-pink-400' },
  video: { iconNode: ICON_FILE_PLAY, className: 'text-fuchsia-500 dark:text-fuchsia-400' },
  audio: { iconNode: ICON_FILE_MUSIC, className: 'text-indigo-500 dark:text-indigo-400' },
  archive: { iconNode: ICON_FILE_ARCHIVE, className: 'text-amber-600 dark:text-amber-500' },
  code: { iconNode: ICON_FILE_CODE, className: 'text-sky-500 dark:text-sky-400' },
  data: { iconNode: ICON_FILE_BRACES, className: 'text-yellow-600 dark:text-yellow-500' },
  config: { iconNode: ICON_FILE_COG, className: 'text-slate-500 dark:text-slate-400' },
  shell: { iconNode: ICON_FILE_TERMINAL, className: 'text-teal-500 dark:text-teal-400' },
  secret: { iconNode: ICON_FILE_LOCK, className: 'text-rose-500 dark:text-rose-400' },
  font: { iconNode: ICON_FILE_TYPE, className: 'text-purple-500 dark:text-purple-400' },
  unknown: { iconNode: ICON_FILE, className: 'text-muted-foreground' }
}

const EXTENSION_KINDS: Record<string, FileTypeIconKind> = {}

function registerExtensions(kind: FileTypeIconKind, extensions: string[]): void {
  for (const extension of extensions) {
    EXTENSION_KINDS[extension] = kind
  }
}

registerExtensions('document', ['doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'rtf', 'pages', 'wps'])
registerExtensions('pdf', ['pdf'])
registerExtensions('markdown', ['md', 'mdx', 'markdown', 'mdown', 'rst', 'adoc'])
registerExtensions('text', ['txt', 'log', 'text', 'nfo', 'srt', 'vtt'])
registerExtensions('spreadsheet', [
  'xls',
  'xlsx',
  'xlsm',
  'xlsb',
  'ods',
  'csv',
  'tsv',
  'numbers',
  'et'
])
registerExtensions('presentation', ['ppt', 'pptx', 'pptm', 'odp', 'key', 'dps'])
registerExtensions('image', [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'tif',
  'tiff',
  'avif',
  'heic',
  'psd',
  'ai',
  'fig',
  'sketch'
])
registerExtensions('video', [
  'mp4',
  'mov',
  'avi',
  'mkv',
  'webm',
  'flv',
  'wmv',
  'm4v',
  'mpeg',
  'mpg'
])
registerExtensions('audio', ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff'])
registerExtensions('archive', ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'zst', 'iso'])
registerExtensions('code', [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'vue',
  'svelte',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'scala',
  'dart',
  'lua',
  'r',
  'pl',
  'ex',
  'exs',
  'erl',
  'hs',
  'clj',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'razor',
  'cshtml',
  'vb',
  'sql',
  'ipynb'
])
registerExtensions('data', ['json', 'json5', 'jsonc', 'xml', 'yaml', 'yml', 'toml', 'db', 'sqlite'])
registerExtensions('config', [
  'ini',
  'cfg',
  'conf',
  'properties',
  'editorconfig',
  'gitignore',
  'gitattributes',
  'dockerignore',
  'lock',
  'plist'
])
registerExtensions('shell', ['sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'mjs.sh'])
registerExtensions('secret', ['env', 'pem', 'key', 'crt', 'cer', 'p12', 'pfx', 'keystore', 'jks'])
registerExtensions('font', ['ttf', 'otf', 'woff', 'woff2', 'eot'])

/** Full file names that carry more meaning than their (missing) extension. */
const FILENAME_KINDS: Record<string, FileTypeIconKind> = {
  dockerfile: 'config',
  makefile: 'shell',
  procfile: 'config',
  license: 'text',
  readme: 'markdown',
  '.env': 'secret',
  '.gitignore': 'config',
  '.editorconfig': 'config'
}

export function getFileBaseName(pathOrName: string): string {
  const normalized = pathOrName.replace(/\\/g, '/').replace(/\/+$/, '')
  const segments = normalized.split('/')
  return segments[segments.length - 1] || normalized
}

export function getFileExtension(pathOrName: string): string {
  const baseName = getFileBaseName(pathOrName)
  const dotIndex = baseName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) return ''
  return baseName.slice(dotIndex + 1).toLowerCase()
}

export function resolveFileTypeIcon(pathOrName: string): FileTypeIconDescriptor {
  const baseName = getFileBaseName(pathOrName || '')
  const extension = getFileExtension(baseName)
  const kind =
    EXTENSION_KINDS[extension] ?? FILENAME_KINDS[baseName.toLowerCase()] ?? ('unknown' as const)
  const style = KIND_STYLES[kind]

  return { kind, extension, iconNode: style.iconNode, className: style.className }
}

function escapeSvgAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function iconNodeToSvgMarkup(iconNode: FileTypeIconNode, className: string): string {
  const children = iconNode
    .map(([tag, attrs]) => {
      const serialized = Object.entries(attrs)
        .filter(([name]) => name !== 'key')
        .map(([name, value]) => `${name}="${escapeSvgAttribute(String(value))}"`)
        .join(' ')
      return `<${tag}${serialized ? ` ${serialized}` : ''}></${tag}>`
    })
    .join('')

  return (
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ` +
    `class="${escapeSvgAttribute(className)}">${children}</svg>`
  )
}

/**
 * SVG markup for imperative DOM consumers (the composer's contenteditable chips), where mounting a
 * React root per chip would be wasteful.
 */
export function renderFileTypeIconSvg(pathOrName: string, sizeClassName = 'size-3.5'): string {
  const descriptor = resolveFileTypeIcon(pathOrName)
  return iconNodeToSvgMarkup(descriptor.iconNode, `${sizeClassName} ${descriptor.className}`)
}

/** Same builder, for icons that are not derived from a file name (plugin chips, folders). */
export function renderIconSvg(iconNode: FileTypeIconNode, className: string): string {
  return iconNodeToSvgMarkup(iconNode, className)
}
