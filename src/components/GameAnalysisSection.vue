<template>
  <section ref="sectionElement" class="analysis-player-section">
    <canvas ref="canvasElement" class="analysis-game-canvas" aria-hidden="true" />
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
            :style="{
              '--analysis-win-probability': `${player.winProbability}`,
              '--analysis-deal-in-probability': `${player.dealInProbability}`,
            }"
          >
            <div
              class="analysis-offense-segment is-win"
              tabindex="0"
              :style="{ transform: `scaleX(${player.winProbability})` }"
              @mouseenter="showWinTooltip($event, player)"
              @mouseleave="tooltip.clear"
              @focus="showWinTooltip($event, player)"
              @blur="tooltip.clear"
            />
            <div
              class="analysis-offense-segment is-deal-in"
              tabindex="0"
              :style="{ transform: `scaleX(${player.dealInProbability})` }"
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
            <span v-for="segment in player.placement" :key="segment.value" :class="`rank-${segment.value}`" :style="{ width: `${segment.probability * 100}%` }">
              <small v-if="segment.probability >= 0.08">{{ formatProbability(segment.probability) }}</small>
            </span>
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
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { analysisSurface } from '../analysisSurface'
import type { AnalysisPanelDataProps } from '../analysisPanelTypes'
import { deltaHalfWidthPercent } from '../analysisDeltaScale'
import { useAnalysisHoverTooltipController } from '../useAnalysisHoverTooltip'
import { useGameAnalysisData } from '../useGameAnalysisData'
import { useOffenseLabels } from '../useOffenseLabels'
import { useI18n } from '../i18n'
import type { DistributionEntry } from '../numericPrediction'
import { vPerceptualSurface, type PerceptualSurfaceBinding } from '../perceptualSurface'
import { getUiMotionDurationMs, getUiMotionEasingFunction } from '../uiMotion'
import { useResponsiveGeometry } from '../useResponsiveGeometry'

const props = defineProps<AnalysisPanelDataProps & {
  perceptualSurface: PerceptualSurfaceBinding
  reduceMotion: boolean
}>()
type GameCanvasData = {
  outcome: number[]
  offense: Array<{ win: number; dealIn: number }>
  deltas: number[]
  placements: number[][]
}
type Rect = { left: number; top: number; right: number; bottom: number }
type GameCanvasGeometry = {
  width: number
  height: number
  outcome: Rect | null
  offense: Rect[]
  deltas: Rect[]
  placements: Rect[]
  outcomeColors: string[]
  offenseColors: Array<{ win: string; dealIn: string }>
  deltaColors: Array<{ positive: string; negative: string }>
  placementColors: string[][]
}
type GameCanvasElement = HTMLCanvasElement & { rmsGameAnalysisRenderSignature?: string }
const sectionElement = ref<HTMLElement | null>(null)
const canvasElement = ref<GameCanvasElement | null>(null)
let displayedCanvasData: GameCanvasData | null = null
let canvasGeometry: GameCanvasGeometry | null = null
let canvasAnimationFrame = 0
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
  relativeLabel,
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

function targetCanvasData(): GameCanvasData {
  return {
    outcome: outcomeSegments.value.map(segment => segment.displayProbability),
    offense: playerRows.value.map(player => ({
      win: player.winProbability,
      dealIn: player.dealInProbability,
    })),
    deltas: playerRows.value.map((player) => {
      const scale = deltaHalfWidthPercent(player.kyokuDelta, maxAbsoluteDelta.value) / 50
      return player.kyokuDelta !== null && player.kyokuDelta < 0 ? -scale : scale
    }),
    placements: playerRows.value.map(player => player.placement.map(segment => segment.probability)),
  }
}

function copyCanvasData(data: GameCanvasData): GameCanvasData {
  return {
    outcome: [...data.outcome],
    offense: data.offense.map(value => ({ ...value })),
    deltas: [...data.deltas],
    placements: data.placements.map(values => [...values]),
  }
}

function interpolateCanvasData(source: GameCanvasData, target: GameCanvasData, progress: number): GameCanvasData {
  const between = (from: number | undefined, to: number) => (from ?? to) + ((to - (from ?? to)) * progress)
  return {
    outcome: target.outcome.map((value, index) => between(source.outcome[index], value)),
    offense: target.offense.map((value, index) => ({
      win: between(source.offense[index]?.win, value.win),
      dealIn: between(source.offense[index]?.dealIn, value.dealIn),
    })),
    deltas: target.deltas.map((value, index) => between(source.deltas[index], value)),
    placements: target.placements.map((values, rowIndex) => values.map((value, index) => (
      between(source.placements[rowIndex]?.[index], value)
    ))),
  }
}

