<template>
  <div class="analysis-tiles-view">
    <div
      ref="countGridElement"
      v-perceptual-surface="countSurface"
      class="analysis-count-grid"
      :class="{ 'is-source-row-layout': countLayout === 'source-rows' }"
      @perceptual-surface-change="scheduleCountBarGeometry"
    >
      <div class="analysis-count-layout-toggle" role="group" :aria-label="t('analysis.countLayout')">
        <button type="button" :class="{ active: countLayout === 'source-rows' }" @click="emit('update:countLayout', 'source-rows')">{{ t('analysis.countLayoutSources') }}</button>
        <button type="button" :class="{ active: countLayout === 'tile-groups' }" @click="emit('update:countLayout', 'tile-groups')">{{ t('analysis.countLayoutTiles') }}</button>
      </div>
      <template v-if="countLayout === 'tile-groups'">
        <div
          v-for="(row, rowIndex) in countTileRows"
          :key="row.tiles.join('-')"
          class="analysis-tile-chart-row analysis-count-row"
          :class="{ 'is-final-row': rowIndex === countTileRows.length - 1 }"
        >
          <div class="analysis-tile-sequence">
            <canvas :ref="(element) => setCountCanvasElement(row.key, row.tiles, element)" class="analysis-count-row-canvas" aria-hidden="true" />
            <div v-for="tile in row.tiles" :key="tile" class="analysis-count-tile" :class="{ 'is-red-five': isRedFiveTile(tile) }">
              <div class="analysis-count-bars">
                <button
                  v-for="source in countSources"
                  :key="source.key"
                  type="button"
                  :class="`source-${source.key}`"
                  :aria-label="t('analysis.tileCountDistribution', { source: source.label, tile: tileFaceLabel(tile) })"
                  @mouseenter="showCountTooltip($event, tile, source)"
                  @mouseleave="clearCountTooltip"
                  @focus="showCountTooltip($event, tile, source)"
                  @blur="clearCountTooltip"
                />
              </div>
              <img class="mahjong-tile-artwork analysis-tile-face" :src="tileImageSrc(tile)" :alt="tileFaceLabel(tile)" />
            </div>
          </div>
          <div v-if="rowIndex === countTileRows.length - 1" class="analysis-count-legends">
            <div class="analysis-count-palette-legend" aria-hidden="true">
              <span aria-hidden="true" />
              <small v-for="value in [0, 1, 2, 3, 4]" :key="`heading-${value}`">{{ value }}</small>
              <template v-for="source in countSources" :key="source.key">
                <strong>{{ source.label }}</strong>
                <i v-for="value in [0, 1, 2, 3, 4]" :key="`${source.key}-${value}`" :style="{ background: countSegmentColor(source.key, value) }" />
              </template>
            </div>
          </div>
        </div>
      </template>
      <div v-else class="analysis-count-source-layout">
        <div v-for="source in countSources" :key="source.key" class="analysis-count-source-row">
          <div class="analysis-count-source-sequence-shell">
            <div class="analysis-count-source-sequence">
              <canvas
                :ref="(element) => setSourceCanvasElement(source.key, source, element)"
                class="analysis-count-source-row-canvas"
                aria-hidden="true"
              />
              <button
                v-for="entry in countSourceTiles"
                :key="entry.tile"
                type="button"
                class="analysis-count-source-tile"
                :class="{ 'is-group-start': entry.groupStart, 'is-red-five': isRedFiveTile(entry.tile) }"
                :aria-label="t('analysis.tileCountDistribution', { source: source.label, tile: tileFaceLabel(entry.tile) })"
                @mouseenter="showCountTooltip($event, entry.tile, source)"
                @mouseleave="clearCountTooltip"
                @focus="showCountTooltip($event, entry.tile, source)"
                @blur="clearCountTooltip"
              >
                <span class="analysis-count-source-bar" />
                <img class="mahjong-tile-artwork" :src="tileImageSrc(entry.tile)" alt="" />
              </button>
            </div>
          </div>
        </div>
      </div>
      <div v-if="countLayout === 'source-rows'" class="analysis-count-source-legend" aria-hidden="true">
        <div v-for="source in countSources" :key="source.key" class="analysis-count-source-legend-group">
          <span aria-hidden="true" />
          <small v-for="value in [0, 1, 2, 3, 4]" :key="`${source.key}-heading-${value}`">{{ value }}</small>
          <strong>{{ source.label }}</strong>
          <i v-for="value in [0, 1, 2, 3, 4]" :key="`${source.key}-${value}`" :style="{ background: countSegmentColor(source.key, value) }" />
        </div>
      </div>
    </div>
    <CountPredictionTooltip v-if="countHoverTooltip" v-bind="countHoverTooltip" @close="clearCountTooltip" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { groupedCountGeometry } from '../analysisCountGeometry'
