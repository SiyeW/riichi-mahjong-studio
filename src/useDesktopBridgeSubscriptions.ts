import { onBeforeUnmount, onMounted } from 'vue'

type UiZoomDirection = 'in' | 'out' | 'reset'
type TrainerApi = NonNullable<Window['trainerAPI']>

interface DesktopBridgeHandlers {
  pythonEvent: (event: TrainerPythonEvent) => void
  recordDirtyChanged: (dirty: boolean) => void
  uiZoomShortcut: (direction: UiZoomDirection) => void
  beforeClose: () => void | Promise<void>
}

export function subscribeDesktopBridge(
  api: TrainerApi | undefined,
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
    unsubscribe = subscribeDesktopBridge(window.trainerAPI, handlers)
  })
  onBeforeUnmount(() => {
    unsubscribe?.()
    unsubscribe = null
  })
}