function relativeRect(element: Element, rootRect: DOMRect, ratio: number): Rect {
  const rect = element.getBoundingClientRect()
  return {
    left: Math.round((rect.left - rootRect.left) * ratio),
    top: Math.round((rect.top - rootRect.top) * ratio),
    right: Math.round((rect.right - rootRect.left) * ratio),
    bottom: Math.round((rect.bottom - rootRect.top) * ratio),
  }
}

function measureCanvasGeometry() {
  const section = sectionElement.value
  const canvas = canvasElement.value
  if (!section || !canvas) {
    canvasGeometry = null
    return
  }
  const rootRect = section.getBoundingClientRect()
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(rootRect.width * ratio))
  const height = Math.max(1, Math.round(rootRect.height * ratio))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const outcome = section.querySelector<HTMLElement>('.analysis-outcome-bar')
  const offense = [...section.querySelectorAll<HTMLElement>('.analysis-offense-track')]
  const deltas = [...section.querySelectorAll<HTMLElement>('.analysis-delta-cell')]
  const placements = [...section.querySelectorAll<HTMLElement>('.analysis-placement-bar')]
  const variable = (element: Element, name: string) => getComputedStyle(element).getPropertyValue(name).trim()
  canvasGeometry = {
    width,
    height,
    outcome: outcome ? relativeRect(outcome, rootRect, ratio) : null,
    offense: offense.map(element => relativeRect(element, rootRect, ratio)),
    deltas: deltas.map(element => relativeRect(element, rootRect, ratio)),
    placements: placements.map(element => relativeRect(element, rootRect, ratio)),
    outcomeColors: outcome ? [
      variable(outcome, '--analysis-self-win-color'),
      variable(outcome, '--analysis-self-deal-in-color'),
      variable(outcome, '--analysis-horizontal-color'),
      variable(outcome, '--analysis-draw-color'),
    ] : [],
    offenseColors: offense.map(element => ({
      win: variable(element, '--analysis-self-win-color'),
      dealIn: variable(element, '--analysis-self-deal-in-color'),
    })),
    deltaColors: deltas.map(element => ({
      positive: variable(element, '--analysis-self-win-color'),
      negative: variable(element, '--analysis-self-deal-in-color'),
    })),
    placementColors: placements.map(element => [4, 3, 2, 1].map(rank => variable(element, `--analysis-rank-${rank}-color`))),
  }
}

function fillSegments(context: CanvasRenderingContext2D, rect: Rect, values: readonly number[], colors: readonly string[]) {
  const width = rect.right - rect.left
  let cumulative = 0
  values.forEach((value, index) => {
    const left = rect.left + Math.round(cumulative * width)
    cumulative += Math.max(0, value)
    const right = index === values.length - 1
      ? rect.right
      : rect.left + Math.round(cumulative * width)
    if (right <= left || !colors[index]) return
    context.fillStyle = colors[index]
    context.fillRect(left, rect.top, right - left, rect.bottom - rect.top)
  })
}

function renderCanvas() {
  const canvas = canvasElement.value
  const geometry = canvasGeometry
  const data = displayedCanvasData
  if (!canvas || !geometry || !data) return
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, geometry.width, geometry.height)
  if (geometry.outcome) fillSegments(context, geometry.outcome, data.outcome, geometry.outcomeColors)
  geometry.offense.forEach((rect, index) => {
    const values = data.offense[index]
    const colors = geometry.offenseColors[index]
    if (!values || !colors) return
    const width = rect.right - rect.left
    const dealInWidth = Math.round(width * Math.max(0, Math.min(1, values.dealIn)))
    const winWidth = Math.round(width * Math.max(0, Math.min(1, values.win)))
    context.fillStyle = colors.dealIn
    context.fillRect(rect.left, rect.top, dealInWidth, rect.bottom - rect.top)
    context.fillStyle = colors.win
    context.fillRect(rect.right - winWidth, rect.top, winWidth, rect.bottom - rect.top)
  })
  geometry.deltas.forEach((rect, index) => {
    const value = Math.max(-1, Math.min(1, data.deltas[index] || 0))
    const colors = geometry.deltaColors[index]
    if (!colors || value === 0) return
    const center = Math.round((rect.left + rect.right) / 2)
    const width = Math.round(((rect.right - rect.left) / 2) * Math.abs(value))
    context.fillStyle = value < 0 ? colors.negative : colors.positive
    context.fillRect(value < 0 ? center - width : center, rect.top, width, rect.bottom - rect.top)
  })
  geometry.placements.forEach((rect, index) => {
    const values = data.placements[index]
    const colors = geometry.placementColors[index]
    if (values && colors) fillSegments(context, rect, values, colors)
  })
  canvas.rmsGameAnalysisRenderSignature = JSON.stringify(data, (_key, value) => (
    typeof value === 'number' ? Math.round(value * 10000) : value
  ))
}

