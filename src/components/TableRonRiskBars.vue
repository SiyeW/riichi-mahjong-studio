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

type RonRiskCanvasElement = HTMLCanvasElement & {
  rmsRonRiskRenderSignature?: string
  rmsRonRiskGuideBounds?: CanvasBox | null
}
const rootElement = ref<HTMLElement | null>(null)
const canvasElement = ref<RonRiskCanvasElement | null>(null)
let displayedScales: number[][] = []
let displayedThresholdScale = 1
let animationFrame = 0

interface CanvasBox {
  left: number
  right: number
  top: number
  bottom: number
}

interface RonRiskCanvasGeometry {
  width: number
  height: number
  thresholdLine: (CanvasBox & { lineHeight: number }) | null
  tracks: (CanvasBox & { color: string })[]
}

let renderGeometry: RonRiskCanvasGeometry | null = null

function targetScales(): number[][] {
  return props.slots.map(slot => (
    slot.isGap ? [] : slot.risks.map(risk => probabilityScaleRatio(risk.probability, props.adaptiveMax))
  ))
}

function targetThresholdScale(): number {
  return probabilityScaleRatio(DEFAULT_PROBABILITY_SCALE, props.adaptiveMax)
}

function copyScales(values: number[][]): number[][] {
  return values.map(row => [...row])
}

function measureGeometry() {
  const root = rootElement.value
  const canvas = canvasElement.value
  if (!root || !canvas) {
    renderGeometry = null
    return
  }
  const rootRect = root.getBoundingClientRect()
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(rootRect.width * ratio))
  const height = Math.max(1, Math.round(rootRect.height * ratio))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height

  const rootStyle = getComputedStyle(root)
  const slotElements = root.querySelectorAll<HTMLElement>('.ron-risk-slot')
  const firstSlotRect = slotElements[0]?.getBoundingClientRect()
  const lastSlotRect = slotElements[slotElements.length - 1]?.getBoundingClientRect()
  const thresholdLine = firstSlotRect && lastSlotRect
    ? {
        left: Math.max(0, Math.round((firstSlotRect.left - rootRect.left) * ratio)),
        right: Math.min(width, Math.round((lastSlotRect.right - rootRect.left) * ratio)),
        top: Math.max(0, Math.round((firstSlotRect.top - rootRect.top) * ratio)),
        bottom: Math.min(height, Math.round((firstSlotRect.bottom - rootRect.top) * ratio)),
        lineHeight: Math.max(1, Math.round(firstSlotRect.width * 0.025 * ratio)),
      }
    : null

  const trackElements = root.querySelectorAll<HTMLElement>('.ron-risk-track')
  let trackIndex = 0
  const tracks = props.slots.flatMap((slot) => {
    if (slot.isGap) return
    return slot.risks.flatMap((risk) => {
      const track = trackElements[trackIndex]
      trackIndex += 1
      if (!track) return []
      const trackRect = track.getBoundingClientRect()
      return [{
        left: Math.max(0, Math.round((trackRect.left - rootRect.left) * ratio)),
        right: Math.min(width, Math.round((trackRect.right - rootRect.left) * ratio)),
        top: Math.max(0, Math.round((trackRect.top - rootRect.top) * ratio)),
        bottom: Math.min(height, Math.round((trackRect.bottom - rootRect.top) * ratio)),
        color: rootStyle.getPropertyValue(`--ron-${risk.key}-color`).trim(),
      }]
    })
  }).filter((track): track is CanvasBox & { color: string } => Boolean(track))
  renderGeometry = { width, height, thresholdLine, tracks }
}

function render() {
  const canvas = canvasElement.value
  const geometry = renderGeometry
  if (!canvas || !geometry) return
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, geometry.width, geometry.height)
  if (!props.visible) {
    canvas.rmsRonRiskRenderSignature = ''
    return
  }

  let trackIndex = 0
  props.slots.forEach((slot, slotIndex) => {
    if (slot.isGap) return
    slot.risks.forEach((_risk, sourceIndex) => {
      const track = geometry.tracks[trackIndex]
      trackIndex += 1
      if (!track) return
      const { left, right, top, bottom, color } = track
      const trackHeight = Math.max(0, bottom - top)
      const scale = Math.max(0, Math.min(1, displayedScales[slotIndex]?.[sourceIndex] || 0))
      const fillHeight = Math.max(0, Math.min(trackHeight, Math.round(trackHeight * scale)))
      if (right <= left || fillHeight <= 0) return
      context.fillStyle = color
      context.fillRect(left, top, right - left, fillHeight)
    })
  })
  const showGuide = props.showThreshold || displayedThresholdScale < 1 - 1e-6
  const guide = geometry.thresholdLine
  if (showGuide && guide) {
    const { left, right, top, bottom, lineHeight } = guide
    const y = Math.max(top, Math.min(bottom - lineHeight, Math.round(
      top + (((bottom - top) * displayedThresholdScale) - (lineHeight / 2)),
    )))
    if (right > left && bottom > top) {
      context.fillStyle = 'rgba(198, 214, 211, 0.42)'
      context.fillRect(left, y, right - left, Math.min(lineHeight, bottom - y))
      canvas.rmsRonRiskGuideBounds = { left, right, top: y, bottom: y + lineHeight }
    }
  } else {
    canvas.rmsRonRiskGuideBounds = null
  }
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
  const alreadyAtTarget = displayedThresholdScale === thresholdTarget
    && displayedScales.length === target.length
    && displayedScales.every((row, slotIndex) => (
      row.length === target[slotIndex]?.length
      && row.every((value, sourceIndex) => value === target[slotIndex]?.[sourceIndex])
    ))
  if (alreadyAtTarget) {
    render()
    return
  }
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

function updateGeometry() {
  measureGeometry()
  render()
}

useResponsiveGeometry(rootElement, updateGeometry, {
  resizeAncestorSelector: '.south-container',
  styleAncestorSelector: '.grid-main',
})

watch(() => [props.slots, props.adaptiveMax, props.showThreshold, props.visible, props.reduceMotion], () => {
  void nextTick(() => {
    measureGeometry()
    animate()
  })
}, { immediate: true, flush: 'post' })

onBeforeUnmount(() => stopAnimation())
</script>

<style scoped src="./TableRonRiskBars.css"></style>
