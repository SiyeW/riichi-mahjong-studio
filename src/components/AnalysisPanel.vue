<template>
  <div
    ref="analysisRootElement"
    class="unified-analysis"
    :class="{
      'is-opponent-section': section === 'opponents',
      'reduce-motion': reduceMotion,
      'is-risk-section': section === 'risk',
      'is-count-section': section === 'counts',
    }"
  >
    <section
      v-if="section === 'opponents'"
      v-perceptual-surface="opponentSurface"
      class="analysis-opponent-section"
    >
        <div class="analysis-opponent-grid">
          <div v-for="opponent in opponentCards" :key="opponent.key" class="analysis-opponent-card">
            <ShantenPieChart
              :label="opponent.label"
              :probabilities="opponent.probabilities"
              :colors="shantenColors"
              :slice-labels="shantenLabels"
              :short-labels="shantenShortLabels"
              :reduce-motion="reduceMotion"
              @slice-enter="(event, label, probability) => showProbabilityTooltip(event, opponent.label, label, probability)"
              @slice-leave="clearHoverTooltip"
            />
          </div>
        </div>
        <div class="analysis-shanten-legend" :aria-label="t('analysis.shantenLegend')">
          <span v-for="(label, index) in shantenLabels" :key="label">
            <i :style="{ backgroundColor: shantenColors[index] }" />{{ label }}
          </span>
        </div>
        <div
          class="analysis-opponent-prediction-grid"
          :class="{
            'has-dora-distributions': hasOpponentDoraDistributions,
            'has-score-distributions': hasOpponentScoreDistributions,
          }"
        >
          <div v-for="opponent in opponentCards" :key="opponent.key" class="analysis-opponent-predictions">
              <div
                class="analysis-opponent-prediction is-dora-prediction"
                tabindex="0"
                @mouseenter="showPredictionTooltip($event, opponent.label, t('analysis.dora'), opponent.doraPrediction, t('unit.tile'))"
                @mouseleave="clearHoverTooltip"
                @focus="showPredictionTooltip($event, opponent.label, t('analysis.dora'), opponent.doraPrediction, t('unit.tile'))"
                @blur="clearHoverTooltip"
              >
                <div class="analysis-prediction-heading">
                  <small>{{ t('analysis.dora') }}</small>
                  <strong>{{ opponent.dora }}</strong>
                </div>
                <div
                  v-if="opponent.doraPrediction.distribution.length"
                  v-perceptual-surface="distributionTrackSurface"
                  class="analysis-dora-distribution"
                >
                  <span
                    v-for="entry in opponent.doraPrediction.distribution"
                    :key="entry.value"
                    tabindex="0"
                    @mouseenter="showProbabilityTooltip($event, `${opponent.label} · ${t('analysis.dora')}`, `${entry.value}${t('unit.tile')}`, entry.probability)"
                    @mouseleave="clearHoverTooltip"
                    @focus="showProbabilityTooltip($event, `${opponent.label} · ${t('analysis.dora')}`, `${entry.value}${t('unit.tile')}`, entry.probability)"
                    @blur="clearHoverTooltip"
                  >
                    <i><em :style="{ height: distributionBarHeight(entry.probability, doraDistributionScale) }" /></i>
                    <small>{{ entry.value }}</small>
                  </span>
                </div>
              </div>
              <div
                class="analysis-opponent-prediction is-score-prediction"
                tabindex="0"
                @mouseenter="showPredictionTooltip($event, opponent.label, t('analysis.score'), opponent.scorePrediction, t('unit.point'))"
                @mouseleave="clearHoverTooltip"
                @focus="showPredictionTooltip($event, opponent.label, t('analysis.score'), opponent.scorePrediction, t('unit.point'))"
                @blur="clearHoverTooltip"
              >
                <div class="analysis-prediction-heading">
                  <small>{{ t('analysis.score') }}</small>
                  <strong>{{ opponent.score }}</strong>
                </div>
                <div
                  v-if="opponent.scorePrediction.distribution.length"
                  v-perceptual-surface="distributionTrackSurface"
                  class="analysis-score-distribution"
                >
                  <i
                    v-for="entry in opponent.scorePrediction.distribution"
                    :key="entry.value"
                    tabindex="0"
                    @mouseenter="showProbabilityTooltip($event, `${opponent.label} · ${t('analysis.score')}`, formatDistributionPoints(entry.value), entry.probability)"
                    @mouseleave="clearHoverTooltip"
                    @focus="showProbabilityTooltip($event, `${opponent.label} · ${t('analysis.score')}`, formatDistributionPoints(entry.value), entry.probability)"
                    @blur="clearHoverTooltip"
                  ><span :style="{ height: distributionBarHeight(entry.probability, scoreDistributionScale) }" /></i>
                </div>
                <div v-if="opponent.scoreModes.length" class="analysis-score-modes">
                  <span
                    v-for="entry in opponent.scoreModes"
                    :key="entry.value"
                    tabindex="0"
                    @mouseenter="showProbabilityTooltip($event, `${opponent.label} · ${t('analysis.score')}`, formatDistributionPoints(entry.value), entry.probability)"
                    @mouseleave="clearHoverTooltip"
                    @focus="showProbabilityTooltip($event, `${opponent.label} · ${t('analysis.score')}`, formatDistributionPoints(entry.value), entry.probability)"
                    @blur="clearHoverTooltip"
                  >
                    {{ formatDistributionPoints(entry.value) }}
                  </span>
                </div>
              </div>
          </div>
        </div>
    </section>

    <section v-else-if="section === 'game'" class="analysis-player-section">
        <div class="analysis-player-groups">
          <section
            v-perceptual-surface="offenseGroupSurface"
            class="analysis-player-group analysis-offense-group"
          >
            <div class="analysis-player-group-heading">
              <strong>{{ t('analysis.winDealIn') }}</strong>
            </div>
            <div class="analysis-outcome-strip" :aria-label="t('analysis.outcome')">
              <div v-perceptual-surface="outcomeTrackSurface" class="analysis-outcome-bar">
                <span
                  v-for="segment in outcomeSegments"
                  :key="segment.key"
                  :class="`is-${segment.key}`"
                  :style="{ width: `${segment.displayProbability * 100}%` }"
                  tabindex="0"
                  @mouseenter="showProbabilityTooltip($event, t('analysis.outcome'), segment.label, segment.probability)"
                  @mouseleave="clearHoverTooltip"
                  @focus="showProbabilityTooltip($event, t('analysis.outcome'), segment.label, segment.probability)"
                  @blur="clearHoverTooltip"
                ><small v-if="segment.displayProbability >= 0.08">{{ formatProbability(segment.probability) }}</small></span>
              </div>
              <div class="analysis-outcome-legend">
                <span v-for="segment in outcomeSegments" :key="segment.key">
                  <i :class="`is-${segment.key}`" />{{ segment.label }}
                </span>
              </div>
            </div>
            <div class="analysis-offense-axis-heading" aria-hidden="true">
              <span />
              <div class="analysis-offense-headings" aria-hidden="true">
                <span>{{ t('analysis.dealInProbability') }} →</span>
                <span>← {{ t('analysis.winProbability') }}</span>
              </div>
            </div>
            <div
              v-for="player in playerRows"
              :key="player.seat"
              class="analysis-comparison-row analysis-offense-row"
            >
              <span class="analysis-player-name">{{ player.label }}</span>
              <div
                :ref="(element) => setOffenseTrackElement(player.seat, element)"
                v-perceptual-surface="offenseTrackSurface"
                class="analysis-offense-track"
                :class="{ 'labels-measured': offenseLabelPositions.has(player.seat) }"
              >
                <div
                  class="analysis-offense-segment is-win"
                  tabindex="0"
                  :style="{ width: `${player.winProbability * 100}%` }"
                  @mouseenter="showWinTooltip($event, player)"
                  @mouseleave="clearHoverTooltip"
                  @focus="showWinTooltip($event, player)"
                  @blur="clearHoverTooltip"
                >
                </div>
                <div
                  class="analysis-offense-segment is-deal-in"
                  tabindex="0"
                  :style="{ width: `${player.dealInProbability * 100}%` }"
                  @mouseenter="showDealInTooltip($event, player)"
                  @mouseleave="clearHoverTooltip"
                  @focus="showDealInTooltip($event, player)"
                  @blur="clearHoverTooltip"
                >
                </div>
                <small
                  class="analysis-offense-value is-win"
                  :style="offenseLabelStyle(player.seat, 'win')"
                >{{ formatProbability(player.winProbability) }}</small>
                <small
                  class="analysis-offense-value is-deal-in"
                  :style="offenseLabelStyle(player.seat, 'dealIn')"
                >{{ formatProbability(player.dealInProbability) }}</small>
              </div>
            </div>
          </section>

          <section
            v-perceptual-surface="deltaGroupSurface"
            class="analysis-player-group analysis-delta-group"
          >
            <div class="analysis-player-group-heading">
              <strong>{{ t('analysis.kyokuDelta') }}</strong>
            </div>
            <div
              v-for="player in playerRows"
              :key="player.seat"
              class="analysis-comparison-row analysis-delta-row"
            >
              <span class="analysis-player-name">{{ player.label }}</span>
              <div
                v-perceptual-surface="deltaTrackSurface"
                class="analysis-delta-cell"
                tabindex="0"
                @mouseenter="showValueTooltip($event, player.label, t('analysis.kyokuDelta'), formatPoints(player.kyokuDelta))"
                @mouseleave="clearHoverTooltip"
                @focus="showValueTooltip($event, player.label, t('analysis.kyokuDelta'), formatPoints(player.kyokuDelta))"
                @blur="clearHoverTooltip"
              >
                <div class="analysis-zero-axis" />
                <span
                  :class="(player.kyokuDelta ?? 0) >= 0 ? 'positive' : 'negative'"
                  :style="deltaBarStyle(player.kyokuDelta)"
                />
                <small
                  class="analysis-delta-value"
                  :class="(player.kyokuDelta ?? 0) >= 0 ? 'opposite-positive' : 'opposite-negative'"
                >{{ formatSignedCompactPoints(player.kyokuDelta) }}</small>
              </div>
            </div>
          </section>

          <section
            v-perceptual-surface="matchGroupSurface"
            class="analysis-player-group analysis-match-group"
          >
            <div class="analysis-player-group-heading analysis-match-heading">
              <strong>{{ t('analysis.matchProjection') }}</strong>
              <span>{{ t('analysis.matchPlacement') }}</span>
              <span>{{ t('analysis.matchScore') }}</span>
            </div>
            <div
              v-for="player in playerRows"
              :key="player.seat"
              class="analysis-comparison-row analysis-match-row"
            >
              <span class="analysis-player-name">{{ player.label }}</span>
              <div
                v-perceptual-surface="placementTrackSurface"
                class="analysis-placement-bar"
                tabindex="0"
                @mouseenter="showDistributionTooltip($event, player.label, t('analysis.matchPlacement'), player.placement, t('unit.place'))"
                @mouseleave="clearHoverTooltip"
                @focus="showDistributionTooltip($event, player.label, t('analysis.matchPlacement'), player.placement, t('unit.place'))"
                @blur="clearHoverTooltip"
              >
                <span
                  v-for="segment in player.placement"
                  :key="segment.value"
                  :class="`rank-${segment.value}`"
                  :style="{ width: `${segment.probability * 100}%` }"
                />
              </div>
              <small class="analysis-placement-value">{{ player.expectedPlacement }}</small>
              <span
                class="analysis-score-cell"
                tabindex="0"
                @mouseenter="showValueTooltip($event, player.label, t('analysis.matchScore'), formatPoints(player.matchScore))"
                @mouseleave="clearHoverTooltip"
                @focus="showValueTooltip($event, player.label, t('analysis.matchScore'), formatPoints(player.matchScore))"
                @blur="clearHoverTooltip"
              >{{ formatPlainPoints(player.matchScore) }}</span>
            </div>
          </section>
        </div>
    </section>

    <div v-else-if="section === 'risk'" class="analysis-tiles-view">
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
                  @mouseleave="clearHoverTooltip"
                  @focus="showProbabilityTooltip($event, tileFaceLabel(tile), source.label, riskProbability(source.seat, tile))"
                  @blur="clearHoverTooltip"
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
            <span
              v-for="tick in riskScaleTicks"
              :key="tick.value"
              :style="{ top: riskScalePosition(tick.value) }"
            ><i /><small>{{ tick.label }}</small></span>
          </div>
        </div>
        <div v-perceptual-surface="riskLegendSurface" class="analysis-source-legend">
          <span v-for="source in opponentSources" :key="source.key"><i :class="`source-${source.key}`" />{{ source.label }}</span>
        </div>
      </div>

    </div>

    <div v-else class="analysis-tiles-view">
      <div
        ref="countGridElement"
        v-perceptual-surface="countSurface"
        class="analysis-count-grid"
        :class="{ 'is-source-row-layout': countLayout === 'source-rows' }"
        @perceptual-surface-change="scheduleCountBarGeometry"
      >
        <div class="analysis-count-layout-toggle" role="group" :aria-label="t('analysis.countLayout')">
          <button
            type="button"
            :class="{ active: countLayout === 'source-rows' }"
            @click="emit('update:countLayout', 'source-rows')"
          >{{ t('analysis.countLayoutSources') }}</button>
          <button
            type="button"
            :class="{ active: countLayout === 'tile-groups' }"
            @click="emit('update:countLayout', 'tile-groups')"
          >{{ t('analysis.countLayoutTiles') }}</button>
        </div>
        <template v-if="countLayout === 'tile-groups'">
          <div
            v-for="(row, rowIndex) in countTileRows"
            :key="row.tiles.join('-')"
            class="analysis-tile-chart-row analysis-count-row"
            :class="{ 'is-final-row': rowIndex === countTileRows.length - 1 }"
          >
            <div class="analysis-tile-sequence">
              <canvas
                :ref="(element) => setCountCanvasElement(row.key, row.tiles, element)"
                class="analysis-count-row-canvas"
                aria-hidden="true"
              />
              <div
                v-for="tile in row.tiles"
                :key="tile"
                class="analysis-count-tile"
                :class="{ 'is-red-five': isRedFiveTile(tile) }"
              >
                <div class="analysis-count-bars">
                  <button
                    v-for="source in countSources"
                    :key="source.key"
                    type="button"
                    :class="`source-${source.key}`"
                    :aria-label="t('analysis.tileCountDistribution', { source: source.label, tile: tileFaceLabel(tile) })"
                    @mouseenter="showCountTooltip($event, tile, source)"
                    @mouseleave="clearHoverTooltip"
                    @focus="showCountTooltip($event, tile, source)"
                    @blur="clearHoverTooltip"
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
                  <i
                    v-for="value in [0, 1, 2, 3, 4]"
                    :key="`${source.key}-${value}`"
                    :style="{ background: countSegmentColor(source.key, value) }"
                  />
                </template>
              </div>
            </div>
          </div>
        </template>
        <div v-else class="analysis-count-source-layout">
          <div v-for="source in countSources" :key="source.key" class="analysis-count-source-row">
            <div class="analysis-count-source-sequence-shell">
              <div class="analysis-count-source-sequence">
                <button
                  v-for="entry in countSourceTiles"
                  :key="entry.tile"
                  type="button"
                  class="analysis-count-source-tile"
                  :class="{ 'is-group-start': entry.groupStart, 'is-red-five': isRedFiveTile(entry.tile) }"
                  :aria-label="t('analysis.tileCountDistribution', { source: source.label, tile: tileFaceLabel(entry.tile) })"
                  @mouseenter="showCountTooltip($event, entry.tile, source)"
                  @mouseleave="clearHoverTooltip"
                  @focus="showCountTooltip($event, entry.tile, source)"
                  @blur="clearHoverTooltip"
                >
                  <span class="analysis-count-source-bar">
                    <i
                      v-for="segment in countSegments(entry.tile, source)"
                      :key="segment.value"
                      :style="{
                        height: `${segment.probability * 100}%`,
                        background: countSegmentColor(source.key, segment.value),
                      }"
                    />
                  </span>
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
            <i
              v-for="value in [0, 1, 2, 3, 4]"
              :key="`${source.key}-${value}`"
              :style="{ background: countSegmentColor(source.key, value) }"
            />
          </div>
        </div>
      </div>
    </div>

    <CountPredictionTooltip
      v-if="countHoverTooltip"
      v-bind="countHoverTooltip"
      @close="clearHoverTooltip"
    />
    <div
      v-if="hoverTooltip"
      ref="hoverTooltipElement"
      class="ui-hover-tooltip analysis-floating-tooltip"
      :class="{ 'is-positioned': hoverTooltip.positioned }"
      :style="{ left: `${hoverTooltip.left}px`, top: `${hoverTooltip.top}px` }"
      role="tooltip"
    >
      <strong>{{ hoverTooltip.title }}</strong>
      <span v-for="line in hoverTooltip.lines" :key="line" class="analysis-floating-tooltip-line">{{ line }}</span>
      <div
        v-for="row in hoverTooltip.rows"
        :key="`${row.label}-${row.value}`"
        class="ui-hover-tooltip-row"
        :class="{ 'has-bar': row.barWidth }"
      >
        <span>{{ row.label }}</span>
        <i v-if="row.barWidth" class="analysis-tooltip-bar">
          <span :style="{ width: row.barWidth, background: row.barColor }" />
        </i>
        <span>{{ row.value }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useOffenseLabels } from '../useOffenseLabels'
