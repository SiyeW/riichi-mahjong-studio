<template>
  <div
    ref="rootElement"
    v-perceptual-surface="trackSurface"
    class="analysis-distribution-chart"
    :class="{
      'has-labels': showLabels,
      'has-reference-line': referenceLineStyle !== null,
    }"
    :style="referenceLineStyle || undefined"
  >
    <canvas ref="canvasElement" class="analysis-distribution-canvas" aria-hidden="true" />
    <template v-if="showLabels">
      <span
        v-for="(entry, index) in entries"
        :key="entry.key"
        class="analysis-distribution-cell"
        :class="{ 'is-hovered': hoveredIndex === index }"
        tabindex="0"
        @mouseenter="enterItem($event, index)"
        @mouseleave="leaveItem"
        @focus="enterItem($event, index)"
        @blur="leaveItem"
      >
        <i class="analysis-distribution-track" />
        <small>{{ entry.label }}</small>
      </span>
    </template>
    <template v-else>
      <i
        v-for="(entry, index) in entries"
        :key="entry.key"
        class="analysis-distribution-track analysis-distribution-cell"
        :class="{ 'is-hovered': hoveredIndex === index }"
        tabindex="0"
        @mouseenter="enterItem($event, index)"
        @mouseleave="leaveItem"
        @focus="enterItem($event, index)"
        @blur="leaveItem"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { PerceptualSurfaceBinding } from '../perceptualSurface'
import { vPerceptualSurface } from '../perceptualSurface'
import { getUiMotionDurationMs, getUiMotionEasingFunction } from '../uiMotion'
import { useResponsiveGeometry } from '../useResponsiveGeometry'

export type DistributionBarEntry = Readonly<{
  key: string | number
  scale: number
  label?: string
  gapBefore?: boolean
}>

const props = defineProps<{
  entries: readonly DistributionBarEntry[]
  colorVariable: string
  reduceMotion: boolean
  showLabels: boolean
  trackSurface: PerceptualSurfaceBinding
  referenceRatio?: number | null
}>()
const emit = defineEmits<{
  itemEnter: [event: Event, index: number]
  itemLeave: []
}>()

type DistributionCanvasElement = HTMLCanvasElement & {
  rmsDistributionRenderSignature?: string
  rmsDistributionGapPixels?: number[]
}
const rootElement = ref<HTMLElement | null>(null)
const canvasElement = ref<DistributionCanvasElement | null>(null)
const hoveredIndex = ref<number | null>(null)
let displayedScales: number[] = []
let animationFrame = 0
let measuredStructureKey = ''
let measuredColorVariable = ''
let renderGeometry: {
  width: number
  height: number
  color: string
  gapColor: string
  tracks: Array<{ left: number; right: number; top: number; bottom: number }>
} | null = null

function structureKey(): string {
  return `${props.showLabels ? 'labels' : 'tracks'}:${props.entries.map(entry => (
    `${entry.gapBefore ? '1' : '0'}:${String(entry.key)}`
  )).join('\u001f')}`
}

const displayedReferenceRatio = ref<number | null>(null)

const referenceLineStyle = computed<Record<string, string> | null>(() => {
  if (displayedReferenceRatio.value === null) return null
  const ratio = displayedReferenceRatio.value
  return { '--analysis-distribution-reference-top': `${((1 - ratio) * 100).toFixed(3)}%` }
})

function enterItem(event: Event, index: number) {
  hoveredIndex.value = index
  emit('itemEnter', event, index)
}

function leaveItem() {
  hoveredIndex.value = null
  emit('itemLeave')
}

function targetScales(): number[] {
  return props.entries.map(entry => Math.max(0, Math.min(1, entry.scale)))
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
  const color = rootStyle.getPropertyValue(props.colorVariable).trim()
  const gapColor = rootStyle.getPropertyValue('--analysis-distribution-gap-color').trim()
    || 'rgba(1, 42, 49, 0.82)'
  const tracks = [...root.querySelectorAll<HTMLElement>('.analysis-distribution-track')].map((track) => {
    const trackRect = track.getBoundingClientRect()
    const trackStyle = getComputedStyle(track)
    const borderLeft = Number.parseFloat(trackStyle.borderLeftWidth) || 0
    return {
      left: Math.max(0, Math.round((trackRect.left - rootRect.left + borderLeft) * ratio)),
      right: Math.min(width, Math.round((trackRect.right - rootRect.left) * ratio)),
      top: Math.max(0, Math.round((trackRect.top - rootRect.top) * ratio)),
      bottom: Math.min(height, Math.round((trackRect.bottom - rootRect.top) * ratio)),
    }
  })
  renderGeometry = { width, height, color, gapColor, tracks }
  measuredStructureKey = structureKey()
  measuredColorVariable = props.colorVariable
}

