<template>
  <div
    ref="rootElement"
    v-perceptual-surface="trackSurface"
    class="analysis-distribution-chart"
    :class="{
      'has-labels': showLabels,
      'has-outside-axis': outsideAxis,
    }"
  >
    <div ref="viewportElement" class="analysis-distribution-viewport" @scroll="scheduleGeometry">
      <div ref="plotElement" class="analysis-distribution-plot">
        <canvas ref="canvasElement" class="analysis-distribution-canvas" aria-hidden="true" />
        <span v-if="showLabels && !entries.length && showAxis" class="analysis-distribution-placeholder" aria-hidden="true">
          <i class="analysis-distribution-track" /><small>&nbsp;</small>
        </span>
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
    </div>
    <ProbabilityAxis
      v-if="showAxis && probabilityScale !== undefined"
      :scale="displayedProbabilityScale"
      direction="up"
      :style="axisLayoutStyle"
      :height="axisHeight"
      :label-spacing="axisLabelSpacing"
      :clamp-endpoints="true"
      :show-line="outsideAxis"
    />
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { PerceptualSurfaceBinding } from '../perceptualSurface'
import { vPerceptualSurface } from '../perceptualSurface'
import { getUiMotionDurationMs, getUiMotionEasingFunction } from '../uiMotion'
import { useResponsiveGeometry } from '../useResponsiveGeometry'
import { useCanvasPaintSnapshots } from '../canvasPaintSnapshot'
import { distributionBarGeometry } from '../distributionBarGeometry'
import ProbabilityAxis from './ProbabilityAxis.vue'

export type DistributionBarEntry = Readonly<{
  key: string | number
  scale: number
  label?: string
  gapBefore?: boolean
}>

const props = withDefaults(defineProps<{
  entries: readonly DistributionBarEntry[]
  colorVariable: string
  reduceMotion: boolean
  showLabels: boolean
  trackSurface: PerceptualSurfaceBinding
  referenceRatio?: number | null
  probabilityScale?: number
  showAxis?: boolean
  outsideAxis?: boolean
}>(), { showAxis: true, outsideAxis: false })
const emit = defineEmits<{
  itemEnter: [event: Event, index: number]
  itemLeave: []
}>()

type DistributionCanvasElement = HTMLCanvasElement & {
  readonly rmsDistributionRenderSignature?: string
  rmsDistributionGapPixels?: number[]
  rmsDistributionTracks?: Array<{ left: number; right: number; top: number; bottom: number }>
  rmsDistributionGuideBounds?: { left: number; right: number; top: number; bottom: number } | null
}
const rootElement = ref<HTMLElement | null>(null)
const viewportElement = ref<HTMLElement | null>(null)
const plotElement = ref<HTMLElement | null>(null)
const axisLayoutStyle = ref<Record<string, string>>({})
const axisHeight = ref(0)
const axisLabelSpacing = ref(0)
const displayedProbabilityScale = ref(props.probabilityScale ?? 1)
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
  guideTrack: { left: number; right: number; top: number; bottom: number; lineHeight: number } | null
  tracks: Array<{ left: number; right: number; top: number; bottom: number }>
  gaps: Array<{ left: number; right: number }>
} | null = null

function structureKey(): string {
  return `${props.showLabels ? 'labels' : 'tracks'}:${props.entries.map(entry => (
    `${entry.gapBefore ? '1' : '0'}:${String(entry.key)}`
  )).join('\u001f')}`
}

