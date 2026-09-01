import type { ObjectDirective } from 'vue'

export type AdaptiveButtonGridOptions = {
  columns: number[]
  spanLastWhenIncomplete?: boolean
}

type AdaptiveButtonGridState = {
  options: AdaptiveButtonGridOptions
  resizeObserver: ResizeObserver
  mutationObserver: MutationObserver
  frame: number
}

const adaptiveButtonGridStates = new WeakMap<HTMLElement, AdaptiveButtonGridState>()

function finiteWidth(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function buttonIntrinsicWidth(button: HTMLButtonElement): number {
  const style = getComputedStyle(button)
  const range = document.createRange()
  range.selectNodeContents(button)
  const textWidth = range.getBoundingClientRect().width
  range.detach()
  return textWidth
    + finiteWidth(style.paddingLeft)
    + finiteWidth(style.paddingRight)
    + finiteWidth(style.borderLeftWidth)
    + finiteWidth(style.borderRightWidth)
    + 1
}

export function requiredAdaptiveGridWidth(
  itemWidths: number[],
  columns: number,
  gap: number,
  spanLastWhenIncomplete = false,
): number {
  if (!itemWidths.length || columns <= 0) return 0
  const safeColumns = Math.min(columns, itemWidths.length)
  const spansLast = spanLastWhenIncomplete && itemWidths.length % safeColumns !== 0
  const regularWidths = spansLast ? itemWidths.slice(0, -1) : itemWidths
  const columnWidths = Array.from({ length: safeColumns }, () => 0)
  regularWidths.forEach((width, index) => {
    const column = index % safeColumns
    columnWidths[column] = Math.max(columnWidths[column], width)
  })
  const regularRowWidth = columnWidths.reduce((sum, width) => sum + width, 0)
    + Math.max(0, safeColumns - 1) * gap
  return spansLast ? Math.max(regularRowWidth, itemWidths.at(-1) || 0) : regularRowWidth
}

export function adaptiveGridColumns(
  availableWidth: number,
  itemWidths: number[],
  gap: number,
  options: AdaptiveButtonGridOptions,
): number {
  const candidates = [...new Set(options.columns)]
    .filter(columns => Number.isInteger(columns) && columns > 0)
    .sort((left, right) => right - left)
  for (const columns of candidates) {
    const required = requiredAdaptiveGridWidth(
      itemWidths,
      columns,
      gap,
      options.spanLastWhenIncomplete,
    )
    if (required <= availableWidth + 0.25) return Math.min(columns, Math.max(1, itemWidths.length))
  }
  return 1
}

function updateAdaptiveButtonGrid(element: HTMLElement, options: AdaptiveButtonGridOptions) {
  const buttons = [...element.children].filter((child): child is HTMLButtonElement => (
    child instanceof HTMLButtonElement
  ))
  if (!buttons.length || element.clientWidth <= 0) return
  const gap = finiteWidth(getComputedStyle(element).columnGap)
  const columns = adaptiveGridColumns(
    element.clientWidth,
    buttons.map(buttonIntrinsicWidth),
    gap,
    options,
  )
  element.style.setProperty('--adaptive-button-columns', String(columns))
  element.dataset.adaptiveColumns = String(columns)
}

function scheduleAdaptiveButtonGrid(element: HTMLElement) {
  const state = adaptiveButtonGridStates.get(element)
  if (!state || state.frame) return
  state.frame = requestAnimationFrame(() => {
    state.frame = 0
    updateAdaptiveButtonGrid(element, state.options)
  })
}

export const vAdaptiveButtonGrid: ObjectDirective<HTMLElement, AdaptiveButtonGridOptions> = {
  mounted(element, binding) {
    const state: AdaptiveButtonGridState = {
      options: binding.value,
      resizeObserver: new ResizeObserver(() => scheduleAdaptiveButtonGrid(element)),
      mutationObserver: new MutationObserver(() => scheduleAdaptiveButtonGrid(element)),
      frame: 0,
    }
    adaptiveButtonGridStates.set(element, state)
    state.resizeObserver.observe(element)
    state.mutationObserver.observe(element, { childList: true, characterData: true, subtree: true })
    document.fonts?.ready.then(() => scheduleAdaptiveButtonGrid(element))
    scheduleAdaptiveButtonGrid(element)
  },
  updated(element, binding) {
    const state = adaptiveButtonGridStates.get(element)
    if (!state) return
    state.options = binding.value
    scheduleAdaptiveButtonGrid(element)
  },
  unmounted(element) {
    const state = adaptiveButtonGridStates.get(element)
    if (!state) return
    state.resizeObserver.disconnect()
    state.mutationObserver.disconnect()
    if (state.frame) cancelAnimationFrame(state.frame)
    adaptiveButtonGridStates.delete(element)
  },
}
