<template>
  <div
    ref="rootElement"
    class="discard-bars ron-risk-bars"
    :class="{ 'recommendation-toggle': canToggle }"
    :role="canToggle ? 'button' : undefined"
    :tabindex="canToggle ? 0 : undefined"
    :aria-pressed="canToggle ? enabled : undefined"
    :aria-label="canToggle ? toggleLabel : undefined"
    v-ui-tooltip="canToggle ? tooltipLabel : undefined"
    @click.stop="emit('toggle')"
    @keydown.enter.prevent="emit('toggle')"
    @keydown.space.prevent="emit('toggle')"
  >
    <canvas ref="canvasElement" class="table-ron-risk-canvas" aria-hidden="true" />
    <div
      v-for="slot in slots"
      :key="`ron-risk-${slot.index}`"
      class="discard-bar-slot ron-risk-slot"
      :class="{
        'is-drawn': slot.isDrawn,
        'connect-left': slot.connectLeft,
        'connect-right': slot.connectRight,
      }"
    >
      <span v-if="visible && !slot.isGap" class="ron-risk-lanes" aria-hidden="true">
        <span
          v-for="risk in slot.risks"
          :key="risk.key"
          class="ron-risk-track"
          :data-risk-source="risk.key"
        />
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { DEFAULT_PROBABILITY_SCALE, probabilityScaleRatio } from '../analysisProbabilityScale'
import { getUiMotionDurationMs, getUiMotionEasingFunction } from '../uiMotion'
import { useResponsiveGeometry } from '../useResponsiveGeometry'

export type TableRonRiskSlot = Readonly<{
  index: number
  isDrawn: boolean
  isGap: boolean
  connectLeft: boolean
  connectRight: boolean
  risks: readonly Readonly<{
    key: string
    probability: number
  }>[]
}>

const props = defineProps<{
  slots: readonly TableRonRiskSlot[]
  adaptiveMax: number
  showThreshold: boolean
  visible: boolean
  reduceMotion: boolean
  canToggle: boolean
  enabled: boolean
  toggleLabel: string
  tooltipLabel: string
}>()
const emit = defineEmits<{ toggle: [] }>()

type RonRiskCanvasElement = HTMLCanvasElement & { rmsRonRiskRenderSignature?: string }
const rootElement = ref<HTMLElement | null>(null)
const canvasElement = ref<RonRiskCanvasElement | null>(null)
let displayedScales: number[][] = []
let displayedThresholdScale = 0
let animationFrame = 0

function targetScales(): number[][] {
  return props.slots.map(slot => (
    slot.isGap ? [] : slot.risks.map(risk => probabilityScaleRatio(risk.probability, props.adaptiveMax))
  ))
}

function targetThresholdScale(): number {
  return props.showThreshold
    ? probabilityScaleRatio(DEFAULT_PROBABILITY_SCALE, props.adaptiveMax)
    : 0
}

function copyScales(values: number[][]): number[][] {
  return values.map(row => [...row])
}

