<template>
  <div
    ref="rootElement"
    class="discard-bars table-recommendation-bars"
    :class="{
      'recommendation-toggle': canToggle,
      'recommendation-hidden': !visible,
    }"
    :role="canToggle ? 'button' : undefined"
    :tabindex="canToggle ? 0 : undefined"
    :aria-pressed="canToggle ? enabled : undefined"
    :aria-label="canToggle ? toggleLabel : undefined"
    v-ui-tooltip="canToggle ? tooltipLabel : undefined"
    @click.stop="emit('toggle')"
    @keydown.enter.prevent="emit('toggle')"
    @keydown.space.prevent="emit('toggle')"
  >
    <canvas ref="canvasElement" class="table-recommendation-canvas" aria-hidden="true" />
    <div
      v-for="(slot, index) in slots"
      :key="`recommendation-slot-${index}`"
      class="discard-bar-slot recommendation-geometry-slot"
      :class="{ 'is-drawn': slot.isDrawn }"
    >
      <span v-if="!slot.isGap" class="recommendation-geometry-lane" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { getUiMotionDurationMs, getUiMotionEasingFunction } from '../uiMotion'
import { useResponsiveGeometry } from '../useResponsiveGeometry'

export interface TableRecommendationSlot {
  value: number
  isBest: boolean
  isDrawn: boolean
  isGap: boolean
}

const props = defineProps<{
  slots: readonly TableRecommendationSlot[]
  visible: boolean
  reduceMotion: boolean
  canToggle: boolean
  enabled: boolean
  toggleLabel: string
  tooltipLabel: string
}>()
const emit = defineEmits<{ toggle: [] }>()

interface LaneGeometry {
  left: number
  right: number
  top: number
  bottom: number
  markerX: number
}

interface CanvasGeometry {
  width: number
  height: number
  lanes: (LaneGeometry | null)[]
  emptyColor: string
  fillColor: string
  markerRadius: number
}

const rootElement = ref<HTMLElement | null>(null)
type RecommendationCanvasElement = HTMLCanvasElement & { rmsRecommendationRenderSignature?: string }
const canvasElement = ref<RecommendationCanvasElement | null>(null)
let geometry: CanvasGeometry | null = null
let displayedValues: number[] = []
let animationFrame = 0

function targetValues(): number[] {
  return props.slots.map(slot => Math.max(0, Math.min(1, Number(slot.value) || 0)))
}

function measureGeometry() {
  const root = rootElement.value
  const canvas = canvasElement.value
  if (!root || !canvas) {
    geometry = null
    return
  }
  const rootRect = root.getBoundingClientRect()
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(rootRect.width * ratio))
  const height = Math.max(1, Math.round(rootRect.height * ratio))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const rootStyle = getComputedStyle(root)
  const lanes = [...root.querySelectorAll<HTMLElement>('.recommendation-geometry-slot')]
    .map((slotElement) => {
      const lane = slotElement.querySelector<HTMLElement>('.recommendation-geometry-lane')
      if (!lane) return null
      const laneRect = lane.getBoundingClientRect()
      return {
        left: Math.round((laneRect.left - rootRect.left) * ratio),
        right: Math.round((laneRect.right - rootRect.left) * ratio),
        top: Math.round((laneRect.top - rootRect.top) * ratio),
        bottom: Math.round((laneRect.bottom - rootRect.top) * ratio),
        markerX: Math.round((((laneRect.left + laneRect.right) / 2) - rootRect.left) * ratio),
      }
    })
  const markerSize = Number.parseFloat(rootStyle.getPropertyValue('--choice-best-marker-size')) || 5
  geometry = {
    width,
    height,
    lanes,
    emptyColor: rootStyle.getPropertyValue('--bar-empty-bg').trim(),
    fillColor: rootStyle.getPropertyValue('--decision-recommendation-color').trim(),
    markerRadius: Math.max(1, (markerSize * ratio) / 2),
  }
}

function render() {
  const canvas = canvasElement.value
  if (!canvas || !geometry) return
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, geometry.width, geometry.height)
  if (!props.visible) return
  geometry.lanes.forEach((lane, index) => {
    if (!lane) return
    const laneWidth = Math.max(0, lane.right - lane.left)
    const laneHeight = Math.max(0, lane.bottom - lane.top)
    context.fillStyle = geometry!.emptyColor
    context.fillRect(lane.left, lane.top, laneWidth, laneHeight)
    const fillHeight = Math.round(laneHeight * (displayedValues[index] || 0))
    if (fillHeight > 0) {
      context.fillStyle = geometry!.fillColor
      context.fillRect(lane.left, lane.bottom - fillHeight, laneWidth, fillHeight)
    }
    if (props.slots[index]?.isBest) {
      context.beginPath()
      context.arc(lane.markerX, Math.max(geometry!.markerRadius, lane.top - (geometry!.markerRadius * 2)), geometry!.markerRadius, 0, Math.PI * 2)
      context.fillStyle = geometry!.fillColor
      context.fill()
    }
  })
  canvas.rmsRecommendationRenderSignature = displayedValues
    .map(value => Math.round(value * 10000))
    .join(',')
}

function stopAnimation() {
  if (animationFrame) cancelAnimationFrame(animationFrame)
  animationFrame = 0
}

function animate() {
  stopAnimation()
  const target = targetValues()
  const alreadyAtTarget = displayedValues.length === target.length
    && displayedValues.every((value, index) => value === target[index])
  if (alreadyAtTarget) {
    render()
    return
  }
  if (!displayedValues.length || props.reduceMotion || !props.visible) {
    displayedValues = target
    render()
    return
  }
  const source = [...displayedValues]
  const duration = getUiMotionDurationMs()
  const easing = getUiMotionEasingFunction()
  let startedAt: number | null = null
  const step = (now: number) => {
    if (startedAt === null) startedAt = now
    const progress = Math.max(0, Math.min(1, (now - startedAt) / duration))
    const eased = easing(progress)
    displayedValues = target.map((value, index) => {
      const start = source[index] ?? value
      return start + ((value - start) * eased)
    })
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

watch(() => [props.slots, props.visible, props.reduceMotion], () => {
  void nextTick(() => {
    measureGeometry()
    animate()
  })
}, { immediate: true, flush: 'post' })

onBeforeUnmount(stopAnimation)
</script>

<style scoped>
.table-recommendation-bars {
  position: relative;
  contain: layout paint;
}

.table-recommendation-canvas {
  position: absolute;
  z-index: 1;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.recommendation-geometry-slot {
  position: relative;
  z-index: 0;
}

.recommendation-geometry-lane {
  display: block;
  width: var(--decision-bar-width);
  height: var(--discard-bar-lane-height);
  visibility: hidden;
}
</style>
