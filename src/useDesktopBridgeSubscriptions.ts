import { onBeforeUnmount, onMounted } from 'vue'
import type { DesktopBridge } from './contracts/desktopBridge'
import type { PythonEvent } from './contracts/runtime'

type UiZoomDirection = 'in' | 'out' | 'reset'

interface DesktopBridgeHandlers {
  pythonEvent: (event: PythonEvent) => void
  recordDirtyChanged: (dirty: boolean) => void
  uiZoomShortcut: (direction: UiZoomDirection) => void
  beforeClose: () => void | Promise<void>
}

export function subscribeDesktopBridge(
  api: DesktopBridge | undefined,
  handlers: DesktopBridgeHandlers,
): () => void {
  if (!api) return () => {}
  const unsubscribe = [
    api.onPythonEvent?.(handlers.pythonEvent),
    api.onRecordDirtyChanged?.(handlers.recordDirtyChanged),
    api.onUiZoomShortcut?.(handlers.uiZoomShortcut),
    api.onBeforeClose?.(handlers.beforeClose),
  ].filter((callback): callback is () => void => typeof callback === 'function')
  let active = true
  return () => {
    if (!active) return
    active = false
    for (const callback of unsubscribe) callback()
  }
}

export function useDesktopBridgeSubscriptions(handlers: DesktopBridgeHandlers) {
  let unsubscribe: (() => void) | null = null
  onMounted(() => {
    unsubscribe = subscribeDesktopBridge(window.studioAPI, handlers)
  })
  onBeforeUnmount(() => {
    unsubscribe?.()
    unsubscribe = null
  })
}
