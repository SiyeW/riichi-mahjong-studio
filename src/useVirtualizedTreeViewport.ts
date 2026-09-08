import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type Ref,
} from 'vue'

interface PointLayout {
  y: number
}

interface RangeLayout {
  minY: number
  maxY: number
}

interface HitRegionLayout {
  y: number
  height: number
}

export interface VerticalViewportRange {
  top: number
  bottom: number
}

export function bufferedVerticalRange(
  viewportTop: number,
  viewportHeight: number,
  buffer: number,
): VerticalViewportRange {
  return {
    top: Math.max(0, viewportTop - buffer),
    bottom: viewportTop + Math.max(0, viewportHeight) + buffer,
  }
}

export function pointIsVisible(
  point: PointLayout,
  range: VerticalViewportRange,
): boolean {
  return point.y >= range.top && point.y <= range.bottom
}

export function rangeIsVisible(
  item: RangeLayout,
  range: VerticalViewportRange,
): boolean {
  return item.maxY >= range.top && item.minY <= range.bottom
}

export function hitRegionIsVisible(
  region: HitRegionLayout,
  range: VerticalViewportRange,
): boolean {
  return region.y + region.height >= range.top && region.y <= range.bottom
}

export function useVirtualizedTreeViewport<
  TDot extends PointLayout,
  TEdge extends RangeLayout,
  THitRegion extends HitRegionLayout,
  TRow extends PointLayout,
>(options: {
  dots: Readonly<Ref<TDot[]>>
  edges: Readonly<Ref<TEdge[]>>
  hitRegions: Readonly<Ref<THitRegion[]>>
  rows: Readonly<Ref<TRow[]>>
  contentHeight: Readonly<Ref<number>>
  currentNodeId: () => string | null
  currentDot: () => TDot | null
  clearHover: () => void
  renderBuffer?: number
}) {
  const treeScrollEl = ref<HTMLElement | null>(null)
  const viewport = reactive({
    top: 0,
    height: 0,
  })
  const renderBuffer = options.renderBuffer ?? 160
  let viewportRaf = 0
  let autoFollowSuspended = false

  function updateTreeViewport() {
    const element = treeScrollEl.value
    if (!element) {
      viewport.top = 0
      viewport.height = 0
      return
    }
    viewport.top = element.scrollTop
    viewport.height = element.clientHeight
  }

  function onTreeScroll() {
    options.clearHover()
    if (viewportRaf) return
    viewportRaf = window.requestAnimationFrame(() => {
      viewportRaf = 0
      updateTreeViewport()
    })
  }

  function keepCurrentTreeDotVisible() {
    const container = treeScrollEl.value
    const currentDot = options.currentDot()
    if (!container || !currentDot) return
    const padding = 18
    const viewTop = container.scrollTop
    const viewBottom = viewTop + container.clientHeight
    const dotTop = currentDot.y - padding
    const dotBottom = currentDot.y + padding
    if (dotTop < viewTop) {
      container.scrollTop = Math.max(0, dotTop)
    } else if (dotBottom > viewBottom) {
      container.scrollTop = Math.max(0, dotBottom - container.clientHeight)
    }
  }

  function suspendTreeAutoFollow() {
    autoFollowSuspended = true
  }

  async function resumeTreeAutoFollow() {
    autoFollowSuspended = false
    await nextTick()
    if (autoFollowSuspended) return
    updateTreeViewport()
    keepCurrentTreeDotVisible()
  }

  const visibleRange = computed(() => bufferedVerticalRange(
    viewport.top,
    viewport.height,
    renderBuffer,
  ))
  const visibleTreeDots = computed(() => options.dots.value.filter(
    (dot) => pointIsVisible(dot, visibleRange.value),
  ))
  const visibleTreeHitRegions = computed(() => options.hitRegions.value.filter(
    (region) => hitRegionIsVisible(region, visibleRange.value),
  ))
  const visibleTreeEdges = computed(() => options.edges.value.filter(
    (edge) => rangeIsVisible(edge, visibleRange.value),
  ))
  const visibleTreeRows = computed(() => options.rows.value.filter(
    (row) => pointIsVisible(row, visibleRange.value),
  ))

  watch(
    options.currentNodeId,
    async () => {
      await nextTick()
      updateTreeViewport()
      if (!autoFollowSuspended) keepCurrentTreeDotVisible()
    },
  )

  watch(
    () => [options.contentHeight.value, options.dots.value.length],
    async () => {
      await nextTick()
      updateTreeViewport()
    },
  )

  onMounted(() => {
    window.addEventListener('resize', updateTreeViewport)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', updateTreeViewport)
    if (viewportRaf) {
      window.cancelAnimationFrame(viewportRaf)
      viewportRaf = 0
    }
  })

  return {
    onTreeScroll,
    resumeTreeAutoFollow,
    suspendTreeAutoFollow,
    treeScrollEl,
    updateTreeViewport,
    visibleTreeDots,
    visibleTreeEdges,
    visibleTreeHitRegions,
    visibleTreeRows,
  }
}
