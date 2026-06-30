import {
  DESKTOP_INPUT_CLICK,
  DESKTOP_INPUT_SCROLL,
  DESKTOP_INPUT_TYPE,
  desktopInputClick,
  desktopInputScroll,
  desktopInputType,
  type ClickArgs,
  type ScrollArgs,
  type TypeArgs
} from './desktop-control'
import { registerMessagePackHandler } from './messagepack-handler'

export function registerInputHandlers(): void {
  registerMessagePackHandler<ClickArgs>(DESKTOP_INPUT_CLICK, (args) => {
    return desktopInputClick(args)
  })

  registerMessagePackHandler<TypeArgs>(DESKTOP_INPUT_TYPE, (args) => {
    return desktopInputType(args)
  })

  registerMessagePackHandler<ScrollArgs>(DESKTOP_INPUT_SCROLL, (args) => {
    return desktopInputScroll(args)
  })
}