function stopCanvasAnimation() {
  if (canvasAnimationFrame) cancelAnimationFrame(canvasAnimationFrame)
  canvasAnimationFrame = 0
}

function animateCanvas() {
  stopCanvasAnimation()
  const target = targetCanvasData()
  if (!displayedCanvasData || props.reduceMotion) {
    displayedCanvasData = copyCanvasData(target)
    renderCanvas()
    return
  }
  const source = copyCanvasData(displayedCanvasData)
  const duration = getUiMotionDurationMs()
  const easing = getUiMotionEasingFunction()
  let startedAt: number | null = null
  const step = (now: number) => {
    if (startedAt === null) startedAt = now
    const progress = Math.max(0, Math.min(1, (now - startedAt) / duration))
    displayedCanvasData = interpolateCanvasData(source, target, easing(progress))
    renderCanvas()
    if (progress < 1) canvasAnimationFrame = requestAnimationFrame(step)
    else canvasAnimationFrame = 0
  }
  canvasAnimationFrame = requestAnimationFrame(step)
}

function updateCanvasGeometry() {
  measureCanvasGeometry()
  renderCanvas()
}

useResponsiveGeometry(sectionElement, updateCanvasGeometry, { styleAncestorSelector: '.dock-module' })
watch(() => [props.analysis, props.controlledSeat, props.dealer, props.reduceMotion, props.perceptualSurface], () => {
  void nextTick(() => {
    measureCanvasGeometry()
    animateCanvas()
  })
}, { immediate: true, flush: 'post' })
onBeforeUnmount(stopCanvasAnimation)

function deltaBarStyle(value: number | null) {
  const scale = deltaHalfWidthPercent(value, maxAbsoluteDelta.value) / 50
  return value !== null && value < 0
    ? { right: '50%', transform: `scaleX(${scale})` }
    : { left: '50%', transform: `scaleX(${scale})` }
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
function outcomeSegmentColor(accent: string, index: number, count: number) {
  const accentShare = count <= 1 ? 100 : Math.round(100 - ((index / (count - 1)) * 68))
  return `color-mix(in srgb, ${accent} ${accentShare}%, #fff)`
}
function showWinTooltip(event: Event, player: typeof playerRows.value[number]) {
  if (!player.targets.length) return showProbabilityTooltip(event, player.label, t('analysis.winProbability'), player.winProbability)
  const targets = [...player.targets].filter(target => target.probability > 0).sort((left, right) => right.probability - left.probability)
  tooltip.show(event, {
    title: player.label,
    lines: [t('analysis.winTarget')],
    variant: 'outcome-detail',
    rows: targets.map((target, index) => ({
      label: target.seat === player.seat ? t('action.tsumo') : relativeLabel(target.seat),
      value: formatProbability(target.probability),
      proportion: target.probability,
      segmentColor: outcomeSegmentColor('var(--analysis-self-win-color)', index, targets.length),
    })),
  })
}
function showDealInTooltip(event: Event, player: typeof playerRows.value[number]) {
  if (!player.dealInWinnerSets.length) return showProbabilityTooltip(event, player.label, t('analysis.dealInProbability'), player.dealInProbability)
  const winnerSets = [...player.dealInWinnerSets]
    .filter(detail => detail.probability > 0)
    .sort((left, right) => right.probability - left.probability)
  tooltip.show(event, {
    title: player.label,
    lines: [t('analysis.dealInWinners')],
    variant: 'outcome-detail',
    rows: winnerSets.map((detail, index) => ({
      label: detail.winners.map(relativeLabel).join('＋'),
      value: formatProbability(detail.probability),
      proportion: detail.probability,
      segmentColor: outcomeSegmentColor('var(--analysis-self-deal-in-color)', index, winnerSets.length),
    })),
  })
}
</script>

<style scoped src="./GameAnalysisSection.css"></style>
