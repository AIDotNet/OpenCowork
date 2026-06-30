import { DESKTOP_SCREENSHOT_CAPTURE, captureDesktopScreenshot } from './desktop-control'
import { registerMessagePackHandler } from './messagepack-handler'

export function registerScreenshotHandlers(): void {
  registerMessagePackHandler<undefined>(DESKTOP_SCREENSHOT_CAPTURE, async () => {
    return await captureDesktopScreenshot()
  })
}
