<template>
  <div class="analysis-tiles-view">
    <div ref="riskGridElement" v-perceptual-surface="riskTrackSurface" class="analysis-risk-grid">
      <div v-for="row in tileRows" :key="row[0]" class="analysis-tile-chart-row analysis-risk-row">
        <div class="analysis-tile-sequence">
          <canvas
            :ref="element => setRiskCanvasElement(row[0], element)"
            class="analysis-risk-row-canvas"
            aria-hidden="true"
          />
          <div v-for="(tile, tileIndex) in row" :key="tile" class="analysis-risk-tile">
            <img class="mahjong-tile-artwork analysis-tile-face" :src="tileImageSrc(tile)" :alt="tileFaceLabel(tile)" />
            <div
              class="analysis-risk-bars"
            >
              <i
                v-for="source in opponentSources"
                :key="source.key"
                :class="`source-${source.key}`"
                tabindex="0"
                @mouseenter="showProbabilityTooltip($event, tileFaceLabel(tile), source.label, riskProbability(source.seat, tile))"
                @mouseleave="tooltip.clear"
                @focus="showProbabilityTooltip($event, tileFaceLabel(tile), source.label, riskProbability(source.seat, tile))"
                @blur="tooltip.clear"
              />
            </div>
            <span
              v-if="tileIndex < row.length - 1"
              class="analysis-risk-bridge"
              aria-hidden="true"
            />
          </div>
        </div>
        <div class="analysis-risk-scale" aria-hidden="true">
          <span v-for="tick in riskScaleTicks" :key="tick.value" :style="{ top: riskScalePosition(tick.value) }"><i /><small>{{ tick.label }}</small></span>
        </div>
      </div>
      <div v-perceptual-surface="riskLegendSurface" class="analysis-source-legend">
        <span v-for="source in opponentSources" :key="source.key"><i :class="`source-${source.key}`" />{{ source.label }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { analysisRiskGeometry } from '../analysisRiskGeometry'
import { DEFAULT_PROBABILITY_SCALE as RISK_ADAPTIVE_MIN } from '../analysisProbabilityScale'
import { analysisSurface } from '../analysisSurface'
import type { AnalysisPanelDataProps } from '../analysisPanelTypes'
import { ANALYSIS_TILE_ROWS } from '../analysisTiles'
import { vPerceptualSurface, type PerceptualSurfaceBinding } from '../perceptualSurface'
import { useAnalysisHoverTooltipController } from '../useAnalysisHoverTooltip'
import { useAnalysisPanelFormatting } from '../useAnalysisPanelFormatting'
import { useResponsiveGeometry } from '../useResponsiveGeometry'
import { useRiskAnalysisData } from '../useRiskAnalysisData'
import { getUiMotionDurationMs, getUiMotionEasingFunction } from '../uiMotion'

const props = defineProps<AnalysisPanelDataProps & {
  tileImageSrc: (tile: string) => string
  tileFaceLabel: (tile: string) => string
  perceptualSurface: PerceptualSurfaceBinding
  reduceMotion: boolean
}>()
const tooltip = useAnalysisHoverTooltipController()
const { formatProbability } = useAnalysisPanelFormatting()
const tileRows = ANALYSIS_TILE_ROWS
const riskGridElement = ref<HTMLElement | null>(null)
type RiskCanvasElement = HTMLCanvasElement & {
  rmsRiskRenderSignature?: string
  rmsRiskGuideBounds?: { left: number; right: number; top: number; bottom: number } | null
  rmsRiskGeometry?: {
    width: number
    height: number
    tileWidth: number
    barsWidth: number
    colors: string[]
    guideColor: string
    pixelRatio: number
  }
}
const riskCanvasElements = new Map<string, { canvas: RiskCanvasElement; row: readonly string[] }>()
let displayedRiskScales: number[][][] = []
let riskAnimationFrame = 0
const riskTrackSurface = analysisSurface(
  () => props.perceptualSurface,
  'analysis-risk-track',
  ['--analysis-risk-track-surface'],
)
const riskLegendSurface = analysisSurface(() => props.perceptualSurface, 'analysis-risk-legend')
const {
  opponentSources,
  riskProbability,
  showRiskAdaptiveThreshold,
  riskScaleTicks,
  riskBarScale,
  riskScalePosition,
} = useRiskAnalysisData(props)

function riskScaleTargets(): number[][][] {
  return tileRows.map(row => row.map(tile => (
    opponentSources.value.map(source => riskBarScale(riskProbability(source.seat, tile)))
  )))
}

function copyRiskScales(values: number[][][]): number[][][] {
  return values.map(row => row.map(tile => [...tile]))
}

function measureRiskCanvas(canvas: RiskCanvasElement) {
  const rect = canvas.getBoundingClientRect()
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(rect.width * ratio))
  const height = Math.max(1, Math.round(rect.height * ratio))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const style = getComputedStyle(canvas)
  const tileWidth = Number.parseFloat(style.getPropertyValue('--analysis-tile-width')) * ratio
  const barsWidth = Number.parseFloat(style.getPropertyValue('--analysis-risk-bars-width')) * ratio
  const colors = opponentSources.value.map(source => (
    style.getPropertyValue(`--ron-${source.key}-color`).trim()
  ))
  const guideColor = style.getPropertyValue('--analysis-risk-guide-color').trim()
  canvas.rmsRiskGeometry = { width, height, tileWidth, barsWidth, colors, guideColor, pixelRatio: ratio }
}