function render() {
  const root = rootElement.value
  const canvas = canvasElement.value
  if (!root || !canvas) return
  const rootRect = root.getBoundingClientRect()
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(rootRect.width * ratio))
  const height = Math.max(1, Math.round(rootRect.height * ratio))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, width, height)
  if (!props.visible) {
    canvas.rmsRonRiskRenderSignature = ''
    return
  }

  const rootStyle = getComputedStyle(root)
  const slotElements = root.querySelectorAll<HTMLElement>('.ron-risk-slot')
  if (displayedThresholdScale > 0) {
    context.fillStyle = 'rgba(198, 214, 211, 0.42)'
    slotElements.forEach((slotElement, slotIndex) => {
      const slot = props.slots[slotIndex]
      const lanes = slotElement.querySelector<HTMLElement>('.ron-risk-lanes')
      if (!slot || slot.isGap || !lanes) return
      const slotRect = slotElement.getBoundingClientRect()
      const lanesRect = lanes.getBoundingClientRect()
      const leftCss = slot.connectLeft ? slotRect.left : lanesRect.left
      const rightCss = slot.connectRight ? slotRect.right : lanesRect.right
      const left = Math.max(0, Math.round((leftCss - rootRect.left) * ratio))
      const right = Math.min(width, Math.round((rightCss - rootRect.left) * ratio))
      const top = Math.max(0, Math.round((slotRect.top - rootRect.top) * ratio))
      const bottom = Math.min(height, Math.round((slotRect.bottom - rootRect.top) * ratio))
      const y = Math.max(top, Math.min(bottom - 1, Math.round(top + ((bottom - top) * displayedThresholdScale))))
      const lineHeight = Math.max(1, Math.round(slotRect.width * 0.025 * ratio))
      if (right > left && bottom > top) context.fillRect(left, y, right - left, Math.min(lineHeight, bottom - y))
    })
  }

  const trackElements = root.querySelectorAll<HTMLElement>('.ron-risk-track')
  let trackIndex = 0
  props.slots.forEach((slot, slotIndex) => {
    if (slot.isGap) return
    slot.risks.forEach((risk, sourceIndex) => {
      const track = trackElements[trackIndex]
      trackIndex += 1
      if (!track) return
      const trackRect = track.getBoundingClientRect()
      const left = Math.max(0, Math.round((trackRect.left - rootRect.left) * ratio))
      const right = Math.min(width, Math.round((trackRect.right - rootRect.left) * ratio))
      const top = Math.max(0, Math.round((trackRect.top - rootRect.top) * ratio))
      const bottom = Math.min(height, Math.round((trackRect.bottom - rootRect.top) * ratio))
      const trackHeight = Math.max(0, bottom - top)
      const scale = Math.max(0, Math.min(1, displayedScales[slotIndex]?.[sourceIndex] || 0))
      const fillHeight = Math.max(0, Math.min(trackHeight, Math.round(trackHeight * scale)))
      if (right <= left || fillHeight <= 0) return
      context.fillStyle = rootStyle.getPropertyValue(`--ron-${risk.key}-color`).trim()
      context.fillRect(left, top, right - left, fillHeight)
    })
  })
  canvas.rmsRonRiskRenderSignature = [
    Math.round(displayedThresholdScale * 10000),
    ...displayedScales.flat().map(value => Math.round(value * 10000)),
  ].join(',')
}

function stopAnimation() {
  if (animationFrame) cancelAnimationFrame(animationFrame)
  animationFrame = 0
}

function animate() {
  stopAnimation()
  const target = targetScales()
  const thresholdTarget = targetThresholdScale()
  if (!displayedScales.length || props.reduceMotion || !props.visible) {
    displayedScales = copyScales(target)
    displayedThresholdScale = thresholdTarget
    render()
    return
  }
  const source = copyScales(displayedScales)
  const thresholdSource = displayedThresholdScale
  let startedAt: number | null = null
  const duration = getUiMotionDurationMs()
  const easing = getUiMotionEasingFunction()
  const step = (now: number) => {
    if (startedAt === null) startedAt = now
    const progress = Math.max(0, Math.min(1, (now - startedAt) / duration))
    const eased = easing(progress)
    displayedScales = target.map((row, slotIndex) => row.map((value, sourceIndex) => {
      const start = source[slotIndex]?.[sourceIndex] ?? value
      return start + ((value - start) * eased)
    }))
    displayedThresholdScale = thresholdSource + ((thresholdTarget - thresholdSource) * eased)
    render()
    if (progress < 1) animationFrame = requestAnimationFrame(step)
    else animationFrame = 0
  }
  animationFrame = requestAnimationFrame(step)
}

useResponsiveGeometry(rootElement, render, {
  resizeAncestorSelector: '.south-container',
  styleAncestorSelector: '.grid-main',
})

watch(() => [props.slots, props.adaptiveMax, props.showThreshold, props.visible, props.reduceMotion], () => {
  void nextTick(animate)
}, { immediate: true, flush: 'post' })

onBeforeUnmount(() => stopAnimation())
</script>

<style scoped src="./TableRonRiskBars.css"></style>