import { deltaHalfWidthPercent } from '../analysisDeltaScale'
import { useAnalysisPanelData, type TileSource, type AnalysisPanelDataProps } from '../useAnalysisPanelData'
import type { AnalysisRecord } from '../useAnalysisOutputs'
import { useI18n } from '../i18n'
import {
  ANALYSIS_COUNT_SPACING,
  type AnalysisCountLayout,
} from '../analysisCountSpacing'
import { groupedCountGeometry } from '../analysisCountGeometry'
import { analysisRiskGeometry } from '../analysisRiskGeometry'
import {
  COUNT_EMPTY_COLOR,
  countPaletteVariable,
  countSegmentColor,
  countSourcePalette,
} from '../analysisCountPalette'
import { DEFAULT_PROBABILITY_SCALE as RISK_ADAPTIVE_MIN } from '../analysisProbabilityScale'
import {
  ANALYSIS_TILE_ROWS,
  isRedFiveTile,
} from '../analysisTiles'
import {
  type DistributionEntry,
  type NumericPrediction,
} from '../numericPrediction'
import { vPerceptualSurface, type PerceptualSurfaceBinding } from '../perceptualSurface'
import { useResponsiveGeometry } from '../useResponsiveGeometry'
import ShantenPieChart from './ShantenPieChart.vue'
import CountPredictionTooltip from './CountPredictionTooltip.vue'

