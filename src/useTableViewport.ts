import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

export function useTableViewport(options: {
  uiScale: Readonly<Ref<number>>
  afterLayoutChange: () => void
}) {
  const { uiScale, afterLayoutChange } = options
  const tableStageEl = ref<HTMLElement | null>(null)
  const tableZoom = ref(1)
  let tableZoomRaf = 0
  let tableZoomPassesPending = 0

  function scheduleTableZoomRecalc(passes = 12) {
    tableZoomPassesPending = Math.max(tableZoomPassesPending, passes)
    if (tableZoomRaf) return
    tableZoomRaf = window.requestAnimationFrame(() => {
      tableZoomRaf = 0
      recalcTableZoom()
      tableZoomPassesPending = Math.max(0, tableZoomPassesPending - 1)
      if (tableZoomPassesPending > 0) {
        scheduleTableZoomRecalc(tableZoomPassesPending)
      } else {
        tableZoomPassesPending = 0
      }
    })
  }

  function recalcTableZoom() {
    const stage = tableStageEl.value
    if (!stage) return false
    const currentZoom = Math.max(0.1, tableZoom.value)
    const style = window.getComputedStyle(stage)
    const padX = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0')
    const padY = parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0')
    const availW = Math.max(0, stage.clientWidth - padX)
    const availH = Math.max(0, stage.clientHeight - padY)

    let nextZoom = currentZoom

    if (availW > 0 && availH > 0) {
      const zoomByWidth = ((3 * availW) + 16) / 1978
      const zoomByHeight = (availH + 7.04) / 720.5099
      nextZoom = Math.max(0.1, Math.min(zoomByWidth, zoomByHeight))
    }

    if (availW > 0 && availH > 0) {
      const padLeft = parseFloat(style.paddingLeft || '0')
      const padRight = parseFloat(style.paddingRight || '0')
      const padTop = parseFloat(style.paddingTop || '0')
      const padBottom = parseFloat(style.paddingBottom || '0')
      const contentScrollW = Math.max(0, stage.scrollWidth - padLeft - padRight)
      const contentScrollH = Math.max(0, stage.scrollHeight - padTop - padBottom)
      const overflowScale = Math.min(
        contentScrollW > 0 ? availW / contentScrollW : 1,
        contentScrollH > 0 ? availH / contentScrollH : 1,
      )
      if (Number.isFinite(overflowScale) && overflowScale > 0 && overflowScale < 1) {
        nextZoom *= overflowScale
      }
    }

    if (Math.abs(nextZoom - tableZoom.value) > 0.0001) {
      tableZoom.value = nextZoom
      return true
    }
    return false
  }

  const handleWindowResize = () => scheduleTableZoomRecalc()

  watch(uiScale, async () => {
    await nextTick()
    scheduleTableZoomRecalc()
    afterLayoutChange()
  })

  onMounted(() => {
    window.addEventListener('resize', handleWindowResize)
    scheduleTableZoomRecalc()
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', handleWindowResize)
    if (tableZoomRaf) {
      cancelAnimationFrame(tableZoomRaf)
      tableZoomRaf = 0
    }
    tableZoomPassesPending = 0
  })

  return {
    tableStageEl,
    tableZoom,
    scheduleTableZoomRecalc,
  }
}