let displayedReferenceRatio: number | null = null
const { publish: publishSnapshot } = useCanvasPaintSnapshots<readonly number[]>('rmsDistributionRenderSignature',
  values => values.map(value => Math.round(value * 10000)).join(','))

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
  const root = plotElement.value
  const viewport = viewportElement.value
  const canvas = canvasElement.value
  if (!root || !viewport || !canvas) {
    renderGeometry = null
    return
  }
  const rootRect = root.getBoundingClientRect()
  const viewportRect = viewport.getBoundingClientRect()
  if (viewportRect.width <= 0 || rootRect.height <= 0) { renderGeometry = null; return }
  const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
  const originX = Math.ceil(rootRect.left * ratio)
  const originY = Math.ceil(rootRect.top * ratio)
  const height = Math.max(1, Math.floor(rootRect.bottom * ratio) - originY)
  const rootStyle = getComputedStyle(root)
  const color = rootStyle.getPropertyValue(props.colorVariable).trim()
  const gapColor = rootStyle.getPropertyValue('--analysis-distribution-gap-color').trim()
    || 'rgba(1, 42, 49, 0.82)'
  const cells = [...root.querySelectorAll<HTMLElement>('.analysis-distribution-cell')]
  const firstTrack = root.querySelector<HTMLElement>('.analysis-distribution-track')?.getBoundingClientRect()
  const top = Math.max(0, Math.ceil((firstTrack?.top ?? rootRect.top) * ratio) - originY)
  const bottom = Math.min(height, Math.floor((firstTrack?.bottom ?? rootRect.bottom) * ratio) - originY)
  const geometry = distributionBarGeometry(
    Math.floor(viewportRect.right * ratio) - Math.ceil(viewportRect.left * ratio),
    props.entries.map((entry, index) => index > 0 && (props.showLabels || Boolean(entry.gapBefore))),
    (Number.parseFloat(rootStyle.getPropertyValue('--analysis-distribution-gap-width')) || 1) * ratio,
  )
  const width = geometry.contentWidth
  const tracks = geometry.bars.map(bar => ({ ...bar, top, bottom }))
  const offsetX = originX / ratio - rootRect.left
  const offsetY = originY / ratio - rootRect.top
  const axis = rootElement.value?.querySelector('.analysis-probability-axis')
  const captionSize = axis ? Number.parseFloat(getComputedStyle(axis).fontSize) : 10
  const guideTrack = tracks.length ? {
    left: Math.min(...tracks.map(track => track.left)),
    right: Math.max(...tracks.map(track => track.right)),
    top: Math.min(...tracks.map(track => track.top)),
    bottom: Math.max(...tracks.map(track => track.bottom)),
    lineHeight: Math.max(1, Math.round(ratio)),
  } : null
  // Bitmap resize can invalidate style/layout. Finish every track read first,
  // including a newly revealed chart after a frame without a distribution.
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  // Exact CSS pixel coverage and aligned global origin prevent a second canvas
  // resampling step. Cells/hovers and paint share the same integer allocation.
  canvas.style.cssText = `left:${offsetX}px;top:${offsetY}px;width:${width / ratio}px;height:${height / ratio}px`
  // Scroll extents are integer CSS pixels. Round the overflow container outward
  // so its last physical column is reachable at fractional DPI as well.
  root.style.width = `${Math.ceil(width / ratio + offsetX)}px`
  cells.forEach((cell, index) => {
    const track = tracks[index]!
    cell.style.cssText = `position:absolute;left:${offsetX + track.left / ratio}px;top:0;width:${(track.right - track.left) / ratio}px;height:100%`
  })
  axisHeight.value = Math.max(0, bottom - top) / ratio
  axisLabelSpacing.value = captionSize * 1.5
  axisLayoutStyle.value = { top: `${offsetY + top / ratio}px`, height: `${axisHeight.value}px` }
  renderGeometry = { width, height, color, gapColor, tracks, guideTrack, gaps: geometry.gaps }
  measuredStructureKey = structureKey()
  measuredColorVariable = props.colorVariable
}

function render() {
  const canvas = canvasElement.value
  if (!canvas) return
  if (!renderGeometry) measureGeometry()
  if (!renderGeometry) return
  const { width, height, color, gapColor, tracks, gaps } = renderGeometry
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
  gaps.forEach(({ left, right }) => {
    const { top, bottom } = tracks[0]!
    context.fillStyle = gapColor
    context.fillRect(left, top, right - left, bottom - top)
    gapPixels.push(left)
  })
  publishSnapshot(canvas, displayedScales)
  canvas.rmsDistributionGapPixels = gapPixels
  canvas.rmsDistributionTracks = tracks
  canvas.rmsDistributionGuideBounds = null
  if (displayedReferenceRatio !== null && renderGeometry.guideTrack) {
    const { left, right, top, bottom } = renderGeometry.guideTrack
    const lineHeight = Math.min(renderGeometry.guideTrack.lineHeight, bottom - top)
    if (right > left && bottom > top) {
      const lineTop = Math.max(top, Math.min(bottom - lineHeight,
        Math.round(bottom - ((bottom - top) * displayedReferenceRatio))))
      context.fillStyle = 'rgba(198, 214, 211, 0.42)'
      context.fillRect(left, lineTop, right - left, lineHeight)
      canvas.rmsDistributionGuideBounds = { left, right, top: lineTop, bottom: lineTop + lineHeight }
    }
  }
}