const { t, numberLocale } = useI18n()

const emit = defineEmits<{
  'update:countLayout': [value: AnalysisCountLayout]
}>()

type HoverTooltipRow = {
  label: string
  value: string
  barWidth?: string
  barColor?: string
}
type HoverTooltipState = {
  title: string
  lines: string[]
  rows: HoverTooltipRow[]
  left: number
  top: number
  positioned: boolean
}

const props = defineProps<{
  section: 'opponents' | 'game' | 'risk' | 'counts'
  analysis: AnalysisRecord | null | undefined
  shantenOpponents: AnalysisPanelDataProps['shantenOpponents']
  shantenColors: string[]
  shantenLabels: string[]
  shantenShortLabels: string[]
  reduceMotion: boolean
  controlledSeat: number
  dealer: number
  tileImageSrc: (tile: string) => string
  tileFaceLabel: (tile: string) => string
  perceptualSurface: PerceptualSurfaceBinding
  countLayout: AnalysisCountLayout
}>()

function scopedPerceptualSurface(
  debugLabel: string,
  surfaceLayerVariables: readonly string[] = [],
) {
  return computed<PerceptualSurfaceBinding>(() => ({
    ...props.perceptualSurface,
    debugLabel,
    surfaceLayerVariables,
  }))
}

const opponentSurface = scopedPerceptualSurface('opponent-panel')
const distributionTrackSurface = scopedPerceptualSurface(
  'opponent-distribution-track',
  ['--analysis-distribution-track-surface'],
)
const offenseGroupSurface = scopedPerceptualSurface('game-offense-group')
const outcomeTrackSurface = scopedPerceptualSurface('game-outcome-track')
const offenseTrackSurface = scopedPerceptualSurface('game-offense-track')
const deltaGroupSurface = scopedPerceptualSurface('game-delta-group')
const deltaTrackSurface = scopedPerceptualSurface('game-delta-track')
const matchGroupSurface = scopedPerceptualSurface('game-match-group')
const placementTrackSurface = scopedPerceptualSurface('game-placement-track')
const riskTrackSurface = scopedPerceptualSurface(
  'analysis-risk-track',
  ['--analysis-risk-track-surface'],
)
const riskLegendSurface = scopedPerceptualSurface('analysis-risk-legend')
const countSurface = computed<PerceptualSurfaceBinding>(() => ({
  ...props.perceptualSurface,
  debugLabel: 'analysis-count-panel',
  surfaceOverride: COUNT_EMPTY_COLOR,
}))

