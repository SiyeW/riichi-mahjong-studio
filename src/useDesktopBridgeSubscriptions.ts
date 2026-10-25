import { onBeforeUnmount, onMounted } from 'vue'
import type { CloseState, DesktopBridge } from './contracts/desktopBridge'
import type { PythonEvent } from './contracts/runtime'
import { rendererRecovery } from './rendererRecoveryState.ts'

type UiZoomDirection = 'in' | 'out' | 'reset'

interface DesktopBridgeHandlers {
  pythonEvent: (event: PythonEvent) => void
  recordDirtyChanged: (dirty: boolean) => void
  uiZoomShortcut: (direction: UiZoomDirection) => void
  beforeClose: () => void | Promise<void>
  closeState: (state: CloseState) => void
}

export function subscribeDesktopBridge(
  api: DesktopBridge | undefined,
  handlers: DesktopBridgeHandlers,
): () => void {
  if (!api) return () => {}
  // Keep the pending-edit recovery callback after a failed root unmount, but
  // release all IPC subscriptions normally. The next root replaces this owner.
  rendererRecovery.setFlush(handlers.beforeClose)
  const unsubscribe = [
    api.onPythonEvent?.(handlers.pythonEvent),
    api.onRecordDirtyChanged?.(handlers.recordDirtyChanged),
    api.onUiZoomShortcut?.(handlers.uiZoomShortcut),
    api.onBeforeClose?.(handlers.beforeClose),
    api.onCloseState?.(handlers.closeState),
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