import { ANALYSIS_COUNT_SPACING, type AnalysisCountLayout } from '../analysisCountSpacing'
import { COUNT_EMPTY_COLOR, countPaletteVariable, countSegmentColor, countSourcePalette } from '../analysisCountPalette'
import type { AnalysisPanelDataProps, TileSource } from '../analysisPanelTypes'
import { isRedFiveTile } from '../analysisTiles'
import { vPerceptualSurface, type PerceptualSurfaceBinding } from '../perceptualSurface'
import { useCountAnalysisData } from '../useCountAnalysisData'
import { useI18n } from '../i18n'
import { useResponsiveGeometry } from '../useResponsiveGeometry'
import { getUiMotionDurationMs, getUiMotionEasingFunction } from '../uiMotion'
import CountPredictionTooltip from './CountPredictionTooltip.vue'

const COUNT_TILE_ASPECT_RATIO = 3.18 / 2.45
const COUNT_GRID_GAP_RATIO = 0.1
const COUNT_SOURCE_ROW_GAP_RATIO = 0.12

const props = defineProps<AnalysisPanelDataProps & {
  tileImageSrc: (tile: string) => string
  tileFaceLabel: (tile: string) => string
  perceptualSurface: PerceptualSurfaceBinding
  countLayout: AnalysisCountLayout
  reduceMotion: boolean
}>()
const emit = defineEmits<{ 'update:countLayout': [value: AnalysisCountLayout] }>()
const { t } = useI18n()
const countGridElement = ref<HTMLElement | null>(null)
type CountCanvasElement = HTMLCanvasElement & { rmsCountRenderSignature?: string }
const countCanvasElements = new Map<string, { canvas: CountCanvasElement; row: readonly string[] }>()
const sourceCanvasElements = new Map<string, { canvas: CountCanvasElement; source: TileSource }>()
let displayedCountDistributions = new Map<string, number[]>()
let countAnimationFrame = 0
const countHoverTarget = ref<{
  anchor: Element
  tile: string
  sourceKey: string
  contextKey: string
  controlledSeat: number
} | null>(null)
const countSurface = computed<PerceptualSurfaceBinding>(() => ({
  ...props.perceptualSurface,
  debugLabel: 'analysis-count-panel',
  surfaceOverride: COUNT_EMPTY_COLOR,
}))
const {
  countTileRows,
  countSourceTiles,
  countSources,
  tilePrediction,
  countSegments,
  countTooltipContextKey,
  hasCountPrediction,
} = useCountAnalysisData(props, () => t('analysis.wall'))

function countDistributionKey(tile: string, source: TileSource): string {
  return `${source.key}:${tile}`
}

function targetCountDistributions(): Map<string, number[]> {
  const target = new Map<string, number[]>()
  for (const source of countSources.value) {
    for (const entry of countSourceTiles.value) {
      target.set(
        countDistributionKey(entry.tile, source),
        countSegments(entry.tile, source).map(segment => segment.probability),
      )
    }
  }
  return target
}

function copyCountDistributions(values: Map<string, number[]>): Map<string, number[]> {
  return new Map([...values].map(([key, probabilities]) => [key, [...probabilities]]))
}

function displayedProbabilities(tile: string, source: TileSource): number[] {
  return displayedCountDistributions.get(countDistributionKey(tile, source))
    ?? countSegments(tile, source).map(segment => segment.probability)
}