const analysisRootElement = ref<HTMLElement | null>(null)
const hoverTooltipElement = ref<HTMLElement | null>(null)
const hoverTooltip = ref<HoverTooltipState | null>(null)
const countHoverTarget = ref<{
  anchor: Element
  tile: string
  sourceKey: string
  contextKey: string
  controlledSeat: number
} | null>(null)
let hoverTooltipPositionFrame = 0
const riskGridElement = ref<HTMLElement | null>(null)
const countGridElement = ref<HTMLElement | null>(null)
const countCanvasElements = new Map<string, { canvas: HTMLCanvasElement; row: readonly string[] }>()
const tileRows = ANALYSIS_TILE_ROWS

const {
  countTileRows,
  countSourceTiles,
  opponentCards,
  hasOpponentDoraDistributions,
  hasOpponentScoreDistributions,
  doraDistributionScale,
  scoreDistributionScale,
  distributionBarHeight,
  outcomeSegments,
  playerRows,
  maxAbsoluteDelta,
  opponentSources,
  countSources,
  riskProbability,
  riskScale,
  showRiskAdaptiveThreshold,
  riskScaleTicks,
  riskBarScale,
  riskScalePosition,
  tilePrediction,
  countSegments,
  countTooltipContextKey,
  hasCountPrediction,
  formatCompactPoints,
  formatPoints,
  formatPlainPoints,
  formatSignedCompactPoints,
  formatDistributionPoints,
  formatProbability,
  windLabel,
} = useAnalysisPanelData(props, { t, numberLocale })