function measureRiskCanvases() {
  for (const { canvas } of riskCanvasElements.values()) measureRiskCanvas(canvas)
}

function renderRiskCanvas(rowIndex: number, canvas: RiskCanvasElement, row: readonly string[]) {
  if (!canvas.rmsRiskGeometry) measureRiskCanvas(canvas)
  const geometry = canvas.rmsRiskGeometry
  if (!geometry) return
  const { width, height, tileWidth, barsWidth, colors, guideColor, pixelRatio } = geometry
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, width, height)
  const rowScales = displayedRiskScales[rowIndex] || []
  ;(canvas as RiskCanvasElement).rmsRiskRenderSignature = rowScales
    .flat()
    .map(value => Math.round(value * 10000))
    .join(',')
  const laneCount = Math.max(1, opponentSources.value.length)
  for (let tileIndex = 0; tileIndex < row.length; tileIndex += 1) {
    const groupLeft = (tileIndex * tileWidth) + ((tileWidth - barsWidth) / 2)
    for (let sourceIndex = 0; sourceIndex < laneCount; sourceIndex += 1) {
      const left = Math.round(groupLeft + ((sourceIndex * barsWidth) / laneCount))
      const right = Math.round(groupLeft + (((sourceIndex + 1) * barsWidth) / laneCount))
      const scale = Math.max(0, Math.min(1, rowScales[tileIndex]?.[sourceIndex] || 0))
      const bottom = Math.max(0, Math.min(height, Math.round(scale * height)))
      if (right <= left || bottom <= 0) continue
      context.fillStyle = colors[sourceIndex]
      context.fillRect(left, 0, right - left, bottom)
    }
  }
  if (showRiskAdaptiveThreshold.value && row.length > 0) {
    const lineWidth = Math.max(1, Math.round(pixelRatio))
    const lineTop = Math.max(
      0,
      Math.min(height - lineWidth, Math.round((riskBarScale(RISK_ADAPTIVE_MIN) * height) - (lineWidth / 2))),
    )
    const lineLeft = 0
    const lineRight = Math.min(width, Math.round(row.length * tileWidth))
    context.fillStyle = guideColor
    context.fillRect(lineLeft, lineTop, Math.max(0, lineRight - lineLeft), lineWidth)
    canvas.rmsRiskGuideBounds = {
      left: lineLeft,
      right: lineRight,
      top: lineTop,
      bottom: lineTop + lineWidth,
    }
  } else {
    canvas.rmsRiskGuideBounds = null
  }
}

function renderRiskCanvases() {
  tileRows.forEach((row, rowIndex) => {
    const entry = riskCanvasElements.get(row[0])
    if (entry) renderRiskCanvas(rowIndex, entry.canvas, entry.row)
  })
}

function stopRiskAnimation() {
  if (riskAnimationFrame) cancelAnimationFrame(riskAnimationFrame)
  riskAnimationFrame = 0
}

