import { onBeforeUnmount, provide, inject, ref, type InjectionKey, type Ref } from 'vue'

export type AnalysisHoverTooltipRow = {
  label: string
  value: string
  barWidth?: string
  barColor?: string
}

export type AnalysisHoverTooltipContent = {
  title: string
  lines: string[]
  rows: AnalysisHoverTooltipRow[]
}

export type AnalysisHoverTooltipState = AnalysisHoverTooltipContent & {
  left: number
  top: number
  positioned: boolean
}

export type AnalysisHoverTooltipController = {
  show: (event: Event, content: AnalysisHoverTooltipContent) => void
  clear: () => void
}

const analysisHoverTooltipKey: InjectionKey<AnalysisHoverTooltipController> = Symbol('analysis-hover-tooltip')

export function useAnalysisHoverTooltip(rootElement: Ref<HTMLElement | null>) {
  const tooltipElement = ref<HTMLElement | null>(null)
  const tooltip = ref<AnalysisHoverTooltipState | null>(null)
  let positionFrame = 0

  function clear() {
    cancelAnimationFrame(positionFrame)
    positionFrame = 0
    tooltip.value = null
  }

  function show(event: Event, content: AnalysisHoverTooltipContent) {
    const root = rootElement.value
    const anchor = event.currentTarget
    if (!root || !(anchor instanceof Element)) return
    const rootRect = root.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    tooltip.value = {
      ...content,
      left: anchorRect.left + (anchorRect.width / 2) - rootRect.left,
      top: anchorRect.top - rootRect.top,
      positioned: false,
    }
    cancelAnimationFrame(positionFrame)
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0
      const tooltipNode = tooltipElement.value
      const currentRoot = rootElement.value
      if (!tooltipNode || !currentRoot || !tooltip.value) return
      const currentRootRect = currentRoot.getBoundingClientRect()
      const viewportRect = currentRoot.closest<HTMLElement>('.analysis-dock-body')?.getBoundingClientRect()
        || currentRootRect
      const currentAnchorRect = anchor.getBoundingClientRect()
      const horizontalInset = 8
      const verticalInset = 8
      const verticalGap = 8
      const halfWidth = tooltipNode.offsetWidth / 2
      const unclampedLeft = currentAnchorRect.left + (currentAnchorRect.width / 2) - currentRootRect.left
      const visibleLeft = Math.max(currentRootRect.left, viewportRect.left)
      const visibleRight = Math.min(currentRootRect.right, viewportRect.right)
      const visibleTop = Math.max(currentRootRect.top, viewportRect.top)
      const visibleBottom = Math.min(currentRootRect.bottom, viewportRect.bottom)
      const minimumLeft = visibleLeft - currentRootRect.left + halfWidth + horizontalInset
      const maximumLeft = Math.max(
        minimumLeft,
        visibleRight - currentRootRect.left - halfWidth - horizontalInset,
      )
      const availableAbove = currentAnchorRect.top - visibleTop
      const availableBelow = visibleBottom - currentAnchorRect.bottom
      const placement = availableAbove >= tooltipNode.offsetHeight + verticalGap || availableAbove >= availableBelow
        ? 'above'
        : 'below'
      const minimumTop = visibleTop - currentRootRect.top + verticalInset
      const maximumTop = Math.max(
        minimumTop,
        visibleBottom - currentRootRect.top - tooltipNode.offsetHeight - verticalInset,
      )
      const preferredTop = placement === 'above'
        ? currentAnchorRect.top - currentRootRect.top - tooltipNode.offsetHeight - verticalGap
        : currentAnchorRect.bottom - currentRootRect.top + verticalGap
      tooltip.value = {
        ...tooltip.value,
        left: Math.max(minimumLeft, Math.min(maximumLeft, unclampedLeft)),
        top: Math.max(minimumTop, Math.min(maximumTop, preferredTop)),
        positioned: true,
      }
    })
  }

  const controller = { show, clear }
  provide(analysisHoverTooltipKey, controller)
  onBeforeUnmount(() => cancelAnimationFrame(positionFrame))

  return { tooltip, tooltipElement, controller }
}

export function useAnalysisHoverTooltipController(): AnalysisHoverTooltipController {
  const controller = inject(analysisHoverTooltipKey)
  if (!controller) throw new Error('Analysis hover tooltip controller is not available')
  return controller
}