function elementHeightPixels(element: Element | null, ratio: number): number {
  return element ? element.getBoundingClientRect().height * ratio : 0
}
function groupedLegendHeightPixels(grid: HTMLElement, ratio: number, rootRem: number, floatingScale: number): number {
  const visibleLegend = grid.querySelector<HTMLElement>('.analysis-count-legends')
  if (visibleLegend) return elementHeightPixels(visibleLegend, ratio)
  const sourceLegend = grid.querySelector<HTMLElement>('.analysis-count-source-legend-group')
  const sampleLabelHeight = elementHeightPixels(sourceLegend?.querySelector('small') || null, ratio)
  const compactSwatchHeight = 0.54 * rootRem * floatingScale * ratio
  const rowHeight = Math.max(sampleLabelHeight, compactSwatchHeight)
  const rowGap = 0.12 * rootRem * floatingScale * ratio
  const rowCount = countSources.value.length + 1
  return (rowHeight * rowCount) + (rowGap * Math.max(0, rowCount - 1))
}
function updateCountBarGeometry() {
  const grid = countGridElement.value
  if (!grid) return
  const gridStyle = getComputedStyle(grid)
  const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const floatingScale = Number.parseFloat(gridStyle.getPropertyValue('--floating-panel-scale')) || 1
  const tileEm = Number.parseFloat(gridStyle.fontSize) || rootRem * floatingScale
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const desiredTilePixels = Math.max(8, Math.round(2.45 * rootRem * floatingScale * ratio))
  const desiredTileHeightPixels = Math.max(1, Math.round(3.18 * rootRem * floatingScale * ratio))
  const sourceCount = Math.max(1, countSources.value.length)
  const spacing = ANALYSIS_COUNT_SPACING[props.countLayout]
  const wallGapPixels = sourceCount > 1 ? spacing.wallGapPixels : 0
  const tileGapPixels = spacing.tileGapPixels
  const gridRect = grid.getBoundingClientRect()
  const longestGroupedRow = Math.max(1, ...countTileRows.value.map((row) => row.tiles.length))
  const groupedTileGapPixels = ANALYSIS_COUNT_SPACING['tile-groups'].tileGapPixels
  const toggleHeightPixels = elementHeightPixels(grid.querySelector('.analysis-count-layout-toggle'), ratio)
  const groupedLegendPixels = groupedLegendHeightPixels(grid, ratio, rootRem, floatingScale)
  const groupedGeometry = groupedCountGeometry({
    availableWidth: gridRect.width,
    availableHeight: gridRect.height,
    pixelRatio: ratio,
    toggleHeight: toggleHeightPixels / ratio,
    legendHeight: groupedLegendPixels / ratio,
    minimumTileWidth: rootRem * floatingScale,
    maximumTileWidth: 3 * tileEm,
    rowCount: countTileRows.value.length,
    longestRow: longestGroupedRow,
    laneCount: sourceCount,
    tileGap: groupedTileGapPixels / ratio,
  })
  const groupedTilePixels = Math.round(groupedGeometry.tileWidth * ratio)
  const groupedTileHeightPixels = Math.round(groupedGeometry.tileHeight * ratio)
  const tilePixels = props.countLayout === 'tile-groups' ? groupedTilePixels : desiredTilePixels
  const tileHeightPixels = props.countLayout === 'tile-groups' ? groupedTileHeightPixels : desiredTileHeightPixels
  grid.style.setProperty('--analysis-tile-width', `${tilePixels / ratio}px`)
  grid.style.setProperty('--analysis-tile-height', `${tileHeightPixels / ratio}px`)
  grid.style.setProperty('--analysis-count-source-gap', '0px')
  grid.style.setProperty('--analysis-count-wall-gap', `${wallGapPixels / ratio}px`)
  grid.style.setProperty('--analysis-count-tile-gap', `${tileGapPixels / ratio}px`)
  grid.style.setProperty('--analysis-count-main-row-width', `${groupedGeometry.mainRowWidth}px`)
  const sourceShell = grid.querySelector<HTMLElement>('.analysis-count-source-sequence-shell')
  let sourceTilePixels = Math.max(4, Math.floor(desiredTilePixels * 0.3))
  if (sourceShell && countSourceTiles.value.length) {
    const availablePixels = Math.max(1, Math.floor(sourceShell.getBoundingClientRect().width * ratio))
    const groupCount = countSourceTiles.value.filter((entry) => entry.groupStart).length
    const groupGapPixels = Math.max(6, tileGapPixels * 2)
    const ordinaryGapPixels = tileGapPixels * Math.max(0, countSourceTiles.value.length - 1)
    const groupedGapPixels = groupGapPixels * groupCount
    sourceTilePixels = Math.max(4, Math.floor((availablePixels - ordinaryGapPixels - groupedGapPixels) / countSourceTiles.value.length))
    const sourceContentPixels = (sourceTilePixels * countSourceTiles.value.length) + ordinaryGapPixels + groupedGapPixels
    grid.style.setProperty('--analysis-count-source-tile-width', `${sourceTilePixels / ratio}px`)
    grid.style.setProperty('--analysis-count-source-group-gap', `${groupGapPixels / ratio}px`)
    grid.style.setProperty('--analysis-count-source-content-width', `${sourceContentPixels / ratio}px`)
  }
  const groupedRowMinimumPixels = groupedGeometry.rowMinimumHeight * ratio
  const groupedBarMinimumPixels = groupedGeometry.barMinimumHeight * ratio
  const groupedGridMinimumPixels = groupedGeometry.gridMinimumHeight * ratio
  const sourceLegendPixels = elementHeightPixels(grid.querySelector('.analysis-count-source-legend'), ratio)
  const sourceTileHeightPixels = sourceTilePixels * COUNT_TILE_ASPECT_RATIO
  const sourceTileInnerGapPixels = ratio
  const sourceRowMinimumPixels = groupedBarMinimumPixels + sourceTileInnerGapPixels + sourceTileHeightPixels
  const sourceGridGapPixels = desiredTilePixels * COUNT_GRID_GAP_RATIO
  const sourceRowGapPixels = desiredTilePixels * COUNT_SOURCE_ROW_GAP_RATIO
  const sourceGridMinimumPixels = toggleHeightPixels + sourceLegendPixels + (sourceGridGapPixels * 2)
    + (sourceRowMinimumPixels * sourceCount) + (sourceRowGapPixels * Math.max(0, sourceCount - 1))
  grid.style.setProperty('--analysis-count-row-min-height', `${groupedRowMinimumPixels / ratio}px`)
  grid.style.setProperty('--analysis-count-bar-min-height', `${groupedBarMinimumPixels / ratio}px`)
  grid.style.setProperty('--analysis-count-source-row-min-height', `${sourceRowMinimumPixels / ratio}px`)
  grid.style.setProperty('--analysis-count-grid-min-height', `${(props.countLayout === 'tile-groups' ? groupedGridMinimumPixels : sourceGridMinimumPixels) / ratio}px`)
  updateCountPaletteVariables(grid)
}
function updateCountPaletteVariables(grid: HTMLElement) {
  const style = getComputedStyle(grid)
  for (const source of countSources.value) {
    countSourcePalette(source.key, style).forEach((color, value) => grid.style.setProperty(countPaletteVariable(source.key, value), color))
  }
}
function prepareCountCanvas(canvas: CountCanvasElement) {
  const rect = canvas.getBoundingClientRect()
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(rect.width * ratio))
  const height = Math.max(1, Math.round(rect.height * ratio))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.clearRect(0, 0, width, height)
  return { context, rect, ratio, width, height }
}

