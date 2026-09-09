<template>
  <div class="analysis-tiles-view">
    <div ref="riskGridElement" v-perceptual-surface="riskTrackSurface" class="analysis-risk-grid">
      <div v-for="row in tileRows" :key="row[0]" class="analysis-tile-chart-row analysis-risk-row">
        <div class="analysis-tile-sequence">
          <div v-for="(tile, tileIndex) in row" :key="tile" class="analysis-risk-tile">
            <img class="mahjong-tile-artwork analysis-tile-face" :src="tileImageSrc(tile)" :alt="tileFaceLabel(tile)" />
            <div
              class="analysis-risk-bars"
              :class="{ 'has-adaptive-threshold': showRiskAdaptiveThreshold }"
              :style="{ '--analysis-risk-threshold': riskScalePosition(RISK_ADAPTIVE_MIN) }"
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
              ><span :style="{ transform: `scaleY(${riskBarScale(riskProbability(source.seat, tile))})` }" /></i>
            </div>
            <span
              v-if="tileIndex < row.length - 1"
              class="analysis-risk-bridge"
              :class="{ 'has-adaptive-threshold': showRiskAdaptiveThreshold }"
              :style="{ '--analysis-risk-threshold': riskScalePosition(RISK_ADAPTIVE_MIN) }"
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
import { ref } from 'vue'
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

const props = defineProps<AnalysisPanelDataProps & {
  tileImageSrc: (tile: string) => string
  tileFaceLabel: (tile: string) => string
  perceptualSurface: PerceptualSurfaceBinding
}>()
const tooltip = useAnalysisHoverTooltipController()
const { formatProbability } = useAnalysisPanelFormatting()
const tileRows = ANALYSIS_TILE_ROWS
const riskGridElement = ref<HTMLElement | null>(null)
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
}

useResponsiveGeometry(riskGridElement, updateRiskGeometry, {
  resizeAncestorSelector: '.analysis-tiles-view',
  styleAncestorSelector: '.dock-module',
})

function showProbabilityTooltip(event: Event, title: string, label: string, value: number) {
  tooltip.show(event, { title, lines: [], rows: [{ label, value: formatProbability(value) }] })
}
</script>

<style scoped src="./DealInRiskSection.css"></style>
