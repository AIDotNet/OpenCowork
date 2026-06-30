import { ipcMain, nativeImage } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { encodeGif } from '../image/gif-encoder'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
const IMAGE_CREATE_GIF_FROM_GRID = 'image:create-gif-from-grid'

const GENERATED_IMAGES_DIR = 'open-cowork'
const GENERATED_IMAGES_SUBDIR = 'image'
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
const OPAQUE_BACKGROUND_BBOX_RATIO = 0.96
const BACKGROUND_SAMPLE_BORDER = 8
const BACKGROUND_COLOR_TOLERANCE = 30
const BACKGROUND_SWATCH_LIMIT = 6

interface PersistedImageResult {
  filePath: string
  mediaType: string
  data: string
}

interface FrameContentStats {
  bboxWidthRatio: number
  bboxHeightRatio: number
  anchorX: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface AlignedFrameLayout {
  width: number
  height: number
  anchorX: number
}

interface ColorSwatch {
  red: number
  green: number
  blue: number
}

function getGeneratedImagesDir(): string {
  const dir = join(homedir(), GENERATED_IMAGES_DIR, GENERATED_IMAGES_SUBDIR)
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

function collectBackgroundSwatches(bitmap: Buffer, width: number, height: number): ColorSwatch[] {
  const border = Math.max(
    1,
    Math.min(BACKGROUND_SAMPLE_BORDER, Math.floor(Math.min(width, height) / 8))
  )
  const buckets = new Map<
    string,
    { count: number; redTotal: number; greenTotal: number; blueTotal: number }
  >()

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= border && x < width - border && y >= border && y < height - border) {
        continue
      }

      const offset = (y * width + x) * 4
      const alpha = bitmap[offset + 3]
      if (alpha <= EMPTY_EDGE_ALPHA_THRESHOLD) {
        continue
      }

      const blue = bitmap[offset]
      const green = bitmap[offset + 1]
      const red = bitmap[offset + 2]
      const key = `${Math.round(red / 16)}-${Math.round(green / 16)}-${Math.round(blue / 16)}`
      const current = buckets.get(key) ?? { count: 0, redTotal: 0, greenTotal: 0, blueTotal: 0 }

      current.count += 1
      current.redTotal += red
      current.greenTotal += green
      current.blueTotal += blue
      buckets.set(key, current)
    }
  }

  return Array.from(buckets.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, BACKGROUND_SWATCH_LIMIT)
    .map((bucket) => ({
      red: Math.round(bucket.redTotal / bucket.count),
      green: Math.round(bucket.greenTotal / bucket.count),
      blue: Math.round(bucket.blueTotal / bucket.count)
    }))
}

function isBackgroundLikePixel(bitmap: Buffer, offset: number, swatches: ColorSwatch[]): boolean {
  const alpha = bitmap[offset + 3]
  if (alpha <= EMPTY_EDGE_ALPHA_THRESHOLD) {
    return true
  }

  if (swatches.length === 0) {
    return false
  }

  const blue = bitmap[offset]
  const green = bitmap[offset + 1]
  const red = bitmap[offset + 2]
  const toleranceSquared = BACKGROUND_COLOR_TOLERANCE * BACKGROUND_COLOR_TOLERANCE

  return swatches.some((swatch) => {
    const redDelta = red - swatch.red
    const greenDelta = green - swatch.green
    const blueDelta = blue - swatch.blue
    return redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta <= toleranceSquared
  })
}

function resolveForegroundBoundsByBackground(
  bitmap: Buffer,
  width: number,
  height: number,
  bounds: { x: number; y: number; width: number; height: number }
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const swatches = collectBackgroundSwatches(bitmap, width, height)
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const offset = (y * width + x) * 4
      if (isBackgroundLikePixel(bitmap, offset, swatches)) {
        continue
      }

      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  if (maxX < minX || maxY < minY) {
    return null
  }

  return { minX, minY, maxX, maxY }
}

function resolveFrameAnchorX(
  bitmap: Buffer,
  width: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): number {
  const bboxHeight = maxY - minY + 1
  const lowerBodyStartY = Math.min(maxY, minY + Math.floor(bboxHeight * 0.55))
  let lowerMinX = width
  let lowerMaxX = -1

  for (let y = lowerBodyStartY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const offset = (y * width + x) * 4
      if (bitmap[offset + 3] > VISIBLE_ALPHA_THRESHOLD) {
        if (x < lowerMinX) lowerMinX = x
        if (x > lowerMaxX) lowerMaxX = x
      }
    }
  }

  if (lowerMaxX >= lowerMinX) {
    return Math.round((lowerMinX + lowerMaxX) / 2)
  }

  return Math.round((minX + maxX) / 2)
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

  const alphaBoundsValid = maxX >= minX && maxY >= minY
  const alphaBBoxWidth = alphaBoundsValid ? maxX - minX + 1 : 0
  const alphaBBoxHeight = alphaBoundsValid ? maxY - minY + 1 : 0
  const shouldUseBackgroundFallback =
    !alphaBoundsValid ||
    (alphaBBoxWidth / width >= OPAQUE_BACKGROUND_BBOX_RATIO &&
      alphaBBoxHeight / height >= OPAQUE_BACKGROUND_BBOX_RATIO)

  if (shouldUseBackgroundFallback) {
    const fallbackBounds = resolveForegroundBoundsByBackground(bitmap, width, height, trimmedBounds)
    if (fallbackBounds) {
      minX = fallbackBounds.minX
      minY = fallbackBounds.minY
      maxX = fallbackBounds.maxX
      maxY = fallbackBounds.maxY
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
    anchorX: resolveFrameAnchorX(bitmap, width, minX, minY, maxX, maxY),
    minX,
    minY,
    maxX,
    maxY
  }
}

