import { ipcMain, desktopCapturer, screen } from 'electron'

const DESKTOP_SCREENSHOT_CAPTURE = 'desktop:screenshot:capture'

export function registerScreenshotHandlers(): void {
  ipcMain.handle(DESKTOP_SCREENSHOT_CAPTURE, async () => {
    try {
      const primaryDisplay = screen.getPrimaryDisplay()
      const allDisplays = screen.getAllDisplays()
      const scaleFactor = primaryDisplay.scaleFactor
      const captureWidth = Math.round(primaryDisplay.bounds.width * scaleFactor)
      const captureHeight = Math.round(primaryDisplay.bounds.height * scaleFactor)

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: captureWidth, height: captureHeight }
      })

      if (sources.length === 0) {
        return { success: false, error: 'No screen sources found.' }
      }

      const primarySource =
        sources.find((s) => s.display_id === String(primaryDisplay.id)) ?? sources[0]

      const pngBuffer = primarySource.thumbnail.toPNG()
      const actualSize = primarySource.thumbnail.getSize()

      return {
        success: true,
        data: pngBuffer.toString('base64'),
        width: actualSize.width,
        height: actualSize.height,
        originX: primaryDisplay.bounds.x,
        originY: primaryDisplay.bounds.y,
        displayCount: allDisplays.length,
        mediaType: 'image/png'
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
}
