import { app, ipcMain, nativeImage } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { encodeGif } from '../image/gif-encoder'
const IMAGE_CREATE_GIF_FROM_GRID = 'image:create-gif-from-grid'

const GENERATED_IMAGES_DIR = 'generated-images'
const GRID_SIZE = 768
const GRID_COLUMNS = 3
const GRID_ROWS = 3
const FRAME_COUNT = GRID_COLUMNS * GRID_ROWS
const FRAME_SIZE = GRID_SIZE / GRID_COLUMNS
const VISIBLE_ALPHA_THRESHOLD = 32
const EMPTY_EDGE_ALPHA_THRESHOLD = 8
const GAP_LINE_ALPHA_THRESHOLD = 8
const GAP_LINE_REQUIRED_RATIO = 0.98
const MAX_SIZE_DRIFT_RATIO = 0.14
const MAX_CENTER_DRIFT_RATIO = 0.08
const MAX_BOTTOM_DRIFT_RATIO = 0.08

interface PersistedImageResult {
  filePath: string
  mediaType: string
  data: string
}

interface FrameContentStats {
  bboxWidthRatio: number
  bboxHeightRatio: number
  centerXRatio: number
  bottomYRatio: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function getGeneratedImagesDir(): string {
  const dir = join(app.getPath('userData'), GENERATED_IMAGES_DIR)
  mkdirSync(dir, { recursive: true })
  return dir
}

function toPersistedImageResult(
  filePath: string,
  buffer: Buffer,
  mediaType: string
): PersistedImageResult {
  writeFileSync(filePath, buffer)
  return {
    filePath,
    mediaType,
    data: buffer.toString('base64')
  }
}

function loadSourceBuffer(args: { filePath?: string; data?: string }): Buffer {
  if (typeof args.filePath === 'string' && args.filePath.trim()) {
    return readFileSync(args.filePath)
  }

  if (typeof args.data === 'string' && args.data.trim()) {
    return Buffer.from(args.data, 'base64')
  }

  throw new Error('Missing source image file path or base64 data.')
}

function ensureSquareImage(image: Electron.NativeImage): void {
  const { width, height } = image.getSize()
  if (width <= 0 || height <= 0) {
    throw new Error('Generated image is empty.')
  }
  if (width !== height) {
    throw new Error('Generated image must be square before slicing into a 3x3 grid.')
  }
}

function normalizeGridImage(image: Electron.NativeImage): Electron.NativeImage {
  const { width, height } = image.getSize()
  if (width === GRID_SIZE && height === GRID_SIZE) {
    return image
  }

  return image.resize({ width: GRID_SIZE, height: GRID_SIZE, quality: 'best' })
}

function buildOutputDir(runId?: string): string {
  const segment = `${Date.now()}-${runId || randomUUID()}`
  const dir = join(getGeneratedImagesDir(), `gif-grid-${segment}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function trimUniformTransparentEdges(
  bitmap: Buffer,
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } {
  let top = 0
  let bottom = height - 1
  let left = 0
  let right = width - 1

  const isRowTransparent = (y: number): boolean => {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      if (bitmap[offset + 3] > EMPTY_EDGE_ALPHA_THRESHOLD) {
        return false
      }
    }
    return true
  }

  const isColumnTransparent = (x: number): boolean => {
    for (let y = 0; y < height; y += 1) {
      const offset = (y * width + x) * 4
      if (bitmap[offset + 3] > EMPTY_EDGE_ALPHA_THRESHOLD) {
        return false
      }
    }
    return true
  }

  while (top <= bottom && isRowTransparent(top)) top += 1
  while (bottom >= top && isRowTransparent(bottom)) bottom -= 1
  while (left <= right && isColumnTransparent(left)) left += 1
  while (right >= left && isColumnTransparent(right)) right -= 1

  if (left > right || top > bottom) {
    return { x: 0, y: 0, width, height }
  }

  return {
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1
  }
}

function findGapBands(
  bitmap: Buffer,
  width: number,
  height: number,
  axis: 'row' | 'column'
): Array<{ start: number; end: number }> {
  const lineLength = axis === 'row' ? width : height
  const lineCount = axis === 'row' ? height : width
  const emptyLines: boolean[] = []

  for (let line = 0; line < lineCount; line += 1) {
    let transparentPixels = 0
    for (let offset = 0; offset < lineLength; offset += 1) {
      const x = axis === 'row' ? offset : line
      const y = axis === 'row' ? line : offset
      const pixelOffset = (y * width + x) * 4
      if (bitmap[pixelOffset + 3] <= GAP_LINE_ALPHA_THRESHOLD) {
        transparentPixels += 1
      }
    }
    emptyLines.push(transparentPixels / lineLength >= GAP_LINE_REQUIRED_RATIO)
  }

  const bands: Array<{ start: number; end: number }> = []
  let currentStart = -1

  for (let i = 0; i < emptyLines.length; i += 1) {
    if (emptyLines[i]) {
      if (currentStart === -1) currentStart = i
      continue
    }

    if (currentStart !== -1) {
      bands.push({ start: currentStart, end: i - 1 })
      currentStart = -1
    }
  }

  if (currentStart !== -1) {
    bands.push({ start: currentStart, end: emptyLines.length - 1 })
  }

  return bands
}

function selectInnerGapBands(
  bands: Array<{ start: number; end: number }>,
  fullSize: number
): Array<{ start: number; end: number }> {
  return bands
    .filter((band) => band.start > 0 && band.end < fullSize - 1)
    .sort((a, b) => a.start - b.start)
}

function resolveGridSegments(
  bitmap: Buffer,
  width: number,
  height: number,
  axis: 'row' | 'column',
  count: number
): Array<{ start: number; size: number }> {
  const fullSize = axis === 'row' ? height : width
  const expectedSize = fullSize / count
  const innerBands = selectInnerGapBands(findGapBands(bitmap, width, height, axis), fullSize)

  if (innerBands.length < count - 1) {
    return Array.from({ length: count }, (_, index) => ({
      start: Math.round(index * expectedSize),
      size: Math.round((index + 1) * expectedSize) - Math.round(index * expectedSize)
    }))
  }

  const chosenBands = innerBands
    .sort((a, b) => {
      const centerA = (a.start + a.end) / 2
      const centerB = (b.start + b.end) / 2
      const targetIndexA = Math.round(centerA / expectedSize) - 1
      const targetIndexB = Math.round(centerB / expectedSize) - 1
      const expectedCenterA = expectedSize * (targetIndexA + 1)
      const expectedCenterB = expectedSize * (targetIndexB + 1)
      const distanceA = Math.abs(centerA - expectedCenterA)
      const distanceB = Math.abs(centerB - expectedCenterB)
      return distanceA - distanceB
    })
    .slice(0, count - 1)
    .sort((a, b) => a.start - b.start)

  const segments: Array<{ start: number; size: number }> = []
  let cursor = 0

  for (const band of chosenBands) {
    segments.push({ start: cursor, size: band.start - cursor })
    cursor = band.end + 1
  }

  segments.push({ start: cursor, size: fullSize - cursor })

  if (segments.length !== count || segments.some((segment) => segment.size <= 0)) {
    return Array.from({ length: count }, (_, index) => ({
      start: Math.round(index * expectedSize),
      size: Math.round((index + 1) * expectedSize) - Math.round(index * expectedSize)
    }))
  }

  return segments
}

function analyzeFrameContent(bitmap: Buffer, width: number, height: number): FrameContentStats {
  const trimmedBounds = trimUniformTransparentEdges(bitmap, width, height)
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = trimmedBounds.y; y < trimmedBounds.y + trimmedBounds.height; y += 1) {
    for (let x = trimmedBounds.x; x < trimmedBounds.x + trimmedBounds.width; x += 1) {
      const offset = (y * width + x) * 4
      const alpha = bitmap[offset + 3]

      if (alpha > VISIBLE_ALPHA_THRESHOLD) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    throw new Error('Generated frame does not contain a visible subject.')
  }

  const bboxWidth = maxX - minX + 1
  const bboxHeight = maxY - minY + 1

  return {
    bboxWidthRatio: bboxWidth / width,
    bboxHeightRatio: bboxHeight / height,
    centerXRatio: (minX + maxX + 1) / 2 / width,
    bottomYRatio: (maxY + 1) / height,
    minX,
    minY,
    maxX,
    maxY
  }
}

function ensureConsistentSubjectScale(statsList: FrameContentStats[]): void {
  const reference = statsList[0]

  const exceedsTolerance = (
    current: number,
    target: number,
    tolerance: number,
    useRelative = true
  ): boolean => {
    if (useRelative) {
      return Math.abs(current - target) / Math.max(target, 0.0001) > tolerance
    }

    return Math.abs(current - target) > tolerance
  }

  const inconsistentFrame = statsList.findIndex(
    (stats) =>
      exceedsTolerance(stats.bboxWidthRatio, reference.bboxWidthRatio, MAX_SIZE_DRIFT_RATIO) ||
      exceedsTolerance(stats.bboxHeightRatio, reference.bboxHeightRatio, MAX_SIZE_DRIFT_RATIO) ||
      exceedsTolerance(stats.centerXRatio, reference.centerXRatio, MAX_CENTER_DRIFT_RATIO, false) ||
      exceedsTolerance(stats.bottomYRatio, reference.bottomYRatio, MAX_BOTTOM_DRIFT_RATIO, false)
  )

  if (inconsistentFrame !== -1) {
    throw new Error(
      `Frame ${inconsistentFrame + 1} has inconsistent subject scale or anchor position. The character size, center, or baseline drifted too much across the 9 panels.`
    )
  }
}

function resolveSharedCrop(statsList: FrameContentStats[]): {
  x: number
  y: number
  width: number
  height: number
} {
  const minX = Math.min(...statsList.map((stats) => stats.minX))
  const minY = Math.min(...statsList.map((stats) => stats.minY))
  const maxX = Math.max(...statsList.map((stats) => stats.maxX))
  const maxY = Math.max(...statsList.map((stats) => stats.maxY))

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  }
}

export function registerImageGifHandlers(): void {
  ipcMain.handle(
    IMAGE_CREATE_GIF_FROM_GRID,
    async (
      _event,
      args: {
        filePath?: string
        data?: string
        mediaType?: string
        runId?: string
        frameDurationMs?: number
      }
    ) => {
      try {
        const sourceBuffer = loadSourceBuffer(args)
        const sourceImage = nativeImage.createFromBuffer(sourceBuffer)
        if (sourceImage.isEmpty()) {
          return { success: false, error: 'Failed to decode generated image.' }
        }

        ensureSquareImage(sourceImage)

        const normalizedGrid = normalizeGridImage(sourceImage)
        const outputDir = buildOutputDir(args.runId)
        const gridPng = normalizedGrid.toPNG()
        const grid = toPersistedImageResult(join(outputDir, 'grid.png'), gridPng, 'image/png')

        const rawFrames: Electron.NativeImage[] = []
        const frameStats: FrameContentStats[] = []
        const gridBitmap = normalizedGrid.toBitmap()
        const columnSegments = resolveGridSegments(
          gridBitmap,
          GRID_SIZE,
          GRID_SIZE,
          'column',
          GRID_COLUMNS
        )
        const rowSegments = resolveGridSegments(gridBitmap, GRID_SIZE, GRID_SIZE, 'row', GRID_ROWS)

        for (let row = 0; row < GRID_ROWS; row += 1) {
          for (let col = 0; col < GRID_COLUMNS; col += 1) {
            const columnSegment = columnSegments[col]
            const rowSegment = rowSegments[row]
            const frameImage = normalizedGrid.crop({
              x: columnSegment.start,
              y: rowSegment.start,
              width: columnSegment.size,
              height: rowSegment.size
            })
            rawFrames.push(frameImage)
            frameStats.push(
              analyzeFrameContent(frameImage.toBitmap(), columnSegment.size, rowSegment.size)
            )
          }
        }

        if (rawFrames.length !== FRAME_COUNT) {
          return { success: false, error: 'Failed to slice all 9 frames from the generated grid.' }
        }

        ensureConsistentSubjectScale(frameStats)

        const sharedCrop = resolveSharedCrop(frameStats)
        const frames: PersistedImageResult[] = []
        const gifFrames: Array<{ width: number; height: number; bitmap: Buffer }> = []

        rawFrames.forEach((frameImage, index) => {
          const croppedFrame = frameImage.crop(sharedCrop)
          const frameBuffer = croppedFrame.toPNG()
          frames.push(
            toPersistedImageResult(
              join(outputDir, `frame-${String(index + 1).padStart(2, '0')}.png`),
              frameBuffer,
              'image/png'
            )
          )
          gifFrames.push({
            width: sharedCrop.width,
            height: sharedCrop.height,
            bitmap: croppedFrame.toBitmap()
          })
        })

        const gifBuffer = encodeGif(gifFrames, {
          delayMs: Math.max(20, Number(args.frameDurationMs) || 120),
          loopCount: 0
        })
        const gif = toPersistedImageResult(join(outputDir, 'animation.gif'), gifBuffer, 'image/gif')

        return {
          success: true,
          grid,
          frames,
          gif,
          outputDir,
          gridSize: GRID_SIZE,
          frameSize: FRAME_SIZE
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )
}