function animateRiskCanvases() {
  stopRiskAnimation()
  const target = riskScaleTargets()
  const unchanged = target.every((row, rowIndex) => row.every((tile, tileIndex) => (
    tile.every((value, sourceIndex) => Math.abs(value - (displayedRiskScales[rowIndex]?.[tileIndex]?.[sourceIndex] ?? value)) <= 1e-6)
  )))
  if (!displayedRiskScales.length || props.reduceMotion || unchanged) {
    displayedRiskScales = copyRiskScales(target)
    renderRiskCanvases()
    return
  }
  const source = copyRiskScales(displayedRiskScales)
  let startedAt: number | null = null
  const duration = getUiMotionDurationMs()
  const easing = getUiMotionEasingFunction()
  const step = (now: number) => {
    if (startedAt === null) startedAt = now
    const progress = Math.max(0, Math.min(1, (now - startedAt) / duration))
    const eased = easing(progress)
    displayedRiskScales = target.map((row, rowIndex) => row.map((tile, tileIndex) => (
      tile.map((value, sourceIndex) => {
        const start = source[rowIndex]?.[tileIndex]?.[sourceIndex] ?? value
        return start + ((value - start) * eased)
      })
    )))
    renderRiskCanvases()
    if (progress < 1) riskAnimationFrame = requestAnimationFrame(step)
    else riskAnimationFrame = 0
  }
  riskAnimationFrame = requestAnimationFrame(step)
}

function setRiskCanvasElement(key: string, element: unknown) {
  if (!(element instanceof HTMLCanvasElement)) riskCanvasElements.delete(key)
  else riskCanvasElements.set(key, { canvas: element as RiskCanvasElement, row: tileRows.find(row => row[0] === key) || [] })
  renderRiskCanvases()
}

function updateRiskGeometry() {
  const grid = riskGridElement.value
  if (!grid) return
  const gridStyle = getComputedStyle(grid)
  const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const floatingScale = Number.parseFloat(gridStyle.getPropertyValue('--floating-panel-scale')) || 1
  const tileEm = Number.parseFloat(gridStyle.fontSize) || rootRem * floatingScale
  const geometry = analysisRiskGeometry({
    availableWidth: grid.getBoundingClientRect().width,
    availableHeight: grid.getBoundingClientRect().height,
    pixelRatio: window.devicePixelRatio,
    scaleSpace: 2.45 * rootRem * floatingScale,
    legendHeight: grid.querySelector<HTMLElement>('.analysis-source-legend')?.getBoundingClientRect().height || 0,
    minimumTileWidth: 1.35 * rootRem * floatingScale,
    maximumTileWidth: 3 * tileEm,
    rowCount: tileRows.length,
    longestRow: Math.max(...tileRows.map((row) => row.length)),
    laneCount: opponentSources.value.length,
  })
  grid.style.setProperty('--analysis-tile-width', `${geometry.tileWidth}px`)
  grid.style.setProperty('--analysis-tile-height', `${geometry.tileHeight}px`)
  grid.style.setProperty('--analysis-risk-bars-width', `${geometry.barsWidth}px`)
  grid.style.setProperty('--analysis-risk-bars-height', `${geometry.barsHeight}px`)
  grid.style.setProperty('--analysis-chart-gap', `${geometry.chartGap}px`)
  grid.style.setProperty('--analysis-risk-grid-gap', `${geometry.gridGap}px`)
  grid.style.setProperty('--analysis-risk-main-row-width', `${geometry.mainRowWidth}px`)
  grid.style.setProperty('--analysis-scale-space', `${geometry.scaleSpace}px`)
  grid.style.setProperty('--analysis-risk-row-min-height', `${geometry.rowMinimumHeight}px`)
  grid.style.setProperty('--analysis-risk-grid-min-height', `${geometry.gridMinimumHeight}px`)
  grid.style.setProperty('--analysis-risk-grid-content-height', `${geometry.gridContentHeight}px`)
  measureRiskCanvases()
  renderRiskCanvases()
}

useResponsiveGeometry(riskGridElement, updateRiskGeometry, {
  resizeAncestorSelector: '.analysis-tiles-view',
  styleAncestorSelector: '.dock-module',
})

watch(() => [props.analysis, props.analysisOpponents, props.controlledSeat, props.reduceMotion], () => {
  void nextTick(animateRiskCanvases)
}, { immediate: true, flush: 'post' })

onBeforeUnmount(() => {
  stopRiskAnimation()
  riskCanvasElements.clear()
})

function showProbabilityTooltip(event: Event, title: string, label: string, value: number) {
  tooltip.show(event, { title, lines: [], rows: [{ label, value: formatProbability(value) }] })
}
</script>

<style scoped src="./DealInRiskSection.css"></style>
