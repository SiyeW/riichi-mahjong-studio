<template>
  <section
    ref="sectionElement"
    v-perceptual-surface="opponentSurface"
    class="analysis-opponent-section"
    :style="scoreModeLayoutStyle"
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
          @slice-leave="tooltip.clear"
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
          @mouseleave="tooltip.clear"
          @focus="showPredictionTooltip($event, opponent.label, t('analysis.dora'), opponent.doraPrediction, t('unit.tile'))"
          @blur="tooltip.clear"
        >
          <div class="analysis-prediction-heading">
            <small>{{ t('analysis.dora') }}</small>
            <strong>{{ opponent.dora }}</strong>
          </div>
          <DistributionBarChart
            v-if="opponent.doraPrediction.distribution.length"
            class="analysis-dora-distribution"
            :entries="distributionEntries(opponent.doraPrediction.distribution, doraDistributionScale, true)"
            color-variable="--analysis-dora-color"
            :reduce-motion="reduceMotion"
            :show-labels="true"
            :track-surface="distributionTrackSurface"
            :reference-ratio="doraDistributionReferenceRatio"
            @item-enter="(event, index) => showDistributionEntryTooltip(event, opponent.label, t('analysis.dora'), opponent.doraPrediction.distribution, index, 'tile')"
            @item-leave="tooltip.clear"
          />
        </div>
        <div
          class="analysis-opponent-prediction is-score-prediction"
          tabindex="0"
          @mouseenter="showPredictionTooltip($event, opponent.label, t('analysis.score'), opponent.scorePrediction, t('unit.point'))"
          @mouseleave="tooltip.clear"
          @focus="showPredictionTooltip($event, opponent.label, t('analysis.score'), opponent.scorePrediction, t('unit.point'))"
          @blur="tooltip.clear"
        >
          <div class="analysis-prediction-heading">
            <small>{{ t('analysis.score') }}</small>
            <strong>{{ opponent.score }}</strong>
          </div>
          <DistributionBarChart
            v-if="opponent.scorePrediction.distribution.length"
            class="analysis-score-distribution"
            :entries="distributionEntries(opponent.scorePrediction.distribution, scoreDistributionScale, false)"
            color-variable="--analysis-score-color"
            :reduce-motion="reduceMotion"
            :show-labels="false"
            :track-surface="distributionTrackSurface"
            :reference-ratio="scoreDistributionReferenceRatio"
            @item-enter="(event, index) => showDistributionEntryTooltip(event, opponent.label, t('analysis.score'), opponent.scorePrediction.distribution, index, 'point')"
            @item-leave="tooltip.clear"
          />
          <div v-if="opponent.scoreModes.length" class="analysis-score-modes">
            <span
              v-for="entry in visibleScoreModes(opponent.scoreModes)"
              :key="entry.value"
              tabindex="0"
              :style="scoreModeStyle(entry.probability)"
              @mouseenter="showProbabilityTooltip($event, `${opponent.label} · ${t('analysis.score')}`, formatDistributionPoints(entry.value), entry.probability)"
              @mouseleave="tooltip.clear"
              @focus="showProbabilityTooltip($event, `${opponent.label} · ${t('analysis.score')}`, formatDistributionPoints(entry.value), entry.probability)"
              @blur="tooltip.clear"
            >
              {{ formatMahjongScore(entry.value) }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { analysisSurface } from '../analysisSurface'
import type { AnalysisPanelDataProps } from '../analysisPanelTypes'
import { scoreModeGeometry } from '../analysisScoreModeGeometry'
import type { AnalysisRecord } from '../useAnalysisOutputs'
import { useAnalysisHoverTooltipController } from '../useAnalysisHoverTooltip'
import { useOpponentAnalysisData } from '../useOpponentAnalysisData'
import { useI18n } from '../i18n'
import type { NumericPrediction } from '../numericPrediction'
import { vPerceptualSurface, type PerceptualSurfaceBinding } from '../perceptualSurface'
import { useResponsiveGeometry } from '../useResponsiveGeometry'
import DistributionBarChart, { type DistributionBarEntry } from './DistributionBarChart.vue'
import ShantenPieChart from './ShantenPieChart.vue'

const props = defineProps<{
  analysis: AnalysisRecord | null | undefined
  analysisOpponents: AnalysisPanelDataProps['analysisOpponents']
  shantenColors: string[]
  shantenLabels: string[]
  shantenShortLabels: string[]
  reduceMotion: boolean
  controlledSeat: number
  dealer: number
  perceptualSurface: PerceptualSurfaceBinding
}>()

const { t, numberLocale } = useI18n()
const tooltip = useAnalysisHoverTooltipController()
const sectionElement = ref<HTMLElement | null>(null)
const scoreModeCount = ref(3)
const scoreModeLayoutStyle = ref<Record<string, string>>({})
const scoreModeGapRem = 0.12
const opponentSurface = analysisSurface(() => props.perceptualSurface, 'opponent-panel')
const distributionTrackSurface = analysisSurface(
  () => props.perceptualSurface,
  'opponent-distribution-track',
  ['--analysis-distribution-track-surface'],
)

const {
  opponentCards,
  hasOpponentDoraDistributions,
  hasOpponentScoreDistributions,
  doraDistributionScale,
  scoreDistributionScale,
  doraDistributionReferenceRatio,
  scoreDistributionReferenceRatio,
  distributionBarScale,
  formatDistributionPoints,
  formatMahjongScore,
  formatProbability,
} = useOpponentAnalysisData(props, t, numberLocale)

const scoreModeMeasurementKey = computed(() => opponentCards.value.map((opponent) => (
  opponent.scoreModes.map((entry) => formatMahjongScore(entry.value)).join(',')
)).join('|'))

function visibleScoreModes(entries: NumericPrediction['distribution']) {
  return entries.slice(0, scoreModeCount.value)
}

function finitePixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function scoreModeIntrinsicWidths(sample: HTMLElement, labels: readonly string[]): ReadonlyMap<string, number> {
  const measurer = sample.cloneNode(false) as HTMLElement
  measurer.removeAttribute('tabindex')
  measurer.setAttribute('aria-hidden', 'true')
  Object.assign(measurer.style, {
    position: 'fixed',
    visibility: 'hidden',
    width: 'max-content',
    maxWidth: 'none',
    overflow: 'visible',
    textOverflow: 'clip',
    pointerEvents: 'none',
  })
  sample.parentElement?.appendChild(measurer)
  const widths = new Map<string, number>()
  for (const label of new Set(labels)) {
    measurer.textContent = label
    widths.set(label, measurer.getBoundingClientRect().width)
  }
  measurer.remove()
  return widths
}

function updateScoreModeCount() {
  const section = sectionElement.value
  if (!section) return
  const containers = [...section.querySelectorAll<HTMLElement>('.analysis-score-modes')]
  const sample = containers[0]?.querySelector<HTMLElement>('span')
  if (!containers.length || !sample) return

  const candidateCounts = opponentCards.value
    .map((opponent) => opponent.scoreModes.length)
    .filter((count) => count > 0)
  if (!candidateCounts.length) return
  const commonMaximum = Math.min(...candidateCounts)
  const availableWidth = Math.min(...containers.map((container) => container.getBoundingClientRect().width))
  if (!(availableWidth > 0)) return

  const labelsByOpponent = opponentCards.value.map((opponent) => (
    opponent.scoreModes.map((entry) => formatMahjongScore(entry.value))
  ))
  const labelWidths = scoreModeIntrinsicWidths(sample, labelsByOpponent.flat())
  const sectionStyle = getComputedStyle(section)
  const rootFontSize = finitePixels(getComputedStyle(document.documentElement).fontSize)
  const panelScale = finitePixels(sectionStyle.getPropertyValue('--floating-panel-scale')) || 1
  const desiredGap = scoreModeGapRem * rootFontSize * panelScale
  const pixelRatio = window.devicePixelRatio
  let geometry = scoreModeGeometry({
    availableWidth,
    minimumItemWidth: 1,
    desiredGap,
    maximumCount: 1,
    pixelRatio,
  })
  for (let candidateCount = commonMaximum; candidateCount >= 1; candidateCount -= 1) {
    const visibleLabels = labelsByOpponent.flatMap((labels) => labels.slice(0, candidateCount))
    const minimumItemWidth = visibleLabels.reduce((widest, label) => (
      Math.max(widest, labelWidths.get(label) || 0)
    ), 0)
    const candidate = scoreModeGeometry({
      availableWidth,
      minimumItemWidth,
      desiredGap,
      maximumCount: candidateCount,
      pixelRatio,
    })
    if (candidate.count !== candidateCount) continue
    geometry = candidate
    break
  }
  scoreModeCount.value = geometry.count
  scoreModeLayoutStyle.value = {
    '--analysis-score-mode-columns': geometry.columns.map((width) => `${width.toFixed(6)}px`).join(' '),
    '--analysis-score-mode-gap': `${geometry.gap.toFixed(6)}px`,
  }
}

const scheduleScoreModeCount = useResponsiveGeometry(sectionElement, updateScoreModeCount, {
  resizeAncestorSelector: '.dock-module',
  styleAncestorSelector: '.dock-module',
})

watch([scoreModeMeasurementKey, numberLocale], () => {
  void nextTick(scheduleScoreModeCount)
}, { flush: 'post' })

function scoreModeStyle(probability: number): Record<string, string> {
  const normalized = distributionBarScale(probability, scoreDistributionScale.value)
  const strength = 12 + (normalized * 50)
  return { '--analysis-score-mode-strength': `${strength.toFixed(1)}%` }
}

function showProbabilityTooltip(event: Event, title: string, label: string, value: number) {
  tooltip.show(event, { title, lines: [], rows: [{ label, value: formatProbability(value) }] })
}

function distributionEntries(
  distribution: NumericPrediction['distribution'],
  scale: number,
  includeLabels: boolean,
): DistributionBarEntry[] {
  return distribution.map(entry => ({
    key: entry.value,
    scale: distributionBarScale(entry.probability, scale),
    label: includeLabels ? String(entry.value) : undefined,
  }))
}

function showDistributionEntryTooltip(
  event: Event,
  subject: string,
  label: string,
  distribution: NumericPrediction['distribution'],
  index: number,
  valueKind: 'tile' | 'point',
) {
  const entry = distribution[index]
  if (!entry) return
  const value = valueKind === 'point'
    ? formatDistributionPoints(entry.value)
    : `${entry.value}${t('unit.tile')}`
  showProbabilityTooltip(event, `${subject} · ${label}`, value, entry.probability)
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
  tooltip.show(event, { title: `${subject} · ${label}`, lines: [scalar], rows: [] })
}
</script>

<style scoped src="./OpponentAnalysisSection.css"></style>