function stopAnimation() {
  if (animationFrame) cancelAnimationFrame(animationFrame)
  animationFrame = 0
}

function animate() {
  if (!canvasElement.value) return
  stopAnimation()
  const target = targetScales()
  const targetProbabilityScale = props.probabilityScale ?? 1
  const sourceProbabilityScale = displayedProbabilityScale.value
  const targetReferenceRatio = Number.isFinite(props.referenceRatio)
    ? Math.max(0, Math.min(1, Number(props.referenceRatio)))
    : null
  // A guide that is not meaningful for the target range must not linger or
  // flash during the bar transition. Only an entering or still-valid guide
  // participates in the scale animation.
  if (targetReferenceRatio === null && displayedReferenceRatio !== null) {
    displayedReferenceRatio = null
    render()
  }
  const sourceReferenceRatio = displayedReferenceRatio ?? 1
  const settledReferenceRatio = targetReferenceRatio ?? 1
  const referenceUnchanged = targetReferenceRatio === null
    || Math.abs(settledReferenceRatio - sourceReferenceRatio) <= 1e-6
  const unchanged = referenceUnchanged && Math.abs(sourceProbabilityScale - targetProbabilityScale) <= 1e-6
    && target.length === displayedScales.length
    && target.every((value, index) => Math.abs(value - displayedScales[index]) <= 1e-6)
  // An empty rightmost plot can still own the group's live outer scale.
  // Its axis must animate even when there are no local bars to interpolate.
  if ((!displayedScales.length && !props.outsideAxis) || props.reduceMotion || unchanged) {
    displayedScales = target
    displayedReferenceRatio = targetReferenceRatio
    displayedProbabilityScale.value = targetProbabilityScale
    render()
    return
  }
  const source = [...displayedScales]
  if (displayedReferenceRatio === null && targetReferenceRatio !== null) {
    displayedReferenceRatio = 1
    render()
  }
  let startedAt: number | null = null
  const duration = getUiMotionDurationMs()
  const easing = getUiMotionEasingFunction()
  const step = (now: number) => {
    if (startedAt === null) startedAt = now
    const progress = Math.max(0, Math.min(1, (now - startedAt) / duration))
    const eased = easing(progress)
    displayedProbabilityScale.value = sourceProbabilityScale + (targetProbabilityScale - sourceProbabilityScale) * eased
    displayedScales = target.map((value, index) => {
      const start = source[index] ?? value
      return start + ((value - start) * eased)
    })
    if (targetReferenceRatio !== null) {
      displayedReferenceRatio = props.probabilityScale !== undefined
        ? Math.min(1, targetReferenceRatio * targetProbabilityScale / displayedProbabilityScale.value)
        : sourceReferenceRatio + ((settledReferenceRatio - sourceReferenceRatio) * eased)
    }
    render()
    if (progress < 1) animationFrame = requestAnimationFrame(step)
    else {
      displayedReferenceRatio = targetReferenceRatio
      animationFrame = 0
    }
  }
  animationFrame = requestAnimationFrame(step)
}

function updateGeometry() {
  measureGeometry()
  render()
}

const scheduleGeometry = useResponsiveGeometry(viewportElement, updateGeometry, {
  resizeAncestorSelector: '.analysis-opponent-prediction-grid',
  styleAncestorSelector: '.dock-module',
})

watch(() => [props.entries, props.colorVariable, props.reduceMotion, props.referenceRatio, props.probabilityScale], () => {
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