function ensureConsistentSubjectScale(statsList: FrameContentStats[]): void {
  const reference = statsList[0]

  const exceedsTolerance = (current: number, target: number, tolerance: number): boolean =>
    Math.abs(current - target) / Math.max(target, 0.0001) > tolerance

  const inconsistentFrame = statsList.findIndex(
    (stats) =>
      exceedsTolerance(stats.bboxWidthRatio, reference.bboxWidthRatio, MAX_SIZE_DRIFT_RATIO) ||
      exceedsTolerance(stats.bboxHeightRatio, reference.bboxHeightRatio, MAX_SIZE_DRIFT_RATIO)
  )

  if (inconsistentFrame !== -1) {
    throw new Error(
      `Frame ${inconsistentFrame + 1} has inconsistent subject scale. The character size drifted too much across the 9 panels.`
    )
  }
}

function resolveAlignedFrameLayout(statsList: FrameContentStats[]): AlignedFrameLayout {
  let maxLeftSpan = 0
  let maxRightSpan = 0
  let maxHeight = 0

  for (const stats of statsList) {
    maxLeftSpan = Math.max(maxLeftSpan, stats.anchorX - stats.minX)
    maxRightSpan = Math.max(maxRightSpan, stats.maxX - stats.anchorX)
    maxHeight = Math.max(maxHeight, stats.maxY - stats.minY + 1)
  }

  return {
    width: maxLeftSpan + maxRightSpan + 1,
    height: maxHeight,
    anchorX: maxLeftSpan
  }
}

function composeAlignedFrameBitmap(
  sourceBitmap: Buffer,
  sourceWidth: number,
  stats: FrameContentStats,
  layout: AlignedFrameLayout
): Buffer {
  const bboxWidth = stats.maxX - stats.minX + 1
  const bboxHeight = stats.maxY - stats.minY + 1
  const destX = layout.anchorX - (stats.anchorX - stats.minX)
  const destY = layout.height - bboxHeight
  const output = Buffer.alloc(layout.width * layout.height * 4)

  for (let row = 0; row < bboxHeight; row += 1) {
    const sourceStart = ((stats.minY + row) * sourceWidth + stats.minX) * 4
    const sourceEnd = sourceStart + bboxWidth * 4
    const targetStart = ((destY + row) * layout.width + destX) * 4
    sourceBitmap.copy(output, targetStart, sourceStart, sourceEnd)
  }

  return output
}

type CreateGifFromGridArgs = {
  filePath?: string
  data?: string
  mediaType?: string
  runId?: string
  frameDurationMs?: number
}

async function handleCreateGifFromGrid(args: CreateGifFromGridArgs): Promise<unknown> {
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

    const rawFrames: Array<{ width: number; height: number; bitmap: Buffer }> = []
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
        const frameBitmap = frameImage.toBitmap()
        rawFrames.push({
          width: columnSegment.size,
          height: rowSegment.size,
          bitmap: frameBitmap
        })
        frameStats.push(analyzeFrameContent(frameBitmap, columnSegment.size, rowSegment.size))
      }
    }

    if (rawFrames.length !== FRAME_COUNT) {
      return { success: false, error: 'Failed to slice all 9 frames from the generated grid.' }
    }

    ensureConsistentSubjectScale(frameStats)

    const alignedLayout = resolveAlignedFrameLayout(frameStats)
    const frames: PersistedImageResult[] = []
    const gifFrames: Array<{ width: number; height: number; bitmap: Buffer }> = []

    rawFrames.forEach((frame, index) => {
      const alignedBitmap = composeAlignedFrameBitmap(
        frame.bitmap,
        frame.width,
        frameStats[index],
        alignedLayout
      )
      const alignedImage = nativeImage.createFromBitmap(alignedBitmap, {
        width: alignedLayout.width,
        height: alignedLayout.height,
        scaleFactor: 1
      })
      const frameBuffer = alignedImage.toPNG()
      frames.push(
        toPersistedImageResult(
          join(outputDir, `frame-${String(index + 1).padStart(2, '0')}.png`),
          frameBuffer,
          'image/png'
        )
      )
      gifFrames.push({
        width: alignedLayout.width,
        height: alignedLayout.height,
        bitmap: alignedBitmap
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

export function registerImageGifHandlers(): void {
  ipcMain.handle(
    toMessagePackChannel(IMAGE_CREATE_GIF_FROM_GRID),
    async (_event, bytes: Uint8Array) => {
      const args = decodeMessagePackPayload<CreateGifFromGridArgs>(bytes)
      return encodeMessagePackPayload(await handleCreateGifFromGrid(args))
    }
  )
}