function deltaBarStyle(value: number | null) {
  const width = `${deltaHalfWidthPercent(value, maxAbsoluteDelta.value)}%`
  return value !== null && value < 0
    ? { right: '50%', width }
    : { left: '50%', width }
}

const { offenseLabelPositions, offenseLabelStyle, setOffenseTrackElement } = useOffenseLabels(() => playerRows.value, props.section === 'game')

const COUNT_TILE_ASPECT_RATIO = 3.18 / 2.45
const COUNT_GRID_GAP_RATIO = 0.1
const COUNT_SOURCE_ROW_GAP_RATIO = 0.12

function elementHeightPixels(element: Element | null, ratio: number): number {
  return element ? element.getBoundingClientRect().height * ratio : 0
}

function groupedLegendHeightPixels(
  grid: HTMLElement,
  ratio: number,
  rootRem: number,
  floatingScale: number,
): number {
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

useResponsiveGeometry(
  riskGridElement,
  updateRiskGeometry,
  {
    resizeAncestorSelector: '.analysis-tiles-view',
    styleAncestorSelector: '.dock-module',
  },
)

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
  const toggleHeightPixels = elementHeightPixels(
    grid.querySelector('.analysis-count-layout-toggle'),
    ratio,
  )
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
  const tileHeightPixels = props.countLayout === 'tile-groups'
    ? groupedTileHeightPixels
    : desiredTileHeightPixels
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
    sourceTilePixels = Math.max(
      4,
      Math.floor((availablePixels - ordinaryGapPixels - groupedGapPixels) / countSourceTiles.value.length),
    )
    const sourceContentPixels =
      (sourceTilePixels * countSourceTiles.value.length)
      + ordinaryGapPixels
      + groupedGapPixels
    grid.style.setProperty('--analysis-count-source-tile-width', `${sourceTilePixels / ratio}px`)
    grid.style.setProperty('--analysis-count-source-group-gap', `${groupGapPixels / ratio}px`)
    grid.style.setProperty('--analysis-count-source-content-width', `${sourceContentPixels / ratio}px`)
  }

  const groupedRowMinimumPixels = groupedGeometry.rowMinimumHeight * ratio
  const groupedBarMinimumPixels = groupedGeometry.barMinimumHeight * ratio
  const groupedGridMinimumPixels = groupedGeometry.gridMinimumHeight * ratio

  const sourceLegendPixels = elementHeightPixels(
    grid.querySelector('.analysis-count-source-legend'),
    ratio,
  )
  const sourceTileHeightPixels = sourceTilePixels * COUNT_TILE_ASPECT_RATIO
  const sourceTileInnerGapPixels = ratio
  const sourceRowMinimumPixels =
    groupedBarMinimumPixels + sourceTileInnerGapPixels + sourceTileHeightPixels
  const sourceGridGapPixels = desiredTilePixels * COUNT_GRID_GAP_RATIO
  const sourceRowGapPixels = desiredTilePixels * COUNT_SOURCE_ROW_GAP_RATIO
  const sourceGridMinimumPixels =
    toggleHeightPixels
    + sourceLegendPixels
    + (sourceGridGapPixels * 2)
    + (sourceRowMinimumPixels * sourceCount)
    + (sourceRowGapPixels * Math.max(0, sourceCount - 1))

  grid.style.setProperty('--analysis-count-row-min-height', `${groupedRowMinimumPixels / ratio}px`)
  grid.style.setProperty('--analysis-count-bar-min-height', `${groupedBarMinimumPixels / ratio}px`)
  grid.style.setProperty('--analysis-count-source-row-min-height', `${sourceRowMinimumPixels / ratio}px`)
  grid.style.setProperty(
    '--analysis-count-grid-min-height',
    `${(props.countLayout === 'tile-groups' ? groupedGridMinimumPixels : sourceGridMinimumPixels) / ratio}px`,
  )
  updateCountPaletteVariables(grid)
}

