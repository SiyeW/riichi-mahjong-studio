<template>
  <div class="unified-analysis" :class="{ 'reduce-motion': reduceMotion }">
    <div class="analysis-view-tabs" role="tablist" :aria-label="t('analysis.view')">
      <button
        type="button"
        role="tab"
        :aria-selected="activeView === 'situation'"
        :class="{ selected: activeView === 'situation' }"
        @click="activeView = 'situation'"
      >{{ t('analysis.situation') }}</button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeView === 'tiles'"
        :class="{ selected: activeView === 'tiles' }"
        @click="activeView = 'tiles'"
      >{{ t('analysis.tiles') }}</button>
    </div>

    <div v-if="activeView === 'situation'" class="analysis-situation-view">
      <section class="analysis-opponent-section">
        <div class="analysis-section-heading">{{ t('analysis.opponents') }}</div>
        <div class="analysis-opponent-grid">
          <div v-for="opponent in opponentCards" :key="opponent.key" class="analysis-opponent-card">
            <ShantenPieChart
              :label="opponent.label"
              :probabilities="opponent.probabilities"
              :colors="shantenColors"
              :slice-labels="shantenLabels"
              :short-labels="shantenShortLabels"
              :reduce-motion="reduceMotion"
              @slice-enter="(label, probability) => showProbability(`${opponent.label} - ${label}`, probability)"
              @slice-leave="clearHover"
            />
            <div class="analysis-opponent-estimates">
              <span :title="opponent.doraTitle"><small>{{ t('analysis.dora') }}</small>{{ opponent.dora }}</span>
              <span :title="opponent.scoreTitle"><small>{{ t('analysis.score') }}</small>{{ opponent.score }}</span>
            </div>
          </div>
        </div>
        <div class="analysis-shanten-legend" :aria-label="t('analysis.shantenLegend')">
          <span v-for="(label, index) in shantenLabels" :key="label">
            <i :style="{ backgroundColor: shantenColors[index] }" />{{ label }}
          </span>
        </div>
      </section>

      <section class="analysis-player-section">
        <div class="analysis-section-heading">{{ t('analysis.players') }}</div>
        <div class="analysis-outcome-strip" :aria-label="t('analysis.outcome')">
          <div class="analysis-outcome-bar">
            <span
              v-for="segment in outcomeSegments"
              :key="segment.key"
              :class="`is-${segment.key}`"
              :style="{ width: `${segment.displayProbability * 100}%` }"
              :title="`${segment.label} ${formatProbability(segment.probability)}`"
            ><small v-if="segment.displayProbability >= 0.08">{{ formatProbability(segment.probability) }}</small></span>
          </div>
          <div class="analysis-outcome-legend">
            <span v-for="segment in outcomeSegments" :key="segment.key">
              <i :class="`is-${segment.key}`" />{{ segment.label }}
            </span>
          </div>
        </div>

        <div class="analysis-player-table">
          <div class="analysis-player-row analysis-player-header" aria-hidden="true">
            <span>{{ t('analysis.player') }}</span><span>{{ t('analysis.win') }}</span><span>{{ t('analysis.dealIn') }}</span><span>{{ t('analysis.kyokuDelta') }}</span><span>{{ t('analysis.matchPlacement') }}</span><span>{{ t('analysis.matchScore') }}</span>
          </div>
          <div v-for="player in playerRows" :key="player.seat" class="analysis-player-row">
            <strong class="analysis-player-name">{{ player.label }}</strong>
            <div
              class="analysis-player-probability is-win"
              @mouseenter="hoveredWinnerSeat = player.seat"
              @mouseleave="hoveredWinnerSeat = null"
            >
              <span :style="{ width: `${player.winProbability * 100}%` }" />
              <small>{{ formatProbability(player.winProbability) }}</small>
              <div v-if="hoveredWinnerSeat === player.seat" class="analysis-target-popover">
                <strong>{{ t('analysis.winTarget', { player: player.label }) }}</strong>
                <div v-for="target in player.targets" :key="target.seat">
                  <small>{{ target.label }}</small>
                  <i><span :style="{ width: `${target.probability * 100}%` }" /></i>
                  <em>{{ formatProbability(target.probability) }}</em>
                </div>
              </div>
            </div>
            <div class="analysis-player-probability is-deal-in" :title="formatProbability(player.dealInProbability)">
              <span :style="{ width: `${player.dealInProbability * 100}%` }" />
              <small>{{ formatProbability(player.dealInProbability) }}</small>
            </div>
            <div class="analysis-delta-cell" :title="formatPoints(player.kyokuDelta)">
              <div class="analysis-zero-axis" />
              <span
                :class="player.kyokuDelta >= 0 ? 'positive' : 'negative'"
                :style="deltaBarStyle(player.kyokuDelta)"
              />
              <small>{{ formatSignedCompactPoints(player.kyokuDelta) }}</small>
            </div>
            <div class="analysis-placement-cell" :title="player.placementTitle">
              <div class="analysis-placement-bar">
                <span
                  v-for="segment in player.placement"
                  :key="segment.value"
                  :class="`rank-${segment.value}`"
                  :style="{ width: `${segment.probability * 100}%` }"
                />
              </div>
              <small>{{ player.expectedPlacement }}</small>
            </div>
            <span class="analysis-score-cell" :title="formatPoints(player.matchScore)">{{ formatPlainPoints(player.matchScore) }}</span>
          </div>
        </div>
      </section>
    </div>

    <div v-else class="analysis-tiles-view">
      <div class="analysis-tile-mode-tabs" role="tablist" :aria-label="t('analysis.tileContent')">
        <button :class="{ selected: tileMode === 'risk' }" @click="tileMode = 'risk'">{{ t('analysis.risk') }}</button>
        <button :class="{ selected: tileMode === 'counts' }" @click="tileMode = 'counts'">{{ t('analysis.countDistribution') }}</button>
      </div>

      <div v-if="tileMode === 'risk'" class="analysis-risk-grid">
        <div v-for="row in tileRows" :key="row[0]" class="analysis-risk-row">
          <div v-for="tile in row" :key="tile" class="analysis-risk-tile">
            <img :src="tileImageSrc(tile)" :alt="tileFaceLabel(tile)" />
            <div class="analysis-risk-bars">
              <i
                v-for="source in opponentSources"
                :key="source.key"
                :class="`source-${source.key}`"
                :title="`${source.label} - ${tileFaceLabel(tile)} - ${formatProbability(riskProbability(source.seat, tile))}`"
              ><span :style="{ height: `${riskBarHeight(riskProbability(source.seat, tile))}%` }" /></i>
            </div>
          </div>
        </div>
        <div class="analysis-source-legend">
          <span v-for="source in opponentSources" :key="source.key"><i :class="`source-${source.key}`" />{{ source.label }}</span>
        </div>
      </div>

      <div v-else class="analysis-count-grid">
        <div v-for="row in tileRows" :key="row[0]" class="analysis-count-row">
          <div v-for="tile in row" :key="tile" class="analysis-count-tile">
            <img :src="tileImageSrc(tile)" :alt="tileFaceLabel(tile)" />
            <div class="analysis-count-bars">
              <button
                v-for="source in countSources"
                :key="source.key"
                type="button"
                :class="`source-${source.key}`"
                :aria-label="t('analysis.tileCountDistribution', { source: source.label, tile: tileFaceLabel(tile) })"
                @mouseenter="showCountTooltip(tile, source)"
                @mouseleave="countTooltip = null"
              >
                <span
                  v-for="segment in countSegments(tile, source)"
                  :key="segment.value"
                  :class="`count-${segment.value}`"
                  :style="{ height: `${segment.probability * 100}%` }"
                />
              </button>
            </div>
          </div>
        </div>
        <div class="analysis-count-legends">
          <div class="analysis-source-legend">
            <span v-for="source in countSources" :key="source.key"><i :class="`source-${source.key}`" />{{ source.label }}</span>
          </div>
          <div class="analysis-count-legend">
            <span v-for="value in [0, 1, 2, 3, 4]" :key="value"><i :class="`count-${value}`" />{{ t('analysis.countUnit', { value }) }}</span>
          </div>
        </div>
        <div v-if="countTooltip" class="analysis-count-tooltip">
          <strong>{{ countTooltip.sourceLabel }} · {{ tileFaceLabel(countTooltip.tile) }}</strong>
          <span>{{ t('analysis.expectedCount', { value: countTooltip.expected.toFixed(2) }) }}</span>
          <div v-for="segment in countTooltip.segments" :key="segment.value">
            <small>{{ t('analysis.countUnit', { value: segment.value }) }}</small>
            <i><span :class="`count-${segment.value}`" :style="{ width: `${segment.probability * 100}%` }" /></i>
            <em>{{ formatProbability(segment.probability) }}</em>
          </div>
        </div>
      </div>
    </div>

    <p class="analysis-hover-readout" :class="{ visible: hoverText }">{{ hoverText || '\u00a0' }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '../i18n'
import ShantenPieChart from './ShantenPieChart.vue'

const { t, numberLocale } = useI18n()

type AnalysisRecord = Record<string, unknown>
type DistributionEntry = { value: number; probability: number }
type NumericPrediction = { distribution: DistributionEntry[]; expectedValue: number | null }
type TileSource = { key: string; label: string; seat: number | null }

const props = defineProps<{
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
}>()

const activeView = ref<'situation' | 'tiles'>('situation')
const tileMode = ref<'risk' | 'counts'>('risk')
const hoverText = ref('')
const hoveredWinnerSeat = ref<number | null>(null)
const countTooltip = ref<{
  tile: string
  sourceLabel: string
  expected: number
  segments: DistributionEntry[]
} | null>(null)

const tileRows = [
  ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m'],
  ['1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p'],
  ['1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s'],
  ['E', 'S', 'W', 'N', 'P', 'F', 'C'],
]

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

function playerOutput(outputId: string, seat: number): AnalysisRecord {
  return outputPlayers(outputId).find((player) => Number(player.seat) === seat) || {}
}

function parsePrediction(value: unknown): NumericPrediction {
  const source = objectValue(value)
  const distribution = Array.isArray(source.distribution)
    ? source.distribution.map((entry) => objectValue(entry)).map((entry) => ({
      value: finiteNumber(entry.value),
      probability: probability(entry.probability),
    }))
    : []
  const rawExpected = Number(source.expectedValue)
  const expectedValue = Number.isFinite(rawExpected)
    ? rawExpected
    : (distribution.length
      ? distribution.reduce((sum, entry) => sum + (entry.value * entry.probability), 0)
      : null)
  return { distribution, expectedValue }
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

function formatProbability(value: number): string {
  const percentage = probability(value) * 100
  if (percentage === 0) return '0%'
  if (percentage < 0.01) return '<0.01%'
  return `${percentage.toFixed(1)}%`
}

function predictionTitle(prediction: NumericPrediction, unit: string): string {
  const expected = prediction.expectedValue === null
    ? t('analysis.noExpectedValue')
    : t('analysis.expectedValue', { value: prediction.expectedValue.toFixed(2), unit })
  if (!prediction.distribution.length) return expected
  return `${expected}；${prediction.distribution.map((entry) => `${entry.value}${unit} ${formatProbability(entry.probability)}`).join('，')}`
}

const opponentCards = computed(() => props.shantenOpponents.map((opponent) => {
  const dora = seatPrediction('opponent-dora-count', opponent.seat)
  const score = seatPrediction('opponent-score', opponent.seat)
  return {
    ...opponent,
    dora: dora.expectedValue === null ? '—' : dora.expectedValue.toFixed(1),
    score: formatCompactPoints(score.expectedValue),
    doraTitle: predictionTitle(dora, t('unit.tile')),
    scoreTitle: predictionTitle(score, t('unit.point')),
  }
}))

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
  return [winnerSeat, (winnerSeat + 1) % 4, (winnerSeat + 2) % 4, (winnerSeat + 3) % 4].map((seat) => {
    const entry = raw.find((item) => Number(item.seat) === seat)
    return {
      seat,
      label: seat === winnerSeat ? t('action.tsumo') : windLabel(seat),
      probability: probability(entry?.probability),
    }
  })
}

const kyokuPlayers = computed(() => outputPlayers('kyoku-outcome'))
const outcomeSegments = computed(() => {
  const draw = probability(outputData('kyoku-outcome').drawProbability)
  const self = kyokuPlayers.value.find((player) => Number(player.seat) === props.controlledSeat) || {}
  const selfWin = probability(self.winProbability)
  const selfDealIn = probability(self.dealInProbability)
  const horizontal = Math.max(0, 1 - draw - selfWin - selfDealIn)
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
  props.controlledSeat,
  (props.controlledSeat + 3) % 4,
  (props.controlledSeat + 2) % 4,
  (props.controlledSeat + 1) % 4,
])

const playerRows = computed(() => playerSeatOrder.value.map((seat) => {
  const outcome = kyokuPlayers.value.find((player) => Number(player.seat) === seat) || {}
  const delta = seatPrediction('kyoku-score-delta', seat)
  const placement = seatPrediction('match-placement', seat)
  const matchScore = seatPrediction('match-score', seat)
  const normalizedPlacement = [1, 2, 3, 4].map((value) => ({
    value,
    probability: placement.distribution.find((entry) => entry.value === value)?.probability || 0,
  }))
  return {
    seat,
    label: windLabel(seat),
    winProbability: probability(outcome.winProbability),
    dealInProbability: probability(outcome.dealInProbability),
    targets: targetRows(outcome, seat),
    kyokuDelta: delta.expectedValue,
    placement: normalizedPlacement,
    expectedPlacement: placement.expectedValue === null ? '—' : placement.expectedValue.toFixed(2),
    placementTitle: predictionTitle(placement, t('unit.place')),
    matchScore: matchScore.expectedValue,
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

function showProbability(label: string, value: number) {
  hoverText.value = `${label} - ${formatProbability(value)}`
}

function clearHover() {
  hoverText.value = ''
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

const riskScale = computed(() => Math.max(
  0.2,
  ...opponentSources.value.flatMap((source) => tileRows.flatMap((row) => (
    row.map((tile) => riskProbability(source.seat, tile))
  ))),
))

function riskBarHeight(value: number): number {
  return Math.min(100, (probability(value) / riskScale.value) * 100)
}

function tilePrediction(tile: string, source: TileSource): NumericPrediction {
  if (source.seat === null) {
    return parsePrediction(objectValue(outputData('wall-tile-count').tiles)[tile])
  }
  const player = playerOutput('opponent-concealed-tile-count', source.seat)
  return parsePrediction(objectValue(player.tiles)[tile])
}

function countSegments(tile: string, source: TileSource): DistributionEntry[] {
  const prediction = tilePrediction(tile, source)
  const values = [0, 1, 2, 3, 4].map((value) => ({
    value,
    probability: prediction.distribution.find((entry) => entry.value === value)?.probability || 0,
  }))
  const total = values.reduce((sum, entry) => sum + entry.probability, 0)
  if (total > 0) return values.map((entry) => ({ ...entry, probability: entry.probability / total }))
  const rounded = Math.max(0, Math.min(4, Math.round(prediction.expectedValue || 0)))
  return values.map((entry) => ({ ...entry, probability: entry.value === rounded ? 1 : 0 }))
}

function showCountTooltip(tile: string, source: TileSource) {
  const prediction = tilePrediction(tile, source)
  countTooltip.value = {
    tile,
    sourceLabel: source.label,
    expected: prediction.expectedValue || 0,
    segments: countSegments(tile, source),
  }
}
</script>

<style scoped>
.unified-analysis {
  --analysis-border: rgba(140, 195, 188, 0.16);
  --analysis-surface: rgba(0, 29, 35, 0.28);
  --analysis-soft-surface: rgba(0, 20, 25, 0.26);
  width: 100%;
  max-width: none;
  color: rgba(238, 247, 244, 0.92);
  font-size: calc(0.78rem * var(--floating-panel-scale));
}

button {
  font: inherit;
}

.analysis-view-tabs,
.analysis-tile-mode-tabs {
  display: flex;
  gap: calc(0.28rem * var(--floating-panel-scale));
  padding: calc(0.45rem * var(--floating-panel-scale)) 0;
  border-bottom: 1px solid var(--analysis-border);
}

.analysis-view-tabs button,
.analysis-tile-mode-tabs button {
  min-width: calc(4rem * var(--floating-panel-scale));
  padding: calc(0.26rem * var(--floating-panel-scale)) calc(0.72rem * var(--floating-panel-scale));
  border: 1px solid rgba(140, 195, 188, 0.2);
  border-radius: calc(3px * var(--floating-panel-scale));
  color: rgba(213, 232, 228, 0.78);
  background: rgba(3, 48, 57, 0.68);
  cursor: pointer;
}

.analysis-view-tabs button:hover,
.analysis-tile-mode-tabs button:hover {
  color: rgba(244, 250, 248, 0.96);
  background: rgba(9, 74, 84, 0.78);
}

.analysis-view-tabs button.selected,
.analysis-tile-mode-tabs button.selected {
  border-color: rgba(61, 157, 99, 0.58);
  color: #f5fbf8;
  background: rgba(23, 122, 70, 0.88);
}

.analysis-situation-view {
  display: grid;
  grid-template-rows: auto auto;
  gap: calc(0.48rem * var(--floating-panel-scale));
  padding-top: calc(0.48rem * var(--floating-panel-scale));
}

.analysis-opponent-section,
.analysis-player-section {
  min-width: 0;
  border: 1px solid var(--analysis-border);
  background: var(--analysis-surface);
}

.analysis-section-heading {
  padding: calc(0.28rem * var(--floating-panel-scale)) calc(0.42rem * var(--floating-panel-scale));
  border-bottom: 1px solid var(--analysis-border);
  color: rgba(232, 243, 240, 0.88);
  font-size: calc(0.8rem * var(--floating-panel-scale));
  font-weight: 600;
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
  font-size: calc(0.86rem * var(--floating-panel-scale));
}

.analysis-opponent-estimates {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  width: 100%;
  margin-top: calc(0.24rem * var(--floating-panel-scale));
  border-top: 1px solid rgba(140, 195, 188, 0.11);
}

.analysis-opponent-estimates span {
  display: flex;
  justify-content: center;
  align-items: baseline;
  gap: calc(0.22rem * var(--floating-panel-scale));
  min-width: 0;
  padding-top: calc(0.24rem * var(--floating-panel-scale));
  color: rgba(244, 249, 247, 0.94);
  font-size: calc(0.8rem * var(--floating-panel-scale));
  font-variant-numeric: tabular-nums;
}

.analysis-opponent-estimates span + span {
  border-left: 1px solid rgba(140, 195, 188, 0.1);
}

.analysis-opponent-estimates small {
  color: rgba(186, 211, 207, 0.68);
  font-size: calc(0.65rem * var(--floating-panel-scale));
}

.analysis-shanten-legend {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: calc(0.18rem * var(--floating-panel-scale)) calc(0.48rem * var(--floating-panel-scale));
  padding: calc(0.3rem * var(--floating-panel-scale)) calc(0.38rem * var(--floating-panel-scale));
  border-top: 1px solid var(--analysis-border);
  color: rgba(205, 224, 220, 0.7);
  font-size: calc(0.64rem * var(--floating-panel-scale));
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
  grid-template-columns: minmax(0, 1fr) max-content;
  gap: calc(0.5rem * var(--floating-panel-scale));
  align-items: center;
  padding: calc(0.36rem * var(--floating-panel-scale)) calc(0.42rem * var(--floating-panel-scale));
  border-bottom: 1px solid var(--analysis-border);
}

.analysis-outcome-bar {
  display: flex;
  height: calc(0.86rem * var(--floating-panel-scale));
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
  font-size: calc(0.56rem * var(--floating-panel-scale));
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.45);
  white-space: nowrap;
}

.is-draw { background: #2c8fc5; }
.is-self-win { background: #4caf50; }
.is-self-deal-in { background: #c9554d; }
.is-horizontal { background: #d39a3a; }

.analysis-outcome-legend {
  display: flex;
  gap: calc(0.4rem * var(--floating-panel-scale));
  color: rgba(207, 226, 221, 0.72);
  font-size: calc(0.62rem * var(--floating-panel-scale));
}

.analysis-player-table {
  padding: 0 calc(0.36rem * var(--floating-panel-scale)) calc(0.34rem * var(--floating-panel-scale));
}

.analysis-player-row {
  display: grid;
  grid-template-columns:
    calc(5.5rem * var(--floating-panel-scale))
    minmax(calc(3.2rem * var(--floating-panel-scale)), 0.85fr)
    minmax(calc(3.2rem * var(--floating-panel-scale)), 0.85fr)
    minmax(calc(4.1rem * var(--floating-panel-scale)), 1fr)
    minmax(calc(4.5rem * var(--floating-panel-scale)), 1.15fr)
    calc(4.2rem * var(--floating-panel-scale));
  gap: calc(0.32rem * var(--floating-panel-scale));
  align-items: center;
  min-height: calc(2rem * var(--floating-panel-scale));
  border-bottom: 1px solid rgba(140, 195, 188, 0.09);
}

.analysis-player-row:last-child {
  border-bottom: 0;
}

.analysis-player-header {
  min-height: calc(1.65rem * var(--floating-panel-scale));
  color: rgba(190, 213, 209, 0.66);
  font-size: calc(0.62rem * var(--floating-panel-scale));
  text-align: center;
}

.analysis-player-header span:first-child {
  text-align: left;
}

.analysis-player-name {
  overflow: hidden;
  color: rgba(232, 243, 240, 0.86);
  font-size: calc(0.7rem * var(--floating-panel-scale));
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.analysis-player-probability {
  position: relative;
  height: calc(0.72rem * var(--floating-panel-scale));
  background: rgba(255, 255, 255, 0.055);
}

.analysis-player-probability > span {
  display: block;
  height: 100%;
  transition: width var(--ui-motion-duration) var(--ui-motion-easing);
}

.analysis-player-probability > small {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(240, 248, 246, 0.86);
  font-size: calc(0.57rem * var(--floating-panel-scale));
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.45);
  pointer-events: none;
}

.analysis-player-probability.is-win > span { background: #2f9bd6; }
.analysis-player-probability.is-deal-in > span { background: #c95d43; }

.analysis-target-popover,
.analysis-count-tooltip {
  position: absolute;
  z-index: 12;
  width: calc(13rem * var(--floating-panel-scale));
  padding: calc(0.48rem * var(--floating-panel-scale));
  border: 1px solid rgba(140, 195, 188, 0.34);
  border-radius: calc(3px * var(--floating-panel-scale));
  background: rgba(1, 34, 41, 0.98);
  box-shadow: 0 calc(0.3rem * var(--floating-panel-scale)) calc(1rem * var(--floating-panel-scale)) rgba(0, 0, 0, 0.34);
  color: rgba(230, 242, 238, 0.9);
  pointer-events: none;
}

.analysis-target-popover {
  left: 50%;
  bottom: calc(100% + (0.35rem * var(--floating-panel-scale)));
  transform: translateX(-50%);
}

.analysis-target-popover strong,
.analysis-count-tooltip strong {
  display: block;
  margin-bottom: calc(0.35rem * var(--floating-panel-scale));
  font-size: calc(0.7rem * var(--floating-panel-scale));
}

.analysis-target-popover > div,
.analysis-count-tooltip > div {
  display: grid;
  grid-template-columns: calc(3.2rem * var(--floating-panel-scale)) 1fr calc(2.9rem * var(--floating-panel-scale));
  gap: calc(0.28rem * var(--floating-panel-scale));
  align-items: center;
  min-height: calc(1.1rem * var(--floating-panel-scale));
}

.analysis-target-popover small,
.analysis-count-tooltip small {
  overflow: hidden;
  color: rgba(196, 219, 214, 0.76);
  font-size: calc(0.62rem * var(--floating-panel-scale));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.analysis-target-popover i,
.analysis-count-tooltip i {
  display: block;
  height: calc(0.42rem * var(--floating-panel-scale));
  overflow: hidden;
  background: rgba(255, 255, 255, 0.06);
}

.analysis-target-popover i span,
.analysis-count-tooltip i span {
  display: block;
  height: 100%;
  background: #2f9bd6;
}

.analysis-target-popover em,
.analysis-count-tooltip em {
  color: rgba(225, 238, 234, 0.8);
  font-size: calc(0.6rem * var(--floating-panel-scale));
  font-style: normal;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.analysis-delta-cell,
.analysis-placement-cell {
  position: relative;
  display: flex;
  align-items: center;
  height: calc(0.78rem * var(--floating-panel-scale));
  background: rgba(255, 255, 255, 0.045);
}

.analysis-zero-axis {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  border-left: 1px solid rgba(205, 225, 221, 0.22);
}

.analysis-delta-cell > span {
  position: absolute;
  top: calc(0.17rem * var(--floating-panel-scale));
  bottom: calc(0.17rem * var(--floating-panel-scale));
}

.analysis-delta-cell > span.positive { background: #55ae65; }
.analysis-delta-cell > span.negative { background: #cf544e; }

.analysis-delta-cell small {
  position: absolute;
  left: 50%;
  top: 50%;
  color: rgba(246, 250, 249, 0.9);
  font-size: calc(0.58rem * var(--floating-panel-scale));
  line-height: 1;
  transform: translate(-50%, -50%);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
  font-variant-numeric: tabular-nums;
}

.analysis-placement-cell {
  gap: calc(0.24rem * var(--floating-panel-scale));
  background: none;
}

.analysis-placement-bar {
  display: flex;
  flex: 1;
  height: 100%;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.045);
}

.analysis-placement-bar span { height: 100%; }
.rank-1 { background: #238ec8; }
.rank-2 { background: #4aa7d5; }
.rank-3 { background: #78b9d5; }
.rank-4 { background: #9baeb2; }

.analysis-placement-cell small,
.analysis-score-cell {
  color: rgba(229, 241, 237, 0.84);
  font-size: calc(0.62rem * var(--floating-panel-scale));
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.analysis-tiles-view {
  position: relative;
}

.analysis-tile-mode-tabs {
  padding-top: calc(0.36rem * var(--floating-panel-scale));
}

.analysis-risk-grid,
.analysis-count-grid {
  position: relative;
  display: grid;
  gap: calc(0.35rem * var(--floating-panel-scale));
  padding-top: calc(0.45rem * var(--floating-panel-scale));
}

.analysis-risk-row,
.analysis-count-row {
  display: grid;
  grid-template-columns: repeat(9, minmax(0, 1fr));
  gap: calc(0.12rem * var(--floating-panel-scale));
  min-height: calc(6rem * var(--floating-panel-scale));
  padding-bottom: calc(0.28rem * var(--floating-panel-scale));
  border-bottom: 1px solid rgba(140, 195, 188, 0.1);
}

.analysis-risk-row:last-of-type,
.analysis-count-row:last-of-type {
  border-bottom: 0;
}

.analysis-risk-tile,
.analysis-count-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: calc(0.12rem * var(--floating-panel-scale));
}

.analysis-risk-tile img,
.analysis-count-tile img {
  box-sizing: border-box;
  width: calc(2.35rem * var(--floating-panel-scale));
  height: calc(3.05rem * var(--floating-panel-scale));
  padding: calc(0.14rem * var(--floating-panel-scale));
  border-radius: calc(0.22rem * var(--floating-panel-scale));
  box-shadow: inset 0 0 calc(0.12rem * var(--floating-panel-scale)) rgba(0, 0, 0, 0.9);
}

.analysis-risk-bars,
.analysis-count-bars {
  display: flex;
  justify-content: center;
  gap: calc(0.06rem * var(--floating-panel-scale));
  height: calc(2.55rem * var(--floating-panel-scale));
}

.analysis-risk-bars > i,
.analysis-count-bars > button {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  width: calc(0.44rem * var(--floating-panel-scale));
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 0;
  background: rgba(255, 255, 255, 0.05);
  cursor: default;
}

.analysis-risk-bars > i > span {
  display: block;
  width: 100%;
  transition: height var(--ui-motion-duration) var(--ui-motion-easing);
}

.analysis-risk-bars > i.source-kamicha > span,
.analysis-source-legend i.source-kamicha { background: var(--ron-kamicha-color); }
.analysis-risk-bars > i.source-toimen > span,
.analysis-source-legend i.source-toimen { background: var(--ron-toimen-color); }
.analysis-risk-bars > i.source-shimocha > span,
.analysis-source-legend i.source-shimocha { background: var(--ron-shimocha-color); }
.analysis-source-legend i.source-wall { background: rgba(211, 226, 223, 0.68); }

.analysis-count-bars > button > span {
  display: block;
  flex: 0 0 auto;
  width: 100%;
  min-height: 0;
}

.analysis-count-bars > button::after {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: calc(0.12rem * var(--floating-panel-scale));
  content: '';
}

.analysis-count-bars > button.source-kamicha::after { background: var(--ron-kamicha-color); }
.analysis-count-bars > button.source-toimen::after { background: var(--ron-toimen-color); }
.analysis-count-bars > button.source-shimocha::after { background: var(--ron-shimocha-color); }
.analysis-count-bars > button.source-wall::after { background: rgba(211, 226, 223, 0.68); }

.count-0 { background: #cfe9ff !important; }
.count-1 { background: #8fcfff !important; }
.count-2 { background: #39a6ff !important; }
.count-3 { background: #0077cc !important; }
.count-4 { background: #004f80 !important; }

.analysis-source-legend,
.analysis-count-legend,
.analysis-count-legends {
  display: flex;
  justify-content: center;
  gap: calc(0.55rem * var(--floating-panel-scale));
  color: rgba(205, 224, 220, 0.72);
  font-size: calc(0.64rem * var(--floating-panel-scale));
}

.analysis-count-legends {
  justify-content: space-between;
  padding: 0 calc(0.65rem * var(--floating-panel-scale));
}

.analysis-count-tooltip {
  right: calc(0.5rem * var(--floating-panel-scale));
  bottom: calc(1.6rem * var(--floating-panel-scale));
}

.analysis-count-tooltip > span {
  display: block;
  margin-bottom: calc(0.25rem * var(--floating-panel-scale));
  color: rgba(194, 218, 213, 0.76);
  font-size: calc(0.64rem * var(--floating-panel-scale));
}

.analysis-hover-readout {
  min-height: calc(1rem * var(--floating-panel-scale));
  margin: calc(0.2rem * var(--floating-panel-scale)) 0 0;
  color: rgba(224, 238, 234, 0.82);
  font-size: calc(0.68rem * var(--floating-panel-scale));
  line-height: 1;
  text-align: center;
  visibility: hidden;
}

.analysis-hover-readout.visible { visibility: visible; }

.reduce-motion *,
.reduce-motion *::before,
.reduce-motion *::after {
  transition: none !important;
  animation: none !important;
}
</style>
