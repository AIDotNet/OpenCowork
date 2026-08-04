import * as React from 'react'
import { viewerRegistry } from './viewer-registry'

const HtmlViewer = React.lazy(async () => {
  const mod = await import('./viewers/html-viewer')
  return { default: mod.HtmlViewer }
})

const SpreadsheetViewer = React.lazy(async () => {
  const mod = await import('./viewers/spreadsheet')
  return { default: mod.SpreadsheetViewer }
})

const MarkdownViewer = React.lazy(async () => {
  const mod = await import('./viewers/markdown-viewer')
  return { default: mod.MarkdownViewer }
})

const ImageViewer = React.lazy(async () => {
  const mod = await import('./viewers/image-viewer')
  return { default: mod.ImageViewer }
})

const SvgViewer = React.lazy(async () => {
  const mod = await import('./viewers/svg-viewer')
  return { default: mod.SvgViewer }
})

const VideoViewer = React.lazy(async () => {
  const mod = await import('./viewers/video-viewer')
  return { default: mod.VideoViewer }
})

const AudioViewer = React.lazy(async () => {
  const mod = await import('./viewers/audio-viewer')
  return { default: mod.AudioViewer }
})

const FontViewer = React.lazy(async () => {
  const mod = await import('./viewers/font-viewer')
  return { default: mod.FontViewer }
})

const BinaryFileViewer = React.lazy(async () => {
  const mod = await import('./viewers/binary-file-viewer')
  return { default: mod.BinaryFileViewer }
})

const OfficeOnlineViewer = React.lazy(async () => {
  const mod = await import('./viewers/office-online-viewer')
  return { default: mod.OfficeOnlineViewer }
})

const DocxViewer = React.lazy(async () => {
  const mod = await import('./viewers/docx-viewer')
  return { default: mod.DocxViewer }
})

const PdfViewer = React.lazy(async () => {
  const mod = await import('./viewers/pdf-viewer')
  return { default: mod.PdfViewer }
})

const FallbackViewer = React.lazy(async () => {
  const mod = await import('./viewers/fallback-viewer')
  return { default: mod.FallbackViewer }
})

export function registerAllViewers(): void {
  viewerRegistry.register({
    type: 'html',
    extensions: ['.html', '.htm', '.xhtml', '.shtml'],
    component: HtmlViewer
  })

  viewerRegistry.register({
    type: 'spreadsheet',
    extensions: ['.csv', '.tsv', '.xlsx', '.xls', '.xlsm', '.xlsb', '.ods'],
    component: SpreadsheetViewer
  })

  viewerRegistry.register({
    type: 'markdown',
    extensions: ['.md', '.mdx', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn'],
    component: MarkdownViewer
  })

  viewerRegistry.register({
    type: 'image',
    extensions: [
      '.png',
      '.jpg',
      '.jpeg',
      '.jfif',
      '.pjpeg',
      '.pjp',
      '.gif',
      '.apng',
      '.bmp',
      '.webp',
      '.avif',
      '.ico',
      '.cur',
      '.tif',
      '.tiff',
      '.heic',
      '.heif',
      '.jxl'
    ],
    component: ImageViewer
  })

  viewerRegistry.register({
    type: 'svg',
    extensions: ['.svg'],
    component: SvgViewer
  })

  viewerRegistry.register({
    type: 'video',
    extensions: [
      '.mp4',
      '.webm',
      '.ogv',
      '.mov',
      '.m4v',
      '.mkv',
      '.avi',
      '.mpeg',
      '.mpg',
      '.3gp',
      '.3g2',
      '.mts',
      '.m2ts'
    ],
    component: VideoViewer
  })

  viewerRegistry.register({
    type: 'audio',
    extensions: [
      '.mp3',
      '.wav',
      '.wave',
      '.ogg',
      '.oga',
      '.m4a',
      '.aac',
      '.flac',
      '.opus',
      '.weba',
      '.aif',
      '.aiff'
    ],
    component: AudioViewer
  })

  viewerRegistry.register({
    type: 'font',
    extensions: ['.ttf', '.otf', '.woff', '.woff2'],
    component: FontViewer
  })

  viewerRegistry.register({
    type: 'docx',
    extensions: ['.docx', '.docm', '.dotx', '.dotm'],
    component: DocxViewer
  })

  viewerRegistry.register({
    type: 'office-online',
    extensions: ['.doc', '.ppt', '.pptx', '.pps', '.ppsx', '.odp', '.odt', '.ott', '.rtf'],
    component: OfficeOnlineViewer
  })

  viewerRegistry.register({
    type: 'pdf',
    extensions: ['.pdf'],
    component: PdfViewer
  })

  viewerRegistry.register({
    type: 'binary',
    extensions: [
      '.zip',
      '.rar',
      '.7z',
      '.tar',
      '.gz',
      '.tgz',
      '.bz2',
      '.xz',
      '.zst',
      '.jar',
      '.war',
      '.ear',
      '.dmg',
      '.iso',
      '.img',
      '.exe',
      '.msi',
      '.dll',
      '.so',
      '.dylib',
      '.bin',
      '.dat',
      '.sqlite',
      '.sqlite3',
      '.db'
    ],
    component: BinaryFileViewer
  })

  viewerRegistry.register({
    type: 'fallback',
    extensions: [],
    component: FallbackViewer
  })
}
