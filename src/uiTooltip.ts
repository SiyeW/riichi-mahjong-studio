import type { Directive, DirectiveBinding } from 'vue'
import { rgbString } from './perceptualColor.ts'
import { effectiveBackgroundColor } from './perceptualSurface.ts'

type TooltipValue = string | null | undefined | false | Readonly<{
  text: string
  revealTarget: string
}>

type TooltipState = {
  value: TooltipValue
  tooltip: HTMLDivElement | null
  pointerInside: boolean
  keyboardFocusInside: boolean
  positionFrame: number
  onPointerEnter: () => void
  onPointerLeave: () => void
  onPointerDown: () => void
  onFocusIn: () => void
  onFocusOut: () => void
  onViewportChange: () => void
}

const states = new WeakMap<HTMLElement, TooltipState>()
let tooltipSequence = 0

function tooltipText(value: TooltipValue): string {
  return (typeof value === 'string' ? value : value && value.text ? value.text : '').trim()
}

function revealTarget(element: HTMLElement, value: TooltipValue): HTMLElement | null {
  if (!value || typeof value !== 'object') return null
  const target = element.querySelector(value.revealTarget)
  return target instanceof HTMLElement ? target : null
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
  const target = revealTarget(element, state.value)
  if (target) {
    const anchor = target.getBoundingClientRect()
    const style = getComputedStyle(target)
    const fontSize = Number.parseFloat(style.fontSize) || 0
    const extraTop = Math.max(0, Math.min(fontSize * 0.12, anchor.top - 8))
    const extraBottom = fontSize * 0.12
    const extraLeft = Math.max(0, Math.min(fontSize * 0.18, anchor.left - 8))
    const extraRight = fontSize * 0.18
    tooltip.classList.add('is-inline-reveal')
    tooltip.style.left = `${anchor.left - extraLeft}px`
    tooltip.style.top = `${anchor.top - extraTop}px`
    tooltip.style.minWidth = `${anchor.width + extraLeft + extraRight}px`
    tooltip.style.maxWidth = `${Math.max(anchor.width + extraLeft + extraRight, window.innerWidth - anchor.left + extraLeft - 8)}px`
    tooltip.style.font = style.font
    tooltip.style.lineHeight = style.lineHeight
    tooltip.style.letterSpacing = style.letterSpacing
    tooltip.style.padding = style.padding
    tooltip.style.paddingTop = `${(Number.parseFloat(style.paddingTop) || 0) + extraTop}px`
    tooltip.style.paddingBottom = `${(Number.parseFloat(style.paddingBottom) || 0) + extraBottom}px`
    tooltip.style.paddingRight = `${(Number.parseFloat(style.paddingRight) || 0) + extraRight}px`
    tooltip.style.paddingLeft = `${(Number.parseFloat(style.paddingLeft) || 0) + extraLeft}px`
    tooltip.style.color = style.color
    tooltip.style.backgroundColor = rgbString(effectiveBackgroundColor(element))
    tooltip.style.visibility = 'visible'
    return
  }
  tooltip.classList.remove('is-inline-reveal')
  tooltip.style.minWidth = ''
  tooltip.style.maxWidth = ''
  tooltip.style.maxHeight = ''
  tooltip.style.font = ''
  tooltip.style.lineHeight = ''
  tooltip.style.letterSpacing = ''
  tooltip.style.padding = ''
  tooltip.style.paddingTop = ''
  tooltip.style.paddingBottom = ''
  tooltip.style.paddingRight = ''
  tooltip.style.paddingLeft = ''
  tooltip.style.color = ''
  tooltip.style.backgroundColor = ''
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
  const target = revealTarget(element, state.value)
  if (!text || (typeof state.value === 'object' && state.value && !target)
    || (target && target.scrollWidth <= target.clientWidth)) {
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
    keyboardFocusInside: false,
    positionFrame: 0,
    onPointerEnter: () => {
      state.pointerInside = true
      showTooltip(element, state)
    },
    onPointerLeave: () => {
      state.pointerInside = false
      if (!state.keyboardFocusInside) removeTooltip(state)
    },
    onPointerDown: () => {
      // Clicking a control may keep DOM focus, but must not pin its hover hint.
      state.keyboardFocusInside = false
      if (!state.pointerInside) removeTooltip(state)
    },
    onFocusIn: () => {
      state.keyboardFocusInside = element.matches(':focus-visible')
      if (state.pointerInside || state.keyboardFocusInside) showTooltip(element, state)
    },
    onFocusOut: () => {
      state.keyboardFocusInside = false
      if (!state.pointerInside) removeTooltip(state)
    },
    onViewportChange: () => showTooltip(element, state),
  }
  element.addEventListener('pointerenter', state.onPointerEnter)
  element.addEventListener('pointerleave', state.onPointerLeave)
  element.addEventListener('pointerdown', state.onPointerDown)
  element.addEventListener('focusin', state.onFocusIn)
  element.addEventListener('focusout', state.onFocusOut)
  states.set(element, state)
}

function updateTooltip(element: HTMLElement, binding: DirectiveBinding<TooltipValue>) {
  const state = states.get(element)
  if (!state) return
  state.value = binding.value
  if (!state.pointerInside && !state.keyboardFocusInside) return
  showTooltip(element, state)
}

function unmountTooltip(element: HTMLElement) {
  const state = states.get(element)
  if (!state) return
  element.removeEventListener('pointerenter', state.onPointerEnter)
  element.removeEventListener('pointerleave', state.onPointerLeave)
  element.removeEventListener('pointerdown', state.onPointerDown)
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
