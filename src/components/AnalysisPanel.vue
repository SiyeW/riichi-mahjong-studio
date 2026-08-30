<template>
  <div
    ref="analysisRootElement"
    class="unified-analysis"
    :class="{
      'reduce-motion': reduceMotion,
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
        <div class="analysis-opponent-prediction-grid">
          <div v-for="opponent in opponentCards" :key="opponent.key" class="analysis-opponent-predictions">
              <div
                class="analysis-opponent-prediction"
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
                class="analysis-opponent-prediction"
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
                  :class="player.kyokuDelta >= 0 ? 'positive' : 'negative'"
                  :style="deltaBarStyle(player.kyokuDelta)"
                />
                <small
                  class="analysis-delta-value"
                  :class="player.kyokuDelta >= 0 ? 'opposite-positive' : 'opposite-negative'"
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
      <div v-perceptual-surface="riskTrackSurface" class="analysis-risk-grid">
        <div v-for="row in tileRows" :key="row[0]" class="analysis-tile-chart-row analysis-risk-row">
          <div class="analysis-tile-sequence">
            <div v-for="(tile, tileIndex) in row" :key="tile" class="analysis-risk-tile">
              <img class="analysis-tile-face" :src="tileImageSrc(tile)" :alt="tileFaceLabel(tile)" />
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
        @perceptual-surface-change="scheduleCountBarGeometry"
      >
        <div v-for="row in countTileRows" :key="row.tiles.join('-')" class="analysis-tile-chart-row analysis-count-row">
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
              :class="{ 'is-red-five': isRedFive(tile) }"
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
              <img class="analysis-tile-face" :src="tileImageSrc(tile)" :alt="tileFaceLabel(tile)" />
            </div>
          </div>
        </div>
        <div class="analysis-count-legends">
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
    </div>

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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from '../i18n'
import {
  buildCountColorScale,
  buildWallCountColorScale,
  COUNT_EMPTY_COLOR,
} from '../analysisCountPalette'
import { hasRedFiveCountPredictions, RED_FIVE_TILES } from '../analysisTileCounts'
import { resolveKyokuOutcome } from '../kyokuOutcome'
import {
  parseNumericPrediction,
  type DistributionEntry,
  type DistributionValue,
  type NumericPrediction,
} from '../numericPrediction'
import {
  oklabToRgb,
  parseCssColor,
  rgbString,
  rgbToOklab,
  type RgbColor,
} from '../perceptualColor'
import { vPerceptualSurface, type PerceptualSurfaceBinding } from '../perceptualSurface'
import ShantenPieChart from './ShantenPieChart.vue'

const { t, numberLocale } = useI18n()

type AnalysisRecord = Record<string, unknown>
type TileSource = { key: string; label: string; seat: number | null }
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
  shantenOpponents: Array<{ key: string; seat: number; label: string; probabilities: number[] }>
  shantenColors: string[]
  shantenLabels: string[]
  shantenShortLabels: string[]
  reduceMotion: boolean
  controlledSeat: number
  dealer: number
  tileImageSrc: (tile: string) => string
  tileFaceLabel: (tile: string) => string
  perceptualSurface: PerceptualSurfaceBinding
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
let hoverTooltipPositionFrame = 0
const offenseTrackElements = new Map<number, HTMLElement>()
const offenseLabelPositions = ref<Map<number, { win: number; dealIn: number }>>(new Map())
let offenseResizeObserver: ResizeObserver | null = null
let offenseMeasureFrame = 0
const countGridElement = ref<HTMLElement | null>(null)
const countCanvasElements = new Map<string, { canvas: HTMLCanvasElement; row: string[] }>()
let countGeometryFrame = 0
let countResizeObserver: ResizeObserver | null = null
let countStyleObserver: MutationObserver | null = null
const tileRows = [
  ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m'],
  ['1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p'],
  ['1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s'],
  ['E', 'S', 'W', 'N', 'P', 'F', 'C'],
]

function isRedFive(tile: string): boolean {
  return tile === '5mr' || tile === '5pr' || tile === '5sr'
}

function objectValue(value: unknown): AnalysisRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnalysisRecord : {}
}

function finiteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function probability(value: unknown): number {
  return Math.max(0, Math.min(1, finiteNumber(value)))
}

const outputs = computed(() => objectValue(props.analysis?.outputs))

function outputData(outputId: string): AnalysisRecord {
  return objectValue(outputs.value[outputId])
}

function outputPlayers(outputId: string): AnalysisRecord[] {
  const players = outputData(outputId).players
  return Array.isArray(players) ? players.map(objectValue) : []
}

const hasRedFivePredictions = computed(() => {
  return hasRedFiveCountPredictions(
    outputData('wall-tile-count'),
    outputPlayers('opponent-concealed-tile-count'),
  )
})

const countTileRows = computed(() => [
  { key: 'm', tiles: hasRedFivePredictions.value ? [...tileRows[0], RED_FIVE_TILES[0]] : tileRows[0] },
  { key: 'p', tiles: hasRedFivePredictions.value ? [...tileRows[1], RED_FIVE_TILES[1]] : tileRows[1] },
  { key: 's', tiles: hasRedFivePredictions.value ? [...tileRows[2], RED_FIVE_TILES[2]] : tileRows[2] },
  { key: 'z', tiles: tileRows[3] },
])

function playerOutput(outputId: string, seat: number): AnalysisRecord {
  return outputPlayers(outputId).find((player) => Number(player.seat) === seat) || {}
}

function parsePrediction(value: unknown): NumericPrediction {
  return parseNumericPrediction(value)
}

function seatPrediction(outputId: string, seat: number): NumericPrediction {
  return parsePrediction(playerOutput(outputId, seat).prediction)
}

