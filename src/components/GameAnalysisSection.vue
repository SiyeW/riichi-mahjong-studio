<template>
  <section class="analysis-player-section">
    <div class="analysis-player-groups">
      <section v-perceptual-surface="offenseGroupSurface" class="analysis-player-group analysis-offense-group">
        <div class="analysis-player-group-heading"><strong>{{ t('analysis.winDealIn') }}</strong></div>
        <div class="analysis-outcome-strip" :aria-label="t('analysis.outcome')">
          <div v-perceptual-surface="outcomeTrackSurface" class="analysis-outcome-bar">
            <span
              v-for="segment in outcomeSegments"
              :key="segment.key"
              :class="`is-${segment.key}`"
              :style="{ width: `${segment.displayProbability * 100}%` }"
              tabindex="0"
              @mouseenter="showProbabilityTooltip($event, t('analysis.outcome'), segment.label, segment.probability)"
              @mouseleave="tooltip.clear"
              @focus="showProbabilityTooltip($event, t('analysis.outcome'), segment.label, segment.probability)"
              @blur="tooltip.clear"
            ><small v-if="segment.displayProbability >= 0.08">{{ formatProbability(segment.probability) }}</small></span>
          </div>
          <div class="analysis-outcome-legend">
            <span v-for="segment in outcomeSegments" :key="segment.key"><i :class="`is-${segment.key}`" />{{ segment.label }}</span>
          </div>
        </div>
        <div class="analysis-offense-axis-heading" aria-hidden="true">
          <span />
          <div class="analysis-offense-headings">
            <span>{{ t('analysis.dealInProbability') }} →</span>
            <span>← {{ t('analysis.winProbability') }}</span>
          </div>
        </div>
        <div v-for="player in playerRows" :key="player.seat" class="analysis-comparison-row analysis-offense-row">
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
              @mouseleave="tooltip.clear"
              @focus="showWinTooltip($event, player)"
              @blur="tooltip.clear"
            />
            <div
              class="analysis-offense-segment is-deal-in"
              tabindex="0"
              :style="{ width: `${player.dealInProbability * 100}%` }"
              @mouseenter="showDealInTooltip($event, player)"
              @mouseleave="tooltip.clear"
              @focus="showDealInTooltip($event, player)"
              @blur="tooltip.clear"
            />
            <small class="analysis-offense-value is-win" :style="offenseLabelStyle(player.seat, 'win')">{{ formatProbability(player.winProbability) }}</small>
            <small class="analysis-offense-value is-deal-in" :style="offenseLabelStyle(player.seat, 'dealIn')">{{ formatProbability(player.dealInProbability) }}</small>
          </div>
        </div>
      </section>

      <section v-perceptual-surface="deltaGroupSurface" class="analysis-player-group analysis-delta-group">
        <div class="analysis-player-group-heading"><strong>{{ t('analysis.kyokuDelta') }}</strong></div>
        <div v-for="player in playerRows" :key="player.seat" class="analysis-comparison-row analysis-delta-row">
          <span class="analysis-player-name">{{ player.label }}</span>
          <div
            v-perceptual-surface="deltaTrackSurface"
            class="analysis-delta-cell"
            tabindex="0"
            @mouseenter="showValueTooltip($event, player.label, t('analysis.kyokuDelta'), formatPoints(player.kyokuDelta))"
            @mouseleave="tooltip.clear"
            @focus="showValueTooltip($event, player.label, t('analysis.kyokuDelta'), formatPoints(player.kyokuDelta))"
            @blur="tooltip.clear"
          >
            <div class="analysis-zero-axis" />
            <span :class="(player.kyokuDelta ?? 0) >= 0 ? 'positive' : 'negative'" :style="deltaBarStyle(player.kyokuDelta)" />
            <small class="analysis-delta-value" :class="(player.kyokuDelta ?? 0) >= 0 ? 'opposite-positive' : 'opposite-negative'">{{ formatSignedCompactPoints(player.kyokuDelta) }}</small>
          </div>
        </div>
      </section>

      <section v-perceptual-surface="matchGroupSurface" class="analysis-player-group analysis-match-group">
        <div class="analysis-player-group-heading analysis-match-heading">
          <strong>{{ t('analysis.matchProjection') }}</strong>
          <span>{{ t('analysis.matchPlacement') }}</span>
          <span>{{ t('analysis.matchScore') }}</span>
        </div>
        <div v-for="player in playerRows" :key="player.seat" class="analysis-comparison-row analysis-match-row">
          <span class="analysis-player-name">{{ player.label }}</span>
          <div
            v-perceptual-surface="placementTrackSurface"
            class="analysis-placement-bar"
            tabindex="0"
            @mouseenter="showDistributionTooltip($event, player.label, t('analysis.matchPlacement'), player.placement, t('unit.place'))"
            @mouseleave="tooltip.clear"
            @focus="showDistributionTooltip($event, player.label, t('analysis.matchPlacement'), player.placement, t('unit.place'))"
            @blur="tooltip.clear"
          >
            <span v-for="segment in player.placement" :key="segment.value" :class="`rank-${segment.value}`" :style="{ width: `${segment.probability * 100}%` }" />
          </div>
          <small class="analysis-placement-value">{{ player.expectedPlacement }}</small>
          <span
            class="analysis-score-cell"
            tabindex="0"
            @mouseenter="showValueTooltip($event, player.label, t('analysis.matchScore'), formatPoints(player.matchScore))"
            @mouseleave="tooltip.clear"
            @focus="showValueTooltip($event, player.label, t('analysis.matchScore'), formatPoints(player.matchScore))"
            @blur="tooltip.clear"
          >{{ formatPlainPoints(player.matchScore) }}</span>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { analysisSurface } from '../analysisSurface'
