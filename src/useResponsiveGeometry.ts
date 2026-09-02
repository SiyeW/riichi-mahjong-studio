import { onBeforeUnmount, watch, type Ref } from 'vue'

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
  let listeningForWindowResize = false

  function schedule() {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      update()
    })
  }

  function disconnect() {
    resizeObserver?.disconnect()
    styleObserver?.disconnect()
    resizeObserver = null
    styleObserver = null
  }

  function setWindowResizeListener(enabled: boolean) {
    if (enabled === listeningForWindowResize) return
    listeningForWindowResize = enabled
    if (enabled) window.addEventListener('resize', schedule)
    else window.removeEventListener('resize', schedule)
  }

  function connect(element: HTMLElement | null) {
    disconnect()
    setWindowResizeListener(Boolean(element))
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
    cancelAnimationFrame(frame)
    disconnect()
    setWindowResizeListener(false)
  })

  return schedule
}