function render() {
  const canvas = canvasElement.value
  if (!canvas) return
  if (!renderGeometry) measureGeometry()
  if (!renderGeometry) return
  const { width, height, color, gapColor, tracks } = renderGeometry
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, width, height)
  tracks.forEach(({ left, right, top, bottom }, index) => {
    const trackHeight = Math.max(0, bottom - top)
    const scale = Math.max(0, Math.min(1, displayedScales[index] || 0))
    const fillHeight = Math.max(0, Math.min(trackHeight, Math.round(trackHeight * scale)))
    if (right <= left || fillHeight <= 0) return
    context.fillStyle = color
    context.fillRect(left, bottom - fillHeight, right - left, fillHeight)
  })
  const gapPixels: number[] = []
  tracks.forEach(({ left, top, bottom }, index) => {
    if (!props.entries[index]?.gapBefore || left <= 0 || bottom <= top) return
    context.fillStyle = gapColor
    context.fillRect(left, top, 1, bottom - top)
    gapPixels.push(left)
  })
  canvas.rmsDistributionRenderSignature = displayedScales
    .map(value => Math.round(value * 10000))
    .join(',')
  canvas.rmsDistributionGapPixels = gapPixels
}

function stopAnimation() {
  if (animationFrame) cancelAnimationFrame(animationFrame)
  animationFrame = 0
}

function animate() {
  stopAnimation()
  const target = targetScales()
  const targetReferenceRatio = Number.isFinite(props.referenceRatio)
    ? Math.max(0, Math.min(1, Number(props.referenceRatio)))
    : null
  // A guide that is not meaningful for the target range must not linger or
  // flash during the bar transition. Only an entering or still-valid guide
  // participates in the scale animation.
  if (targetReferenceRatio === null) displayedReferenceRatio.value = null
  const sourceReferenceRatio = displayedReferenceRatio.value ?? 1
  const settledReferenceRatio = targetReferenceRatio ?? 1
  const referenceUnchanged = targetReferenceRatio === null
    || Math.abs(settledReferenceRatio - sourceReferenceRatio) <= 1e-6
  const unchanged = referenceUnchanged
    && target.length === displayedScales.length
    && target.every((value, index) => Math.abs(value - displayedScales[index]) <= 1e-6)
  if (!displayedScales.length || props.reduceMotion || unchanged) {
    displayedScales = target
    displayedReferenceRatio.value = targetReferenceRatio
    render()
    return
  }
  const source = [...displayedScales]
  if (displayedReferenceRatio.value === null && targetReferenceRatio !== null) {
    displayedReferenceRatio.value = 1
  }
  let startedAt: number | null = null
  const duration = getUiMotionDurationMs()
  const easing = getUiMotionEasingFunction()
  const step = (now: number) => {
    if (startedAt === null) startedAt = now
    const progress = Math.max(0, Math.min(1, (now - startedAt) / duration))
    const eased = easing(progress)
    displayedScales = target.map((value, index) => {
      const start = source[index] ?? value
      return start + ((value - start) * eased)
    })
    if (targetReferenceRatio !== null) {
      displayedReferenceRatio.value = sourceReferenceRatio
        + ((settledReferenceRatio - sourceReferenceRatio) * eased)
    }
    render()
    if (progress < 1) animationFrame = requestAnimationFrame(step)
    else {
      displayedReferenceRatio.value = targetReferenceRatio
      animationFrame = 0
    }
  }
  animationFrame = requestAnimationFrame(step)
}

function updateGeometry() {
  measureGeometry()
  render()
}

useResponsiveGeometry(rootElement, updateGeometry, {
  resizeAncestorSelector: '.analysis-opponent-prediction-grid',
  styleAncestorSelector: '.dock-module',
})

watch(() => [props.entries, props.colorVariable, props.reduceMotion, props.referenceRatio], () => {
  void nextTick(() => {
    if (
      !renderGeometry
      || measuredStructureKey !== structureKey()
      || measuredColorVariable !== props.colorVariable
    ) measureGeometry()
    animate()
  })
}, { immediate: true, flush: 'post' })

onBeforeUnmount(() => stopAnimation())
</script>

<style scoped src="./DistributionBarChart.css"></style>