function updateCountPaletteVariables(grid: HTMLElement) {
  const style = getComputedStyle(grid)
  for (const source of countSources.value) {
    const palette = countSourcePalette(source.key, style)
    palette.forEach((color, value) => grid.style.setProperty(countPaletteVariable(source.key, value), color))
  }
}

function renderCountCanvas(row: readonly string[], canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect()
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(rect.width * ratio))
  const height = Math.max(1, Math.round(rect.height * ratio))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, width, height)

  const sources = countSources.value
  if (!sources.length || !row.length) return
  const style = getComputedStyle(canvas)
  const tileGap = Math.max(0, Math.round(Number.parseFloat(style.getPropertyValue('--analysis-count-tile-gap')) * ratio))
  const tileWidth = Math.max(sources.length, Math.round(Number.parseFloat(style.getPropertyValue('--analysis-tile-width')) * ratio))
  const wallGap = sources.length > 1
    ? Math.max(0, Math.round(Number.parseFloat(style.getPropertyValue('--analysis-count-wall-gap')) * ratio))
    : 0
  const sourceWidth = Math.max(sources.length, tileWidth - wallGap)
  const palettes = sources.map((source) => countSourcePalette(source.key, style))

  for (let tileIndex = 0; tileIndex < row.length; tileIndex += 1) {
    const tile = row[tileIndex]
    const blockLeft = tileIndex * (tileWidth + tileGap)

    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      const source = sources[sourceIndex]
      const sourceLeft = Math.round((sourceIndex * sourceWidth) / sources.length)
      const sourceRight = Math.round(((sourceIndex + 1) * sourceWidth) / sources.length)
      const left = blockLeft
        + sourceLeft
        + (sourceIndex === sources.length - 1 ? wallGap : 0)
      const laneWidth = Math.max(1, sourceRight - sourceLeft)
      const segments = countSegments(tile, source)
      let cumulative = 0
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const top = Math.round(cumulative * height)
        cumulative += segments[segmentIndex].probability
        const bottom = segmentIndex === segments.length - 1
          ? height
          : Math.round(cumulative * height)
        if (bottom <= top) continue
        const value = Math.max(0, Math.min(4, Number(segments[segmentIndex].value) || 0))
        context.fillStyle = palettes[sourceIndex][value]
        context.fillRect(left, top, laneWidth, bottom - top)
      }
    }
  }
}