function renderCountCanvas(row: readonly string[], canvas: CountCanvasElement) {
  const prepared = prepareCountCanvas(canvas)
  if (!prepared) return
  const { context, ratio, height } = prepared
  const sources = countSources.value
  if (!sources.length || !row.length) return
  const style = getComputedStyle(canvas)
  const tileGap = Math.max(0, Math.round(Number.parseFloat(style.getPropertyValue('--analysis-count-tile-gap')) * ratio))
  const tileWidth = Math.max(sources.length, Math.round(Number.parseFloat(style.getPropertyValue('--analysis-tile-width')) * ratio))
  const wallGap = sources.length > 1 ? Math.max(0, Math.round(Number.parseFloat(style.getPropertyValue('--analysis-count-wall-gap')) * ratio)) : 0
  const sourceWidth = Math.max(sources.length, tileWidth - wallGap)
  const palettes = sources.map((source) => countSourcePalette(source.key, style))
  for (let tileIndex = 0; tileIndex < row.length; tileIndex += 1) {
    const tile = row[tileIndex]
    const blockLeft = tileIndex * (tileWidth + tileGap)
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      const sourceLeft = Math.round((sourceIndex * sourceWidth) / sources.length)
      const sourceRight = Math.round(((sourceIndex + 1) * sourceWidth) / sources.length)
      const left = blockLeft + sourceLeft + (sourceIndex === sources.length - 1 ? wallGap : 0)
      const laneWidth = Math.max(1, sourceRight - sourceLeft)
      const probabilities = displayedProbabilities(tile, sources[sourceIndex])
      const total = probabilities.reduce((sum, probability) => sum + probability, 0)
      let cumulative = 0
      for (let segmentIndex = 0; segmentIndex < probabilities.length; segmentIndex += 1) {
        const top = Math.round(cumulative * height)
        cumulative += probabilities[segmentIndex]
        const bottom = segmentIndex === probabilities.length - 1 && total > 0
          ? height
          : Math.round(cumulative * height)
        if (bottom <= top) continue
        context.fillStyle = palettes[sourceIndex][segmentIndex]
        context.fillRect(left, top, laneWidth, bottom - top)
      }
    }
  }
  canvas.rmsCountRenderSignature = row.flatMap(tile => sources.flatMap(source => (
    displayedProbabilities(tile, source).map(value => Math.round(value * 10000))
  ))).join(',')
}

