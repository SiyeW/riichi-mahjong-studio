import type { Directive, DirectiveBinding } from 'vue'

type TooltipValue = string | null | undefined | false

type TooltipState = {
  value: TooltipValue
  tooltip: HTMLDivElement | null
  pointerInside: boolean
  focusInside: boolean
  positionFrame: number
  onPointerEnter: () => void
  onPointerLeave: () => void
  onFocusIn: () => void
  onFocusOut: () => void
  onViewportChange: () => void
}

const states = new WeakMap<HTMLElement, TooltipState>()
let tooltipSequence = 0

function tooltipText(value: TooltipValue): string {
  return typeof value === 'string' ? value.trim() : ''
}

function removeTooltip(state: TooltipState) {
  cancelAnimationFrame(state.positionFrame)
  state.positionFrame = 0
  window.removeEventListener('resize', state.onViewportChange)
  window.removeEventListener('scroll', state.onViewportChange, true)
  state.tooltip?.remove()
  state.tooltip = null
}

function positionTooltip(element: HTMLElement, state: TooltipState) {
  const tooltip = state.tooltip
  if (!tooltip) return
  const anchor = element.getBoundingClientRect()
  const width = tooltip.offsetWidth
  const height = tooltip.offsetHeight
  const inset = 8
  const gap = 8
  const left = Math.max(inset, Math.min(
    window.innerWidth - width - inset,
    anchor.left + (anchor.width - width) / 2,
  ))
  const availableAbove = anchor.top - inset
  const availableBelow = window.innerHeight - anchor.bottom - inset
  const placeAbove = availableAbove >= height + gap || availableAbove >= availableBelow
  const top = placeAbove
    ? Math.max(inset, anchor.top - height - gap)
    : Math.min(window.innerHeight - height - inset, anchor.bottom + gap)
  tooltip.style.left = `${left}px`
  tooltip.style.top = `${top}px`
  tooltip.style.visibility = 'visible'
}

function schedulePosition(element: HTMLElement, state: TooltipState) {
  cancelAnimationFrame(state.positionFrame)
  state.positionFrame = requestAnimationFrame(() => {
    state.positionFrame = 0
    positionTooltip(element, state)
  })
}

function showTooltip(element: HTMLElement, state: TooltipState) {
  const text = tooltipText(state.value)
  if (!text) {
    removeTooltip(state)
    return
  }
  if (!state.tooltip) {
    const tooltip = document.createElement('div')
    tooltip.id = `ui-hover-tooltip-${++tooltipSequence}`
    tooltip.className = 'ui-hover-tooltip ui-hover-tooltip-portal'
    tooltip.setAttribute('role', 'tooltip')
    tooltip.style.visibility = 'hidden'
    document.body.appendChild(tooltip)
    state.tooltip = tooltip
    window.addEventListener('resize', state.onViewportChange)
    window.addEventListener('scroll', state.onViewportChange, true)
  }
  state.tooltip.textContent = text
  schedulePosition(element, state)
}

function mountTooltip(element: HTMLElement, binding: DirectiveBinding<TooltipValue>) {
  const state: TooltipState = {
    value: binding.value,
    tooltip: null,
    pointerInside: false,
    focusInside: false,
    positionFrame: 0,
    onPointerEnter: () => {
      state.pointerInside = true
      showTooltip(element, state)
    },
    onPointerLeave: () => {
      state.pointerInside = false
      if (!state.focusInside) removeTooltip(state)
    },
    onFocusIn: () => {
      state.focusInside = true
      showTooltip(element, state)
    },
    onFocusOut: () => {
      state.focusInside = false
      if (!state.pointerInside) removeTooltip(state)
    },
    onViewportChange: () => schedulePosition(element, state),
  }
  element.addEventListener('pointerenter', state.onPointerEnter)
  element.addEventListener('pointerleave', state.onPointerLeave)
  element.addEventListener('focusin', state.onFocusIn)
  element.addEventListener('focusout', state.onFocusOut)
  states.set(element, state)
}

function updateTooltip(element: HTMLElement, binding: DirectiveBinding<TooltipValue>) {
  const state = states.get(element)
  if (!state) return
  state.value = binding.value
  if (!state.pointerInside && !state.focusInside) return
  showTooltip(element, state)
}

function unmountTooltip(element: HTMLElement) {
  const state = states.get(element)
  if (!state) return
  element.removeEventListener('pointerenter', state.onPointerEnter)
  element.removeEventListener('pointerleave', state.onPointerLeave)
  element.removeEventListener('focusin', state.onFocusIn)
  element.removeEventListener('focusout', state.onFocusOut)
  removeTooltip(state)
  states.delete(element)
}

export const uiTooltip: Directive<HTMLElement, TooltipValue> = {
  mounted: mountTooltip,
  updated: updateTooltip,
  unmounted: unmountTooltip,
}