function renderCountCanvases() {
  for (const { canvas, row } of countCanvasElements.values()) renderCountCanvas(row, canvas)
}

const scheduleCountBarGeometry = useResponsiveGeometry(
  countGridElement,
  () => {
    updateCountBarGeometry()
    renderCountCanvases()
  },
  {
    resizeAncestorSelector: '.analysis-tiles-view',
    styleAncestorSelector: '.dock-module',
  },
)

function setCountCanvasElement(key: string, row: readonly string[], element: unknown) {
  if (!(element instanceof HTMLCanvasElement)) {
    countCanvasElements.delete(key)
    return
  }
  countCanvasElements.set(key, { canvas: element, row })
  scheduleCountBarGeometry()
}

watch(() => [props.analysis, props.controlledSeat], () => {
  if (props.section === 'counts') {
    const target = countHoverTarget.value
    if (target && (
      !target.anchor.isConnected
      || target.contextKey !== countTooltipContextKey()
      || target.controlledSeat !== props.controlledSeat
      || !countHoverTooltip.value
      || !hasCountPrediction(countHoverTooltip.value.prediction)
    )) clearHoverTooltip()
    void nextTick(scheduleCountBarGeometry)
  }
}, { deep: true, flush: 'post' })

watch(() => props.countLayout, () => {
  if (props.section === 'counts') {
    clearHoverTooltip()
    void nextTick(scheduleCountBarGeometry)
  }
})

onBeforeUnmount(() => {
  cancelAnimationFrame(hoverTooltipPositionFrame)
  countCanvasElements.clear()
})

function showHoverTooltip(
  event: Event,
  content: Pick<HoverTooltipState, 'title' | 'lines' | 'rows'>,
) {
  const root = analysisRootElement.value
  const anchor = event.currentTarget
  if (!root || !(anchor instanceof Element)) return
  const rootRect = root.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  hoverTooltip.value = {
    ...content,
    left: anchorRect.left + (anchorRect.width / 2) - rootRect.left,
    top: anchorRect.top - rootRect.top,
    positioned: false,
  }
  cancelAnimationFrame(hoverTooltipPositionFrame)
  hoverTooltipPositionFrame = requestAnimationFrame(() => {
    hoverTooltipPositionFrame = 0
    const tooltip = hoverTooltipElement.value
    const currentRoot = analysisRootElement.value
    if (!tooltip || !currentRoot || !hoverTooltip.value) return
    const currentRootRect = currentRoot.getBoundingClientRect()
    const viewportRect = currentRoot.closest<HTMLElement>('.analysis-dock-body')?.getBoundingClientRect()
      || currentRootRect
    const currentAnchorRect = anchor.getBoundingClientRect()
    const horizontalInset = 8
    const verticalInset = 8
    const verticalGap = 8
    const halfWidth = tooltip.offsetWidth / 2
    const unclampedLeft = currentAnchorRect.left + (currentAnchorRect.width / 2) - currentRootRect.left
    const visibleLeft = Math.max(currentRootRect.left, viewportRect.left)
    const visibleRight = Math.min(currentRootRect.right, viewportRect.right)
    const visibleTop = Math.max(currentRootRect.top, viewportRect.top)
    const visibleBottom = Math.min(currentRootRect.bottom, viewportRect.bottom)
    const minimumLeft = visibleLeft - currentRootRect.left + halfWidth + horizontalInset
    const maximumLeft = Math.max(
      minimumLeft,
      visibleRight - currentRootRect.left - halfWidth - horizontalInset,
    )
    const availableAbove = currentAnchorRect.top - visibleTop
    const availableBelow = visibleBottom - currentAnchorRect.bottom
    const placement = availableAbove >= tooltip.offsetHeight + verticalGap || availableAbove >= availableBelow
      ? 'above'
      : 'below'
    const minimumTop = visibleTop - currentRootRect.top + verticalInset
    const maximumTop = Math.max(
      minimumTop,
      visibleBottom - currentRootRect.top - tooltip.offsetHeight - verticalInset,
    )
    const preferredTop = placement === 'above'
      ? currentAnchorRect.top - currentRootRect.top - tooltip.offsetHeight - verticalGap
      : currentAnchorRect.bottom - currentRootRect.top + verticalGap
    hoverTooltip.value = {
      ...hoverTooltip.value,
      left: Math.max(minimumLeft, Math.min(maximumLeft, unclampedLeft)),
      top: Math.max(minimumTop, Math.min(maximumTop, preferredTop)),
      positioned: true,
    }
  })
}