function formatCompactPoints(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(numberLocale.value, {
    notation: Math.abs(value) >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(Math.round(value))
}

function formatPoints(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? t('analysis.noData')
    : t('analysis.points', { value: Math.round(value).toLocaleString(numberLocale.value) })
}

function formatPlainPoints(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString(numberLocale.value)
}

function formatSignedCompactPoints(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const absolute = formatCompactPoints(Math.abs(value))
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${absolute}`
}

function formatDistributionPoints(value: DistributionValue): string {
  if (typeof value !== 'number') return String(value)
  return formatCompactPoints(value)
}

function formatProbability(value: number): string {
  const percentage = probability(value) * 100
  if (percentage === 0) return '0%'
  if (percentage < 0.01) return '<0.01%'
  return `${percentage.toFixed(1)}%`
}

const opponentCards = computed(() => props.shantenOpponents.map((opponent) => {
  const dora = seatPrediction('opponent-dora-count', opponent.seat)
  const score = seatPrediction('opponent-score', opponent.seat)
  return {
    ...opponent,
    dora: dora.scalarValue === null ? '—' : dora.scalarValue.toFixed(1),
    score: formatCompactPoints(score.scalarValue),
    doraPrediction: dora,
    scorePrediction: score,
    scoreModes: [...score.distribution]
      .sort((left, right) => right.probability - left.probability)
      .slice(0, 3),
  }
}))

function maximumDistributionProbability(predictions: NumericPrediction[]): number {
  return Math.max(
    0.01,
    ...predictions.flatMap((prediction) => prediction.distribution.map((entry) => entry.probability)),
  )
}

const doraDistributionScale = computed(() => maximumDistributionProbability(
  opponentCards.value.map((opponent) => opponent.doraPrediction),
))
const scoreDistributionScale = computed(() => maximumDistributionProbability(
  opponentCards.value.map((opponent) => opponent.scorePrediction),
))

function distributionBarHeight(value: number, scale: number): string {
  return `${Math.min(1, probability(value) / Math.max(0.01, scale)) * 100}%`
}

function relativeLabel(seat: number): string {
  const offset = (seat - props.controlledSeat + 4) % 4
  return [t('seat.self'), t('seat.shimocha'), t('seat.toimen'), t('seat.kamicha')][offset]
    || t('seat.number', { seat })
}

function windLabel(seat: number): string {
  const wind = [t('wind.east'), t('wind.south'), t('wind.west'), t('wind.north')][(seat - props.dealer + 4) % 4] || '?'
  return t('seat.windRelative', { wind, relative: relativeLabel(seat) })
}

function targetRows(player: AnalysisRecord, winnerSeat: number) {
  const raw = Array.isArray(player.targetGivenWin) ? player.targetGivenWin.map(objectValue) : []
  if (!raw.length) return []
  return [winnerSeat, (winnerSeat + 1) % 4, (winnerSeat + 2) % 4, (winnerSeat + 3) % 4].map((seat) => {
    const entry = raw.find((item) => Number(item.seat) === seat)
    return {
      seat,
      label: seat === winnerSeat ? t('action.tsumo') : windLabel(seat),
      probability: probability(entry?.probability),
    }
  })
}

const kyokuOutcome = computed(() => resolveKyokuOutcome(outputData('kyoku-outcome')))
const legacyKyokuPlayers = computed(() => outputPlayers('kyoku-outcome'))
const outcomeSegments = computed(() => {
  const self = kyokuOutcome.value.players.find((player) => player.seat === props.controlledSeat)
  const draw = kyokuOutcome.value.drawProbability
  const selfWin = self?.winProbability || 0
  const selfDealIn = self?.dealInProbability || 0
  const horizontal = kyokuOutcome.value.hasTotals
    ? Math.max(0, 1 - draw - selfWin - selfDealIn)
    : 0
  const segments = [
    { key: 'draw', label: t('analysis.draw'), probability: draw },
    { key: 'self-win', label: t('analysis.selfWin'), probability: selfWin },
    { key: 'self-deal-in', label: t('analysis.selfDealIn'), probability: selfDealIn },
    { key: 'horizontal', label: t('analysis.horizontal'), probability: horizontal },
  ]
  const total = segments.reduce((sum, segment) => sum + segment.probability, 0) || 1
  return segments.map((segment) => ({ ...segment, displayProbability: segment.probability / total }))
})

const playerSeatOrder = computed(() => [
  (props.controlledSeat + 3) % 4,
  props.controlledSeat,
  (props.controlledSeat + 1) % 4,
  (props.controlledSeat + 2) % 4,
])

const playerRows = computed(() => playerSeatOrder.value.map((seat) => {
  const outcome = kyokuOutcome.value.players.find((player) => player.seat === seat)!
  const legacyOutcome = legacyKyokuPlayers.value.find((player) => Number(player.seat) === seat) || {}
  const delta = seatPrediction('kyoku-score-delta', seat)
  const placement = seatPrediction('match-placement', seat)
  const matchScore = seatPrediction('match-score', seat)
  const normalizedPlacement = [4, 3, 2, 1].map((value) => ({
    value,
    probability: placement.distribution.find((entry) => entry.value === value)?.probability || 0,
  }))
  return {
    seat,
    label: windLabel(seat),
    winProbability: outcome.winProbability,
    dealInProbability: outcome.dealInProbability,
    targets: outcome.winTargets.length ? outcome.winTargets.map((target) => ({
      ...target,
      label: target.seat === seat ? t('action.tsumo') : windLabel(target.seat),
    })) : targetRows(legacyOutcome, seat),
    dealInWinnerSets: outcome.dealInWinnerSets,
    kyokuDelta: delta.scalarValue,
    placement: normalizedPlacement,
    expectedPlacement: placement.scalarValue === null ? '—' : placement.scalarValue.toFixed(2),
    matchScore: matchScore.scalarValue,
  }
}))

const maxAbsoluteDelta = computed(() => Math.max(
  1,
  ...playerRows.value.map((player) => Math.abs(player.kyokuDelta || 0)),
))

function deltaBarStyle(value: number | null) {
  const normalized = Math.min(1, Math.abs(value || 0) / maxAbsoluteDelta.value)
  return value !== null && value < 0
    ? { right: '50%', width: `${normalized * 50}%` }
    : { left: '50%', width: `${normalized * 50}%` }
}

function measureOffenseLabels() {
  const nextPositions = new Map<number, { win: number; dealIn: number }>()
  for (const player of playerRows.value) {
    const track = offenseTrackElements.get(player.seat)
    if (!track) continue
    const winLabel = track.querySelector<HTMLElement>('.analysis-offense-value.is-win')
    const dealInLabel = track.querySelector<HTMLElement>('.analysis-offense-value.is-deal-in')
    if (!winLabel || !dealInLabel) continue
    const trackWidth = track.clientWidth
    const winWidth = winLabel.scrollWidth
    const dealInWidth = dealInLabel.scrollWidth
    const edgeGap = Math.max(3, trackWidth * 0.008)
    const minimumSeparation = Math.max(8, trackWidth * 0.016)
    const dealInEnd = trackWidth * player.dealInProbability
    const winStart = trackWidth * (1 - player.winProbability)
    let dealInLeft = dealInEnd + edgeGap
    let winLeft = winStart - edgeGap - winWidth

    if (dealInLeft + dealInWidth + minimumSeparation > winLeft) {
      dealInLeft = Math.max(0, dealInEnd - edgeGap - dealInWidth)
      winLeft = Math.max(winStart + edgeGap, dealInLeft + dealInWidth + minimumSeparation)
      const maximumWinLeft = Math.max(0, trackWidth - winWidth)
      if (winLeft > maximumWinLeft) {
        winLeft = maximumWinLeft
        dealInLeft = Math.max(0, Math.min(dealInLeft, winLeft - minimumSeparation - dealInWidth))
      }
    }

    nextPositions.set(player.seat, {
      win: Math.max(0, Math.min(winLeft, trackWidth - winWidth)),
      dealIn: Math.max(0, Math.min(dealInLeft, trackWidth - dealInWidth)),
    })
  }
  offenseLabelPositions.value = nextPositions
}

function offenseLabelStyle(seat: number, kind: 'win' | 'dealIn') {
  const position = offenseLabelPositions.value.get(seat)?.[kind] || 0
  return { left: `${position}px` }
}

function scheduleOffenseLabelMeasurement() {
  cancelAnimationFrame(offenseMeasureFrame)
  offenseMeasureFrame = requestAnimationFrame(measureOffenseLabels)
}

function setOffenseTrackElement(seat: number, element: unknown) {
  const previous = offenseTrackElements.get(seat)
  if (previous && previous !== element) offenseResizeObserver?.unobserve(previous)
  if (!(element instanceof HTMLElement)) {
    offenseTrackElements.delete(seat)
    return
  }
  offenseTrackElements.set(seat, element)
  offenseResizeObserver?.observe(element)
  scheduleOffenseLabelMeasurement()
}

function updateCountBarGeometry() {
  const grid = countGridElement.value
  if (!grid) return
  const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const floatingScale = Number.parseFloat(getComputedStyle(grid).getPropertyValue('--floating-panel-scale')) || 1
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const desiredTilePixels = Math.max(8, Math.round(2.45 * rootRem * floatingScale * ratio))
  const sourceCount = Math.max(1, countSources.value.length)
  const wallGapPixels = sourceCount > 1 ? 2 : 0
  const lanePixels = Math.max(2, Math.round((desiredTilePixels - wallGapPixels) / sourceCount))
  const tilePixels = (lanePixels * sourceCount) + wallGapPixels
  const tileGapPixels = 2
  grid.style.setProperty('--analysis-tile-width', `${tilePixels / ratio}px`)
  grid.style.setProperty('--analysis-count-source-gap', '0px')
  grid.style.setProperty('--analysis-count-wall-gap', `${wallGapPixels / ratio}px`)
  grid.style.setProperty('--analysis-count-tile-gap', `${tileGapPixels / ratio}px`)
  updateCountPaletteVariables(grid)
}

const COUNT_SOURCE_FALLBACKS: Record<'kamicha' | 'toimen' | 'shimocha', RgbColor> = {
  kamicha: [44, 143, 197],
  toimen: [211, 154, 58],
  shimocha: [76, 175, 80],
}

function countSourceColor(source: TileSource, style: CSSStyleDeclaration): string {
  if (source.key === 'kamicha') return style.getPropertyValue('--ron-kamicha-color').trim() || '#2c8fc5'
  if (source.key === 'toimen') return style.getPropertyValue('--ron-toimen-color').trim() || '#d39a3a'
  if (source.key === 'shimocha') return style.getPropertyValue('--ron-shimocha-color').trim() || '#4caf50'
  return ''
}

function playerCountBaseColors(style: CSSStyleDeclaration): Record<'kamicha' | 'toimen' | 'shimocha', RgbColor> {
  return {
    kamicha: parseCssColor(style.getPropertyValue('--ron-kamicha-color'), COUNT_SOURCE_FALLBACKS.kamicha),
    toimen: parseCssColor(style.getPropertyValue('--ron-toimen-color'), COUNT_SOURCE_FALLBACKS.toimen),
    shimocha: parseCssColor(style.getPropertyValue('--ron-shimocha-color'), COUNT_SOURCE_FALLBACKS.shimocha),
  }
}

function wallCountBaseColor(style: CSSStyleDeclaration): RgbColor {
  const players = Object.values(playerCountBaseColors(style)).map(rgbToOklab)
  const meanLightness = players.reduce((sum, color) => sum + color.l, 0) / players.length
  const meanChroma = players.reduce((sum, color) => sum + Math.hypot(color.a, color.b), 0) / players.length
  const hue = 170 * (Math.PI / 180)
  const chroma = Math.max(0.018, Math.min(0.04, meanChroma * 0.2))
  return oklabToRgb({
    l: meanLightness,
    a: chroma * Math.cos(hue),
    b: chroma * Math.sin(hue),
  })
}

function countSourceBaseColor(source: TileSource, style: CSSStyleDeclaration): RgbColor {
  if (source.key === 'wall') return wallCountBaseColor(style)
  const fallback = COUNT_SOURCE_FALLBACKS[source.key as keyof typeof COUNT_SOURCE_FALLBACKS]
  return parseCssColor(countSourceColor(source, style), fallback || COUNT_SOURCE_FALLBACKS.kamicha)
}

function countSourcePalette(source: TileSource, style: CSSStyleDeclaration): string[] {
  const baseRgb = countSourceBaseColor(source, style)
  const palette = source.key === 'wall'
    ? buildWallCountColorScale(baseRgb)
    : buildCountColorScale(baseRgb)
  return palette.map(rgbString)
}

function countPaletteVariable(sourceKey: string, value: number): string {
  return `--analysis-count-${sourceKey}-${value}`
}

function countSegmentColor(sourceKey: string, value: DistributionValue, tile = ''): string {
  const numericValue = Math.max(0, Math.min(4, Number(value) || 0))
  const paletteValue = isRedFive(tile) && numericValue > 0 ? 2 : numericValue
  return `var(${countPaletteVariable(sourceKey, paletteValue)})`
}

function updateCountPaletteVariables(grid: HTMLElement) {
  const style = getComputedStyle(grid)
  for (const source of countSources.value) {
    const palette = countSourcePalette(source, style)
    palette.forEach((color, value) => grid.style.setProperty(countPaletteVariable(source.key, value), color))
  }
}

function renderCountCanvas(row: string[], canvas: HTMLCanvasElement) {
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
  const tileGap = Math.max(1, Math.round(Number.parseFloat(style.getPropertyValue('--analysis-count-tile-gap')) * ratio))
  const tileWidth = Math.max(sources.length, Math.round(Number.parseFloat(style.getPropertyValue('--analysis-tile-width')) * ratio))
  const wallGap = sources.length > 1
    ? Math.max(1, Math.round(Number.parseFloat(style.getPropertyValue('--analysis-count-wall-gap')) * ratio))
    : 0
  const laneWidth = Math.max(1, Math.floor((tileWidth - wallGap) / sources.length))
  const palettes = sources.map((source) => countSourcePalette(source, style))

  for (let tileIndex = 0; tileIndex < row.length; tileIndex += 1) {
    const tile = row[tileIndex]
    const blockLeft = tileIndex * (tileWidth + tileGap)

    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      const source = sources[sourceIndex]
      const left = blockLeft
        + (sourceIndex * laneWidth)
        + (sourceIndex === sources.length - 1 ? wallGap : 0)
      const segments = countSegments(tile, source)
      let cumulative = 0
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const top = Math.round(cumulative * height)
        cumulative += segments[segmentIndex].probability
        const bottom = segmentIndex === segments.length - 1
          ? height
          : Math.round(cumulative * height)
        if (bottom <= top) continue
        const value = Number(segments[segmentIndex].value)
        context.fillStyle = palettes[sourceIndex][isRedFive(tile) && value > 0 ? 2 : value]
        context.fillRect(left, top, laneWidth, bottom - top)
      }
    }
  }
}

function renderCountCanvases() {
  for (const { canvas, row } of countCanvasElements.values()) renderCountCanvas(row, canvas)
}

function scheduleCountBarGeometry() {
  if (countGeometryFrame) return
  countGeometryFrame = requestAnimationFrame(() => {
    countGeometryFrame = 0
    updateCountBarGeometry()
    renderCountCanvases()
  })
}

function setCountCanvasElement(key: string, row: string[], element: unknown) {
  const previous = countCanvasElements.get(key)
  if (previous) countResizeObserver?.unobserve(previous.canvas)
  if (!(element instanceof HTMLCanvasElement)) {
    countCanvasElements.delete(key)
    return
  }
  countCanvasElements.set(key, { canvas: element, row })
  countResizeObserver?.observe(element)
  scheduleCountBarGeometry()
}

function connectCountGeometry(grid: HTMLElement | null) {
  countResizeObserver?.disconnect()
  countStyleObserver?.disconnect()
  countResizeObserver = null
  countStyleObserver = null
  if (!grid) return
  countResizeObserver = new ResizeObserver(scheduleCountBarGeometry)
  countResizeObserver.observe(grid)
  for (const { canvas } of countCanvasElements.values()) countResizeObserver.observe(canvas)
  const dock = grid.closest('.dock-module')
  if (dock) {
    countStyleObserver = new MutationObserver(scheduleCountBarGeometry)
    countStyleObserver.observe(dock, { attributes: true, attributeFilter: ['style', 'class'] })
  }
  scheduleCountBarGeometry()
}

onMounted(() => {
  if (props.section === 'game') {
    offenseResizeObserver = new ResizeObserver(scheduleOffenseLabelMeasurement)
    for (const element of offenseTrackElements.values()) offenseResizeObserver.observe(element)
    scheduleOffenseLabelMeasurement()
  }
  if (props.section === 'counts') {
    window.addEventListener('resize', scheduleCountBarGeometry)
  }
})

watch(countGridElement, connectCountGeometry, { flush: 'post', immediate: true })

watch(() => props.analysis, () => {
  if (props.section === 'counts') void nextTick(scheduleCountBarGeometry)
}, { deep: true })

watch(playerRows, () => {
  if (props.section === 'game') void nextTick(scheduleOffenseLabelMeasurement)
}, { deep: true })

onBeforeUnmount(() => {
  cancelAnimationFrame(hoverTooltipPositionFrame)
  cancelAnimationFrame(offenseMeasureFrame)
  cancelAnimationFrame(countGeometryFrame)
  offenseResizeObserver?.disconnect()
  offenseResizeObserver = null
  countResizeObserver?.disconnect()
  countResizeObserver = null
  countStyleObserver?.disconnect()
  countStyleObserver = null
  window.removeEventListener('resize', scheduleCountBarGeometry)
  countCanvasElements.clear()
  offenseTrackElements.clear()
  offenseLabelPositions.value = new Map()
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

const opponentSources = computed<TileSource[]>(() => props.shantenOpponents.map((opponent) => ({
  key: opponent.key,
  label: opponent.label,
  seat: opponent.seat,
})))
const countSources = computed<TileSource[]>(() => [
  ...opponentSources.value,
  { key: 'wall', label: t('analysis.wall'), seat: null },
])

function riskProbability(seat: number | null, tile: string): number {
  if (seat === null) return 0
  const player = playerOutput('opponent-deal-in-probability', seat)
  return probability(objectValue(player.tiles)[tile])
}

const RISK_ADAPTIVE_MIN = 0.2
const RISK_TICK_STEP = 0.05
const riskScale = computed(() => Math.max(
  RISK_ADAPTIVE_MIN,
  ...opponentSources.value.flatMap((source) => tileRows.flatMap((row) => (
    row.map((tile) => riskProbability(source.seat, tile))
  ))),
))

const showRiskAdaptiveThreshold = computed(() => riskScale.value > RISK_ADAPTIVE_MIN)
const riskScaleTicks = computed(() => {
  const stepCount = Math.floor((riskScale.value + Number.EPSILON) / RISK_TICK_STEP)
  return Array.from({ length: stepCount + 1 }, (_, index) => ({
    value: index * RISK_TICK_STEP,
    label: index % 2 === 0 ? `${index * 5}%` : '',
  }))
})

function riskBarScale(value: number): number {
  return Math.min(1, probability(value) / riskScale.value)
}

function riskScalePosition(value: number): string {
  return `${riskBarScale(value) * 100}%`
}

function tilePrediction(tile: string, source: TileSource): NumericPrediction {
  const property = isRedFive(tile) ? 'redTiles' : 'tiles'
  if (source.seat === null) {
    return parsePrediction(objectValue(outputData('wall-tile-count')[property])[tile])
  }
  const player = playerOutput('opponent-concealed-tile-count', source.seat)
  return parsePrediction(objectValue(player[property])[tile])
}

function countSegments(tile: string, source: TileSource): DistributionEntry[] {
  const prediction = tilePrediction(tile, source)
  const values = (isRedFive(tile) ? [0, 1] : [0, 1, 2, 3, 4]).map((value) => ({
    value,
    probability: prediction.distribution.find((entry) => entry.value === value)?.probability || 0,
  }))
  const total = values.reduce((sum, entry) => sum + entry.probability, 0)
  if (total > 0) return values.map((entry) => ({ ...entry, probability: entry.probability / total }))
  return values
}

function showCountTooltip(event: Event, tile: string, source: TileSource) {
  const prediction = tilePrediction(tile, source)
  const scalar = prediction.scalarValue === null
    ? null
    : t(
      prediction.scalarSource === 'point-estimate' ? 'analysis.predictedCount' : 'analysis.expectedCount',
      { value: prediction.scalarValue.toFixed(2) },
    )
  const segments = prediction.distribution.length ? countSegments(tile, source) : []
  showHoverTooltip(event, {
    title: t('analysis.tileCountDistribution', {
      source: source.label,
      tile: props.tileFaceLabel(tile),
    }),
    lines: scalar ? [scalar] : [],
    rows: segments.map((entry) => ({
      label: t('analysis.countUnit', { value: entry.value }),
      value: formatProbability(entry.probability),
      barWidth: `${entry.probability * 100}%`,
      barColor: countSegmentColor(source.key, entry.value, tile),
    })),
  })
}
</script>

<style scoped>
.unified-analysis {
  --analysis-border: rgba(140, 195, 188, 0.16);
  --analysis-surface: rgba(0, 29, 35, 0.28);
  --analysis-soft-surface: rgba(0, 20, 25, 0.26);
  position: relative;
  width: 100%;
  max-width: none;
  color: rgba(238, 247, 244, 0.92);
  font-size: var(--ui-text-body);
}

.unified-analysis.is-count-section {
  height: 100%;
}

button {
  font: inherit;
}

.analysis-opponent-section,
.analysis-player-section {
  min-width: 0;
  background: transparent;
}

.analysis-opponent-section {
  --analysis-distribution-track-surface: rgba(255, 255, 255, 0.045);
}

.analysis-opponent-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.analysis-opponent-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 0;
  padding: calc(0.34rem * var(--floating-panel-scale)) calc(0.36rem * var(--floating-panel-scale));
}

.analysis-opponent-card + .analysis-opponent-card {
  border-left: 1px solid var(--analysis-border);
}

.analysis-opponent-card :deep(.shanten-chart) {
  gap: calc(0.12rem * var(--floating-panel-scale));
  width: min(100%, calc(7rem * var(--floating-panel-scale)));
}

.analysis-opponent-card :deep(.shanten-opp-label) {
  color: rgba(226, 239, 235, 0.82);
  font-size: var(--ui-text-body);
}

.analysis-opponent-prediction-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.analysis-opponent-predictions {
  display: grid;
  gap: calc(0.28rem * var(--floating-panel-scale));
  min-width: 0;
  padding: calc(0.34rem * var(--floating-panel-scale)) calc(0.36rem * var(--floating-panel-scale));
}

.analysis-opponent-predictions + .analysis-opponent-predictions {
  border-left: 1px solid var(--analysis-border);
}

.analysis-opponent-prediction {
  min-width: 0;
}

.analysis-prediction-heading {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: calc(0.22rem * var(--floating-panel-scale));
  min-width: 0;
  margin-bottom: calc(0.16rem * var(--floating-panel-scale));
}

.analysis-prediction-heading strong {
  color: rgba(229, 240, 237, 0.88);
  font-size: var(--ui-text-body);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.analysis-prediction-heading small {
  color: rgba(186, 211, 207, 0.68);
  font-size: var(--ui-text-caption);
}

.analysis-dora-distribution {
  display: grid;
  grid-auto-columns: minmax(0, 1fr);
  grid-auto-flow: column;
  gap: 0;
  height: calc(2.25rem * var(--floating-panel-scale));
}

.analysis-dora-distribution > span {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: calc(0.06rem * var(--floating-panel-scale));
  min-width: 0;
}

.analysis-dora-distribution i,
.analysis-score-distribution i {
  position: relative;
  display: flex;
  align-items: flex-end;
  min-width: 0;
  overflow: hidden;
  background: var(--analysis-distribution-track-surface);
}

.analysis-dora-distribution > span + span i {
  border-left: 1px solid rgba(1, 42, 49, 0.82);
}

.analysis-dora-distribution em,
.analysis-score-distribution span {
  display: block;
  width: 100%;
  background: var(--analysis-dora-color);
  transition: height var(--ui-motion-duration) var(--ui-motion-easing);
}

.analysis-dora-distribution small {
  overflow: hidden;
  color: rgba(198, 219, 214, 0.72);
  font-size: var(--ui-text-caption);
  font-style: normal;
  line-height: 1;
  text-align: center;
  text-overflow: clip;
  white-space: nowrap;
}

.analysis-score-distribution {
  display: flex;
  align-items: stretch;
  gap: 0;
  height: calc(1.65rem * var(--floating-panel-scale));
  overflow: hidden;
}

.analysis-score-distribution i {
  flex: 1 1 0;
}

.analysis-score-distribution span {
  background: var(--analysis-score-color);
}

.analysis-score-modes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: calc(0.12rem * var(--floating-panel-scale));
  margin-top: calc(0.12rem * var(--floating-panel-scale));
}

.analysis-score-modes span {
  overflow: hidden;
  padding: calc(0.08rem * var(--floating-panel-scale)) calc(0.12rem * var(--floating-panel-scale));
  color: rgba(220, 232, 228, 0.76);
  background: color-mix(in srgb, var(--analysis-score-color) 10%, transparent);
  font-size: var(--ui-text-caption);
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.analysis-shanten-legend {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: calc(0.18rem * var(--floating-panel-scale)) calc(0.48rem * var(--floating-panel-scale));
  padding: calc(0.3rem * var(--floating-panel-scale)) calc(0.38rem * var(--floating-panel-scale));
  border-top: 1px solid var(--analysis-border);
  border-bottom: 1px solid var(--analysis-border);
  color: rgba(205, 224, 220, 0.7);
  font-size: var(--ui-text-caption);
}

.analysis-shanten-legend span,
.analysis-outcome-legend span,
.analysis-source-legend span,
.analysis-count-legend span {
  display: inline-flex;
  align-items: center;
  gap: calc(0.18rem * var(--floating-panel-scale));
  white-space: nowrap;
}

.analysis-shanten-legend i,
.analysis-outcome-legend i,
.analysis-source-legend i,
.analysis-count-legend i {
  display: inline-block;
  width: calc(0.52rem * var(--floating-panel-scale));
  height: calc(0.52rem * var(--floating-panel-scale));
}

.analysis-outcome-strip {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: minmax(0, 1fr);
  gap: calc(0.28rem * var(--floating-panel-scale));
  padding: calc(0.36rem * var(--floating-panel-scale)) 0;
  border-bottom: 1px solid rgba(140, 195, 188, 0.11);
}

.analysis-outcome-bar {
  display: flex;
  height: calc(1.1rem * var(--ui-scale));
  overflow: hidden;
  background: rgba(255, 255, 255, 0.05);
}

.analysis-outcome-bar span {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-width: 0;
}

.analysis-outcome-bar small {
  overflow: hidden;
  color: rgba(255, 255, 255, 0.9);
  font-size: var(--ui-text-caption);
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.45);
  white-space: nowrap;
}

.is-draw { background: var(--analysis-draw-color); }
.is-self-win { background: var(--analysis-self-win-color); }
.is-self-deal-in { background: var(--analysis-self-deal-in-color); }
.is-horizontal { background: var(--analysis-horizontal-color); }

.analysis-outcome-legend {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: calc(0.4rem * var(--floating-panel-scale));
  color: rgba(207, 226, 221, 0.72);
  font-size: var(--ui-text-caption);
}

.analysis-player-groups {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas:
    'offense'
    'delta'
    'match';
  gap: calc(0.36rem * var(--floating-panel-scale));
  padding: 0;
}

.analysis-player-group {
  display: grid;
  column-gap: calc(0.38rem * var(--floating-panel-scale));
  min-width: 0;
  padding: 0 calc(0.36rem * var(--floating-panel-scale));
  border: 1px solid rgba(140, 195, 188, 0.12);
  background: rgba(1, 42, 49, 0.28);
}

.analysis-offense-group {
  grid-area: offense;
  grid-template-columns: max-content minmax(0, 1fr);
}

.analysis-delta-group {
  grid-area: delta;
  grid-template-columns: max-content minmax(0, 1fr);
}

.analysis-match-group {
  grid-area: match;
  grid-template-columns: max-content minmax(0, 1fr) max-content max-content;
}

.analysis-player-group-heading {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: center;
  min-height: calc(1.8rem * var(--ui-scale));
  border-bottom: 1px solid rgba(140, 195, 188, 0.11);
}

.analysis-player-group-heading strong {
  color: rgba(217, 233, 229, 0.8);
  font-size: var(--ui-text-body);
  font-weight: 600;
}

.analysis-offense-axis-heading {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: center;
  min-height: calc(1.5rem * var(--ui-scale));
  border-bottom: 1px solid rgba(140, 195, 188, 0.11);
}

.analysis-offense-headings {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  color: rgba(190, 213, 209, 0.68);
  font-size: var(--ui-text-caption);
}

.analysis-offense-headings span:first-child { text-align: left; }
.analysis-offense-headings span:last-child { text-align: right; }

.analysis-comparison-row {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: center;
  min-height: calc(1.48rem * var(--ui-scale));
  border-bottom: 1px solid rgba(140, 195, 188, 0.08);
}

.analysis-comparison-row:last-child { border-bottom: 0; }

.analysis-player-name {
  overflow: hidden;
  color: rgba(226, 239, 235, 0.82);
  font-size: var(--ui-text-body);
  font-weight: 400;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.analysis-offense-track {
  position: relative;
  height: calc(1rem * var(--ui-scale));
  overflow: visible;
  background: rgba(255, 255, 255, 0.055);
}

.analysis-offense-track::before {
  position: absolute;
  z-index: 1;
  left: 50%;
  top: 0;
  bottom: 0;
  border-left: 1px solid rgba(203, 224, 219, 0.16);
  content: '';
  pointer-events: none;
}

.analysis-offense-segment {
  position: absolute;
  z-index: 2;
  top: 0;
  bottom: 0;
  min-width: 0;
  outline: none;
  transition: width var(--ui-motion-duration) var(--ui-motion-easing);
}

.analysis-offense-segment.is-win {
  right: 0;
  background: var(--analysis-self-win-color);
}

.analysis-offense-segment.is-deal-in {
  left: 0;
  background: var(--analysis-self-deal-in-color);
}

.analysis-offense-value {
  position: absolute;
  z-index: 4;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  opacity: 0;
  color: rgba(240, 248, 246, 0.86);
  font-size: var(--ui-text-caption);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  white-space: nowrap;
}

.analysis-offense-track.labels-measured .analysis-offense-value {
  opacity: 1;
  transition: left var(--ui-motion-duration) var(--ui-motion-easing);
}

.analysis-offense-segment:focus-visible {
  box-shadow: inset 0 0 0 1px rgba(224, 241, 236, 0.58);
}

.analysis-delta-cell {
  position: relative;
  height: calc(1rem * var(--ui-scale));
  background: rgba(255, 255, 255, 0.045);
}

.analysis-zero-axis {
  position: absolute;
  z-index: 2;
  left: 50%;
  top: 0;
  bottom: 0;
  border-left: 1px solid #deeeea;
  pointer-events: none;
}

.analysis-delta-cell > span {
  position: absolute;
  z-index: 1;
  top: 0;
  bottom: 0;
}

.analysis-delta-cell > span.positive { background: var(--analysis-self-win-color); }
.analysis-delta-cell > span.negative { background: var(--analysis-self-deal-in-color); }

.analysis-delta-value {
  position: absolute;
  z-index: 3;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  color: rgba(229, 241, 237, 0.84);
  font-size: var(--ui-text-caption);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.45);
  white-space: nowrap;
}

.analysis-delta-value.opposite-negative {
  left: calc(50% + (0.24rem * var(--floating-panel-scale)));
}

.analysis-delta-value.opposite-positive {
  right: calc(50% + (0.24rem * var(--floating-panel-scale)));
}

.analysis-match-heading span {
  color: rgba(190, 213, 209, 0.68);
  font-size: var(--ui-text-caption);
}

.analysis-match-heading span:first-of-type { grid-column: 2 / 4; }
.analysis-match-heading span:last-child { text-align: right; }

.analysis-placement-bar {
  display: flex;
  height: calc(1rem * var(--ui-scale));
  overflow: hidden;
  background: rgba(255, 255, 255, 0.045);
}

.analysis-placement-bar span { height: 100%; }
.rank-1 { background: var(--analysis-rank-1-color); }
.rank-2 { background: var(--analysis-rank-2-color); }
.rank-3 { background: var(--analysis-rank-3-color); }
.rank-4 { background: var(--analysis-rank-4-color); }

.analysis-placement-value,
.analysis-score-cell {
  color: rgba(229, 241, 237, 0.84);
  font-size: var(--ui-text-caption);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.analysis-tiles-view {
  position: relative;
  min-width: 0;
}

.analysis-risk-grid,
.analysis-count-grid {
  --analysis-tile-width: calc(2.45rem * var(--floating-panel-scale));
  --analysis-tile-height: calc(3.18rem * var(--floating-panel-scale));
  --analysis-risk-height: calc(var(--analysis-tile-height) * 1.14);
  --analysis-risk-bars-width: calc(var(--analysis-tile-width) * 0.84);
  --analysis-count-bars-width: calc(var(--analysis-tile-width) - 1px);
  --analysis-chart-gap: calc(var(--analysis-tile-width) * 0.035);
  --analysis-scale-space: calc(2.45rem * var(--floating-panel-scale));
  position: relative;
  display: grid;
  gap: calc(var(--analysis-tile-width) * 0.1);
  padding-top: 0;
  overflow: visible;
}

.analysis-risk-grid {
  --analysis-risk-track-surface: rgba(255, 255, 255, 0.05);
}

.is-count-section .analysis-tiles-view,
.analysis-count-grid {
  height: 100%;
}

.analysis-count-grid {
  --analysis-count-row-min-height: calc((var(--analysis-tile-height) * 2) + var(--analysis-chart-gap));
  --analysis-count-row-max-height: calc((var(--analysis-tile-height) * 4) + var(--analysis-chart-gap));
  grid-template-rows:
    repeat(4, minmax(var(--analysis-count-row-min-height), var(--analysis-count-row-max-height)))
    auto;
  align-content: center;
  min-height: calc(
    (var(--analysis-count-row-min-height) * 4)
    + (var(--analysis-tile-width) * 0.5)
    + (var(--ui-text-caption) * 1.2)
  );
}

.analysis-tile-chart-row {
  position: relative;
  display: flex;
  width: max-content;
  padding-right: var(--analysis-scale-space);
  padding-bottom: calc(var(--analysis-tile-width) * 0.08);
}

.analysis-count-row {
  justify-content: center;
  width: max(100%, calc(var(--analysis-tile-width) * 9));
  height: 100%;
  padding-right: 0;
  padding-bottom: 0;
  border-bottom: 0;
}

.analysis-count-row .analysis-tile-sequence {
  position: relative;
  height: 100%;
  gap: var(--analysis-count-tile-gap, 1px);
}

.analysis-tile-sequence {
  display: flex;
  gap: 0;
}

.analysis-risk-tile,
.analysis-count-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 0 0 var(--analysis-tile-width);
  width: var(--analysis-tile-width);
  gap: var(--analysis-chart-gap);
}

.analysis-count-tile {
  height: 100%;
}

.analysis-tile-face {
  display: block;
  box-sizing: border-box;
  width: var(--analysis-tile-width);
  height: var(--analysis-tile-height);
  padding: calc(0.14rem * var(--floating-panel-scale));
  border-radius: calc(0.22rem * var(--floating-panel-scale));
  background: #fff;
  filter: brightness(92%) saturate(80%);
  box-shadow: inset 0 0 calc(0.12rem * var(--floating-panel-scale)) rgba(0, 0, 0, 0.9);
  user-select: none;
  -webkit-user-drag: none;
}

.analysis-risk-bars,
.analysis-count-bars {
  position: relative;
  display: flex;
  justify-content: center;
  gap: 0;
  overflow: hidden;
}

.analysis-risk-bars {
  align-items: flex-start;
  width: var(--analysis-risk-bars-width);
  height: var(--analysis-risk-height);
}

.analysis-count-bars {
  display: grid;
  grid-template-columns:
    repeat(3, minmax(0, 1fr))
    var(--analysis-count-wall-gap, 0px)
    minmax(0, 1fr);
  flex: 1 1 var(--analysis-tile-height);
  width: 100%;
  min-height: var(--analysis-tile-height);
  max-height: calc(var(--analysis-tile-height) * 3);
  gap: 0;
}

.analysis-count-bars > .source-wall {
  grid-column: 5;
}

.analysis-count-row-canvas {
  position: absolute;
  z-index: 0;
  top: 0;
  left: 0;
  display: block;
  width: 100%;
  height: calc(100% - var(--analysis-tile-height) - var(--analysis-chart-gap));
  pointer-events: none;
}

.analysis-risk-bars.has-adaptive-threshold::before,
.analysis-risk-bridge.has-adaptive-threshold::after {
  position: absolute;
  z-index: 0;
  right: 0;
  left: 0;
  top: var(--analysis-risk-threshold);
  border-top: 1px solid rgba(198, 214, 211, 0.42);
  content: '';
  pointer-events: none;
}

.analysis-risk-bars > i {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  background: var(--analysis-risk-track-surface);
  cursor: default;
}

.analysis-risk-bars > i > span {
  display: block;
  width: 100%;
  height: 100%;
  transform-origin: top center;
  transition: transform var(--ui-motion-duration) var(--ui-motion-easing);
}

.analysis-risk-bridge {
  position: absolute;
  z-index: 0;
  left: calc(50% + (var(--analysis-risk-bars-width) / 2));
  width: calc(var(--analysis-tile-width) - var(--analysis-risk-bars-width));
  pointer-events: none;
}

.analysis-risk-bridge {
  top: calc(var(--analysis-tile-height) + var(--analysis-chart-gap));
  height: var(--analysis-risk-height);
  background: rgba(255, 255, 255, 0.05);
}

.analysis-risk-scale {
  position: absolute;
  left: calc(100% - var(--analysis-scale-space) + (var(--analysis-tile-width) * 0.12));
  width: calc(var(--analysis-scale-space) * 0.88);
  color: rgba(210, 224, 221, 0.52);
  pointer-events: none;
}

.analysis-risk-scale {
  top: calc(var(--analysis-tile-height) + var(--analysis-chart-gap));
  height: var(--analysis-risk-height);
}

.analysis-risk-scale > span {
  position: absolute;
  left: 0;
  width: 100%;
  height: 0;
}

.analysis-risk-scale > span i {
  position: absolute;
  left: 0;
  width: calc(var(--analysis-tile-width) * 0.12);
  border-top: 1px solid rgba(198, 214, 211, 0.42);
}

.analysis-risk-scale > span small {
  position: absolute;
  left: calc(var(--analysis-tile-width) * 0.2);
  color: rgba(210, 224, 221, 0.56);
  font-size: var(--ui-text-caption);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
  transform: translateY(-50%);
}

.analysis-risk-bars > i.source-kamicha > span,
.analysis-source-legend i.source-kamicha { background: var(--ron-kamicha-color); }
.analysis-risk-bars > i.source-toimen > span,
.analysis-source-legend i.source-toimen { background: var(--ron-toimen-color); }
.analysis-risk-bars > i.source-shimocha > span,
.analysis-source-legend i.source-shimocha { background: var(--ron-shimocha-color); }
.analysis-source-legend i.source-wall { background: rgba(211, 226, 223, 0.68); }

.analysis-count-bars > button {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  width: 100%;
  min-width: 0;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: visible;
  border: 0;
  background: transparent;
  cursor: default;
}

.analysis-source-legend,
.analysis-count-legends {
  display: flex;
  justify-content: center;
  gap: calc(0.55rem * var(--floating-panel-scale));
  color: rgba(205, 224, 220, 0.72);
  font-size: var(--ui-text-caption);
}

.analysis-count-legends {
  justify-content: center;
  min-width: 0;
  padding: 0 calc(0.65rem * var(--floating-panel-scale));
}

.analysis-count-palette-legend {
  display: grid;
  grid-template-columns:
    fit-content(calc(4.5rem * var(--floating-panel-scale)))
    repeat(5, calc(0.64rem * var(--floating-panel-scale)));
  gap: calc(0.12rem * var(--floating-panel-scale)) calc(0.16rem * var(--floating-panel-scale));
  align-items: center;
  justify-content: center;
  max-width: 100%;
}

.analysis-count-palette-legend strong {
  overflow: hidden;
  padding-right: calc(0.18rem * var(--floating-panel-scale));
  color: rgba(213, 229, 225, 0.8);
  font-size: var(--ui-text-caption);
  font-weight: 400;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.analysis-count-palette-legend small {
  color: rgba(205, 224, 220, 0.66);
  font-size: var(--ui-text-caption);
  line-height: 1;
  text-align: center;
}

.analysis-count-palette-legend i {
  display: block;
  width: calc(0.64rem * var(--floating-panel-scale));
  height: calc(0.64rem * var(--floating-panel-scale));
}

.analysis-floating-tooltip {
  max-width: calc(100% - 1rem);
  transform: translateX(-50%);
  visibility: hidden;
}

.analysis-floating-tooltip.is-positioned {
  visibility: visible;
}

.analysis-floating-tooltip-line {
  color: var(--text-dim);
  white-space: nowrap;
}

.analysis-floating-tooltip .ui-hover-tooltip-row.has-bar {
  grid-template-columns:
    minmax(calc(4.5rem * var(--floating-panel-scale)), max-content)
    minmax(calc(4rem * var(--floating-panel-scale)), 1fr)
    calc(2.9rem * var(--floating-panel-scale));
  gap: calc(0.28rem * var(--floating-panel-scale));
  min-width: min(calc(14.5rem * var(--floating-panel-scale)), calc(100% - 1rem));
}

.analysis-floating-tooltip .ui-hover-tooltip-row.has-bar > :first-child {
  overflow: hidden;
  max-width: calc(7rem * var(--floating-panel-scale));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.analysis-tooltip-bar {
  display: block;
  height: calc(0.42rem * var(--floating-panel-scale));
  overflow: hidden;
  background: rgba(255, 255, 255, 0.06);
}

.analysis-tooltip-bar > span {
  display: block;
  height: 100%;
}

.reduce-motion *,
.reduce-motion *::before,
.reduce-motion *::after {
  transition: none !important;
  animation: none !important;
}
</style>
