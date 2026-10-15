import { onBeforeUnmount, watch, type Ref } from 'vue'
import { PERCEPTUAL_SURFACE_CHANGE_EVENT } from './perceptualSurface'

type ResponsiveGeometryOptions = Readonly<{
  resizeAncestorSelector?: string
  styleAncestorSelector?: string
}>

export function useResponsiveGeometry(
  target: Ref<HTMLElement | null>,
  update: () => void,
  options: ResponsiveGeometryOptions = {},
): () => void {
  let frame = 0
  let resizeObserver: ResizeObserver | null = null
  let styleObserver: MutationObserver | null = null
  let listening = false
  let disposed = false

  function schedule() {
    if (disposed || !target.value || frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      update()
    })
  }

  function disconnect() {
    cancelAnimationFrame(frame)
    frame = 0
    resizeObserver?.disconnect()
    styleObserver?.disconnect()
    resizeObserver = null
    styleObserver = null
  }

  function setGlobalListeners(enabled: boolean) {
    if (enabled === listening) return
    listening = enabled
    if (enabled) {
      window.addEventListener('resize', schedule)
      document.addEventListener(PERCEPTUAL_SURFACE_CHANGE_EVENT, surfaceChanged, true)
    } else {
      window.removeEventListener('resize', schedule)
      document.removeEventListener(PERCEPTUAL_SURFACE_CHANGE_EVENT, surfaceChanged, true)
    }
  }

  function surfaceChanged(event: Event) {
    const element = target.value
    const owner = event.target
    // Calibrated colors can change after layout has settled. Refresh cached
    // paint colors only for the affected owner/subtree, not unrelated panels.
    if (element && owner instanceof Element && (owner.contains(element) || element.contains(owner))) schedule()
  }

  function connect(element: HTMLElement | null) {
    disconnect()
    setGlobalListeners(Boolean(element))
    if (!element) return

    resizeObserver = new ResizeObserver(schedule)
    resizeObserver.observe(element)
    const resizeAncestor = options.resizeAncestorSelector
      ? element.closest(options.resizeAncestorSelector)
      : null
    if (resizeAncestor) resizeObserver.observe(resizeAncestor)

    const styleAncestor = options.styleAncestorSelector
      ? element.closest(options.styleAncestorSelector)
      : null
    if (styleAncestor) {
      styleObserver = new MutationObserver(schedule)
      styleObserver.observe(styleAncestor, {
        attributes: true,
        attributeFilter: ['style', 'class'],
      })
    }
    schedule()
  }

  watch(target, connect, { flush: 'post', immediate: true })
  onBeforeUnmount(() => {
    disposed = true
    disconnect()
    setGlobalListeners(false)
  })

  return schedule
}
