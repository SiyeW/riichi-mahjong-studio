<template>
  <section
    ref="sectionElement"
    v-perceptual-surface="opponentSurface"
    class="analysis-opponent-section"
    :class="{ 'has-distributions': hasOpponentDoraDistributions || hasOpponentScoreDistributions }"
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
      <div class="analysis-shanten-legend" :aria-label="t('analysis.shantenLegend')">
        <span v-for="(label, index) in shantenLabels" :key="label">
          <i :style="{ backgroundColor: shantenColors[index] }" />
          <span class="analysis-shanten-legend-label">{{ index === shantenLabels.length - 1 ? t('shanten.furitenLegend') : label }}</span>
        </span>
      </div>
    </div>
    <div
      class="analysis-opponent-prediction-grid"
      :class="{
        'has-dora-distributions': hasOpponentDoraDistributions,
        'has-score-distributions': hasOpponentScoreDistributions,
      }"
    >
      <div v-for="(opponent, index) in opponentCards" :key="opponent.key" class="analysis-opponent-predictions">
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
          <!-- Preserve canvas owners, not old predictions. Empty charts have
               no data cells; the last may retain the group's shared axis. -->
          <DistributionBarChart
            v-show="opponent.doraPrediction.distribution.length || (index === 2 && hasOpponentDoraDistributions)"
            class="analysis-dora-distribution"
            :entries="distributionEntries(opponent.doraPrediction.distribution, doraDistributionScale, true)"
            color-variable="--analysis-dora-color"
            :reduce-motion="reduceMotion"
            :show-labels="true"
            :track-surface="distributionTrackSurface"
            :reference-ratio="doraDistributionReferenceRatio"
            :probability-scale="doraDistributionScale"
            :show-axis="index === 2"
            :outside-axis="true"
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
            v-show="opponent.scorePrediction.distribution.length || (index === 2 && hasOpponentScoreDistributions)"
            class="analysis-score-distribution"
            :entries="scoreDistributionEntries(opponent.scorePrediction.distribution, opponent.seat === dealer)"
            color-variable="--analysis-score-color"
            :reduce-motion="reduceMotion"
            :show-labels="false"
            :track-surface="distributionTrackSurface"
            :reference-ratio="scoreDistributionReferenceRatio"
            :probability-scale="scoreDistributionScale"
            :show-axis="index === 2"
            :outside-axis="true"
            @item-enter="(event, index) => showDistributionEntryTooltip(event, opponent.label, t('analysis.score'), opponent.scorePrediction.distribution, index, 'point')"
            @item-leave="tooltip.clear"
          />
          <div v-if="opponent.scoreModes.length || hasOpponentScoreDistributions" class="analysis-score-modes">
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
      <div class="analysis-opponent-scale-gutter" aria-hidden="true">
        <span v-for="label in percentageLabels" :key="label">{{ label }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { analysisSurface } from '../analysisSurface'
import { probabilityScaleTicks } from '../analysisProbabilityScale'
import type { AnalysisPanelDataProps } from '../analysisPanelTypes'
import { scoreModeGeometry } from '../analysisScoreModeGeometry'
import type { AnalysisRecord } from '../useAnalysisOutputs'
import { useAnalysisHoverTooltipController } from '../useAnalysisHoverTooltip'
import {
  scoreDistributionGroupStarts,
  selectScoreModeNominations,
  useOpponentAnalysisData,
} from '../useOpponentAnalysisData'
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

const percentageLabels = computed(() => [...new Set(
  [doraDistributionScale.value, scoreDistributionScale.value]
    .flatMap(scale => probabilityScaleTicks(scale).map(tick => tick.label).filter(Boolean)),
)])

const scoreModeMeasurementKey = computed(() => opponentCards.value.map((opponent) => (
  opponent.scoreModes.map((entry) => formatMahjongScore(entry.value)).join(',')
)).join('|'))

function visibleScoreModes(entries: NumericPrediction['distribution']) {
  return selectScoreModeNominations(entries, scoreModeCount.value)
}

function finitePixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

let scoreWidthStyle = ''
let scoreWidths = new Map<string, number>()

function scoreModeIntrinsicWidths(sample: HTMLElement, labels: readonly string[]): ReadonlyMap<string, number> {
  const style = getComputedStyle(sample)
  const signature = [style.font, style.fontVariantNumeric, style.fontFeatureSettings,
    style.fontVariationSettings, style.letterSpacing, style.wordSpacing, style.textTransform,
    style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].join('|')
  if (signature !== scoreWidthStyle) { scoreWidthStyle = signature; scoreWidths.clear() }
  const unique = [...new Set(labels)]
  const fragment = document.createDocumentFragment()
  const measurers = unique.filter(label => !scoreWidths.has(label)).map(label => {
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
    measurer.textContent = label
    fragment.appendChild(measurer)
    return { label, measurer }
  })
  if (measurers.length) sample.parentElement?.appendChild(fragment)
  try {
    // Read every intrinsic width before removing any probe. Interleaving each
    // text write with a measurement forces one global layout per score value.
    for (const { label, measurer } of measurers) scoreWidths.set(label, measurer.getBoundingClientRect().width)
    // Retain only the current distribution's labels, not every value ever seen.
    scoreWidths = new Map(unique.map(label => [label, scoreWidths.get(label) || 0]))
    return scoreWidths
  } finally {
    for (const { measurer } of measurers) measurer.remove()
  }
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

  const labelWidths = scoreModeIntrinsicWidths(sample, opponentCards.value.flatMap((opponent) => (
    opponent.scoreModes.map((entry) => formatMahjongScore(entry.value))
  )))
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
    const visibleLabels = opponentCards.value.flatMap((opponent) => (
      selectScoreModeNominations(opponent.scoreModes, candidateCount)
        .map((entry) => formatMahjongScore(entry.value))
    ))
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
function resetScoreWidths() { scoreWidths.clear(); scheduleScoreModeCount() }
document.fonts?.addEventListener('loadingdone', resetScoreWidths)
onBeforeUnmount(() => document.fonts?.removeEventListener('loadingdone', resetScoreWidths))

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

function scoreDistributionEntries(
  distribution: NumericPrediction['distribution'],
  dealer: boolean,
): DistributionBarEntry[] {
  const groupStarts = scoreDistributionGroupStarts(distribution, dealer)
  return distribution.map((entry, index) => ({
    key: entry.value,
    scale: distributionBarScale(entry.probability, scoreDistributionScale.value),
    gapBefore: groupStarts[index],
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
