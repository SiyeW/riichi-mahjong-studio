<template>
  <section
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
              @mouseleave="tooltip.clear"
              @focus="showProbabilityTooltip($event, `${opponent.label} · ${t('analysis.dora')}`, `${entry.value}${t('unit.tile')}`, entry.probability)"
              @blur="tooltip.clear"
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
          @mouseleave="tooltip.clear"
          @focus="showPredictionTooltip($event, opponent.label, t('analysis.score'), opponent.scorePrediction, t('unit.point'))"
          @blur="tooltip.clear"
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
              @mouseleave="tooltip.clear"
              @focus="showProbabilityTooltip($event, `${opponent.label} · ${t('analysis.score')}`, formatDistributionPoints(entry.value), entry.probability)"
              @blur="tooltip.clear"
            ><span :style="{ height: distributionBarHeight(entry.probability, scoreDistributionScale) }" /></i>
          </div>
          <div v-if="opponent.scoreModes.length" class="analysis-score-modes">
            <span
              v-for="entry in opponent.scoreModes"
              :key="entry.value"
              tabindex="0"
              @mouseenter="showProbabilityTooltip($event, `${opponent.label} · ${t('analysis.score')}`, formatDistributionPoints(entry.value), entry.probability)"
              @mouseleave="tooltip.clear"
              @focus="showProbabilityTooltip($event, `${opponent.label} · ${t('analysis.score')}`, formatDistributionPoints(entry.value), entry.probability)"
              @blur="tooltip.clear"
            >
              {{ formatDistributionPoints(entry.value) }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { analysisSurface } from '../analysisSurface'
import type { AnalysisPanelDataProps } from '../analysisPanelTypes'
import type { AnalysisRecord } from '../useAnalysisOutputs'
import { useAnalysisHoverTooltipController } from '../useAnalysisHoverTooltip'
import { useOpponentAnalysisData } from '../useOpponentAnalysisData'
import { useI18n } from '../i18n'
import type { NumericPrediction } from '../numericPrediction'
import { vPerceptualSurface, type PerceptualSurfaceBinding } from '../perceptualSurface'
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
  distributionBarHeight,
  formatDistributionPoints,
  formatProbability,
} = useOpponentAnalysisData(props, t, numberLocale)

function showProbabilityTooltip(event: Event, title: string, label: string, value: number) {
  tooltip.show(event, { title, lines: [], rows: [{ label, value: formatProbability(value) }] })
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