function renderSourceCanvas(canvas: CountCanvasElement, source: TileSource) {
  const prepared = prepareCountCanvas(canvas)
  if (!prepared) return
  const { context, rect, ratio, width, height } = prepared
  const sequence = canvas.parentElement
  if (!sequence) return
  const tracks = sequence.querySelectorAll<HTMLElement>('.analysis-count-source-bar')
  const style = getComputedStyle(canvas)
  const palette = countSourcePalette(source.key, style)
  tracks.forEach((track, tileIndex) => {
    const entry = countSourceTiles.value[tileIndex]
    if (!entry) return
    const trackRect = track.getBoundingClientRect()
    const left = Math.max(0, Math.round((trackRect.left - rect.left) * ratio))
    const right = Math.min(width, Math.round((trackRect.right - rect.left) * ratio))
    const top = Math.max(0, Math.round((trackRect.top - rect.top) * ratio))
    const bottom = Math.min(height, Math.round((trackRect.bottom - rect.top) * ratio))
    if (right <= left || bottom <= top) return
    context.fillStyle = 'rgba(255, 255, 255, 0.04)'
    context.fillRect(left, top, right - left, bottom - top)
    const probabilities = displayedProbabilities(entry.tile, source)
    const total = probabilities.reduce((sum, probability) => sum + probability, 0)
    let cumulative = 0
    probabilities.forEach((probability, segmentIndex) => {
      const segmentTop = top + Math.round(cumulative * (bottom - top))
      cumulative += probability
      const segmentBottom = segmentIndex === probabilities.length - 1 && total > 0
        ? bottom
        : top + Math.round(cumulative * (bottom - top))
      if (segmentBottom <= segmentTop) return
      context.fillStyle = palette[segmentIndex]
      context.fillRect(left, segmentTop, right - left, segmentBottom - segmentTop)
    })
  })
  canvas.rmsCountRenderSignature = countSourceTiles.value.flatMap(entry => (
    displayedProbabilities(entry.tile, source).map(value => Math.round(value * 10000))
  )).join(',')
}
function renderCountCanvases() {
  for (const { canvas, row } of countCanvasElements.values()) renderCountCanvas(row, canvas)
  for (const { canvas, source } of sourceCanvasElements.values()) renderSourceCanvas(canvas, source)
}
const scheduleCountBarGeometry = useResponsiveGeometry(countGridElement, () => {
  updateCountBarGeometry()
  renderCountCanvases()
}, { resizeAncestorSelector: '.analysis-tiles-view', styleAncestorSelector: '.dock-module' })
function setCountCanvasElement(key: string, row: readonly string[], element: unknown) {
  if (!(element instanceof HTMLCanvasElement)) countCanvasElements.delete(key)
  else countCanvasElements.set(key, { canvas: element as CountCanvasElement, row })
  scheduleCountBarGeometry()
}