function clearHoverTooltip() {
  cancelAnimationFrame(hoverTooltipPositionFrame)
  hoverTooltipPositionFrame = 0
  hoverTooltip.value = null
  countHoverTarget.value = null
}

function showProbabilityTooltip(
  event: Event,
  title: string,
  label: string,
  value: number,
) {
  showHoverTooltip(event, {
    title,
    lines: [],
    rows: [{ label, value: formatProbability(value) }],
  })
}

function showValueTooltip(event: Event, subject: string, label: string, value: string) {
  showHoverTooltip(event, {
    title: subject,
    lines: [],
    rows: [{ label, value }],
  })
}

function showPredictionTooltip(
  event: Event,
  subject: string,
  label: string,
  prediction: NumericPrediction,
  unit: string,
) {
  const scalar = prediction.scalarValue === null
    ? t('analysis.noExpectedValue')
    : t(
      prediction.scalarSource === 'point-estimate' ? 'analysis.predictionValue' : 'analysis.expectedValue',
      { value: prediction.scalarValue.toFixed(2), unit },
    )
  showHoverTooltip(event, {
    title: `${subject} · ${label}`,
    lines: [scalar],
    rows: [],
  })
}

function showDistributionTooltip(
  event: Event,
  subject: string,
  label: string,
  distribution: DistributionEntry[],
  unit: string,
) {
  showHoverTooltip(event, {
    title: `${subject} · ${label}`,
    lines: distribution.length ? [] : [t('analysis.noData')],
    rows: distribution.map((entry) => ({
      label: `${entry.value}${unit}`,
      value: formatProbability(entry.probability),
    })),
  })
}

function showWinTooltip(
  event: Event,
  player: {
    label: string
    winProbability: number
    targets: Array<{ label: string; probability: number }>
  },
) {
  if (!player.targets.length) {
    showProbabilityTooltip(event, player.label, t('analysis.winProbability'), player.winProbability)
    return
  }
  showHoverTooltip(event, {
    title: t('analysis.winTarget', { player: player.label }),
    lines: [],
    rows: player.targets.map((target) => ({
      label: target.label,
      value: formatProbability(target.probability),
      barWidth: `${target.probability * 100}%`,
      barColor: 'var(--analysis-self-win-color)',
    })),
  })
}

function showDealInTooltip(
  event: Event,
  player: {
    label: string
    dealInProbability: number
    dealInWinnerSets: Array<{ winners: number[]; probability: number }>
  },
) {
  if (!player.dealInWinnerSets.length) {
    showProbabilityTooltip(event, player.label, t('analysis.dealInProbability'), player.dealInProbability)
    return
  }
  const listFormatter = new Intl.ListFormat(numberLocale.value, { style: 'short', type: 'conjunction' })
  showHoverTooltip(event, {
    title: t('analysis.dealInWinners', { player: player.label }),
    lines: [],
    rows: player.dealInWinnerSets.map((detail) => ({
      label: listFormatter.format(detail.winners.map(windLabel)),
      value: formatProbability(detail.probability),
      barWidth: `${detail.probability * 100}%`,
      barColor: 'var(--analysis-self-deal-in-color)',
    })),
  })
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
    // The floating layer lives outside the chart, so it needs resolved colors.
    palette: countSourcePalette(source.key, getComputedStyle(grid)),
  }
})

function showCountTooltip(event: Event, tile: string, source: TileSource) {
  const anchor = event.currentTarget
  if (!(anchor instanceof Element) || !countGridElement.value) return
  clearHoverTooltip()
  countHoverTarget.value = {
    anchor,
    tile,
    sourceKey: source.key,
    contextKey: countTooltipContextKey(),
    controlledSeat: props.controlledSeat,
  }
}
</script>

<style src="./AnalysisPanel.css"></style>