import type { AnalysisPanelDataProps } from '../analysisPanelTypes'
import { deltaHalfWidthPercent } from '../analysisDeltaScale'
import { useAnalysisHoverTooltipController } from '../useAnalysisHoverTooltip'
import { useGameAnalysisData } from '../useGameAnalysisData'
import { useOffenseLabels } from '../useOffenseLabels'
import { useI18n } from '../i18n'
import type { DistributionEntry } from '../numericPrediction'
import { vPerceptualSurface, type PerceptualSurfaceBinding } from '../perceptualSurface'

const props = defineProps<AnalysisPanelDataProps & { perceptualSurface: PerceptualSurfaceBinding }>()
const { t, numberLocale } = useI18n()
const tooltip = useAnalysisHoverTooltipController()
const {
  outcomeSegments,
  playerRows,
  maxAbsoluteDelta,
  formatPoints,
  formatPlainPoints,
  formatSignedCompactPoints,
  formatProbability,
  windLabel,
} = useGameAnalysisData(props, t, numberLocale)

const offenseGroupSurface = analysisSurface(() => props.perceptualSurface, 'game-offense-group')
const outcomeTrackSurface = analysisSurface(() => props.perceptualSurface, 'game-outcome-track')
const offenseTrackSurface = analysisSurface(() => props.perceptualSurface, 'game-offense-track')
const deltaGroupSurface = analysisSurface(() => props.perceptualSurface, 'game-delta-group')
const deltaTrackSurface = analysisSurface(() => props.perceptualSurface, 'game-delta-track')
const matchGroupSurface = analysisSurface(() => props.perceptualSurface, 'game-match-group')
const placementTrackSurface = analysisSurface(() => props.perceptualSurface, 'game-placement-track')

const { offenseLabelPositions, offenseLabelStyle, setOffenseTrackElement } = useOffenseLabels(
  () => playerRows.value,
  true,
)

function deltaBarStyle(value: number | null) {
  const width = `${deltaHalfWidthPercent(value, maxAbsoluteDelta.value)}%`
  return value !== null && value < 0 ? { right: '50%', width } : { left: '50%', width }
}

function showProbabilityTooltip(event: Event, title: string, label: string, value: number) {
  tooltip.show(event, { title, lines: [], rows: [{ label, value: formatProbability(value) }] })
}
function showValueTooltip(event: Event, subject: string, label: string, value: string) {
  tooltip.show(event, { title: subject, lines: [], rows: [{ label, value }] })
}
function showDistributionTooltip(event: Event, subject: string, label: string, distribution: DistributionEntry[], unit: string) {
  tooltip.show(event, {
    title: `${subject} · ${label}`,
    lines: distribution.length ? [] : [t('analysis.noData')],
    rows: distribution.map((entry) => ({ label: `${entry.value}${unit}`, value: formatProbability(entry.probability) })),
  })
}
function showWinTooltip(event: Event, player: typeof playerRows.value[number]) {
  if (!player.targets.length) return showProbabilityTooltip(event, player.label, t('analysis.winProbability'), player.winProbability)
  tooltip.show(event, {
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
function showDealInTooltip(event: Event, player: typeof playerRows.value[number]) {
  if (!player.dealInWinnerSets.length) return showProbabilityTooltip(event, player.label, t('analysis.dealInProbability'), player.dealInProbability)
  const listFormatter = new Intl.ListFormat(numberLocale.value, { style: 'short', type: 'conjunction' })
  tooltip.show(event, {
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
</script>