function setSourceCanvasElement(key: string, source: TileSource, element: unknown) {
  if (!(element instanceof HTMLCanvasElement)) sourceCanvasElements.delete(key)
  else sourceCanvasElements.set(key, { canvas: element as CountCanvasElement, source })
  scheduleCountBarGeometry()
}

function stopCountAnimation() {
  if (countAnimationFrame) cancelAnimationFrame(countAnimationFrame)
  countAnimationFrame = 0
}

function animateCountCanvases() {
  stopCountAnimation()
  const target = targetCountDistributions()
  if (!displayedCountDistributions.size || props.reduceMotion) {
    displayedCountDistributions = copyCountDistributions(target)
    renderCountCanvases()
    return
  }
  const source = copyCountDistributions(displayedCountDistributions)
  const duration = getUiMotionDurationMs()
  const easing = getUiMotionEasingFunction()
  let startedAt: number | null = null
  const step = (now: number) => {
    if (startedAt === null) startedAt = now
    const progress = Math.max(0, Math.min(1, (now - startedAt) / duration))
    const eased = easing(progress)
    displayedCountDistributions = new Map([...target].map(([key, probabilities]) => {
      const previous = source.get(key) || probabilities
      return [key, probabilities.map((value, index) => (
        (previous[index] ?? value) + ((value - (previous[index] ?? value)) * eased)
      ))]
    }))
    renderCountCanvases()
    if (progress < 1) countAnimationFrame = requestAnimationFrame(step)
    else countAnimationFrame = 0
  }
  countAnimationFrame = requestAnimationFrame(step)
}

const countHoverTooltip = computed(() => {
  const target = countHoverTarget.value
  const grid = countGridElement.value
  if (!target || !grid) return null
  const source = countSources.value.find((candidate) => candidate.key === target.sourceKey)
  if (!source) return null
  return {
    anchor: target.anchor,
    sourceLabel: source.label,
    tileImage: props.tileImageSrc(target.tile),
    tileLabel: props.tileFaceLabel(target.tile),
    redFive: isRedFiveTile(target.tile),
    prediction: tilePrediction(target.tile, source),
    palette: countSourcePalette(source.key, getComputedStyle(grid)),
  }
})
function clearCountTooltip() { countHoverTarget.value = null }
function showCountTooltip(event: Event, tile: string, source: TileSource) {
  const anchor = event.currentTarget
  if (!(anchor instanceof Element) || !countGridElement.value) return
  countHoverTarget.value = {
    anchor,
    tile,
    sourceKey: source.key,
    contextKey: countTooltipContextKey(),
    controlledSeat: props.controlledSeat,
  }
}
watch(() => [props.analysis, props.controlledSeat, props.reduceMotion], () => {
  const target = countHoverTarget.value
  if (target && (
    !target.anchor.isConnected
    || target.contextKey !== countTooltipContextKey()
    || target.controlledSeat !== props.controlledSeat
    || !countHoverTooltip.value
    || !hasCountPrediction(countHoverTooltip.value.prediction)
  )) clearCountTooltip()
  void nextTick(() => {
    scheduleCountBarGeometry()
    animateCountCanvases()
  })
}, { flush: 'post', immediate: true })
watch(() => props.countLayout, () => {
  clearCountTooltip()
  void nextTick(() => {
    scheduleCountBarGeometry()
    renderCountCanvases()
  })
})
onBeforeUnmount(() => {
  stopCountAnimation()
  countCanvasElements.clear()
  sourceCanvasElements.clear()
})
</script>

<style scoped src="./TileCountAnalysisSection.css"></style>
