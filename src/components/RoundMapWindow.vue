<template>
  <section
    class="analysis-float-panel round-map-window"
    :style="{ '--floating-panel-scale': scale, zIndex }"
    @mousedown="emit('focus')"
    @focusin="emit('focus')"
  >
    <div class="floating-panel-header" @mousedown="emit('start-drag', $event)">
      <span>{{ t('roundMap.title') }}</span>
      <div class="floating-panel-header-actions">
        <button class="floating-panel-close" :aria-label="t('roundMap.close')" @click="emit('close')">
          &times;
        </button>
      </div>
    </div>
    <div class="round-map-panel-body">
      <div class="round-map-body">
        <div v-if="dots.length" class="round-map-scroll" @wheel.stop>
          <div class="round-map-canvas">
            <div v-if="rows.length" class="round-map-axis" :style="{ height: `${svgHeight}px` }">
              <div
                v-for="row in rows"
                :key="row.key"
                class="round-map-axis-label"
                :style="{ top: `${row.y}px` }"
              >
                {{ row.label }}
              </div>
            </div>
            <svg class="round-map-svg" :width="svgWidth" :height="svgHeight">
              <line
                :x1="baseX"
                y1="0"
                :x2="baseX"
                :y2="svgHeight"
                stroke="rgba(159,213,200,0.18)"
                stroke-width="1"
              />
              <path
                v-for="edge in edges"
                :key="`${edge.from}-${edge.to}`"
                :d="edge.d"
                fill="none"
                :stroke="edge.stroke"
                :stroke-width="edge.width"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <rect
                v-for="region in hitRegions"
                :key="`round-map-hit-${region.dot.id}`"
                :x="region.x"
                :y="region.y"
                :width="region.width"
                :height="region.height"
                class="round-map-hit-region"
                @mouseenter="emit('update:hoveredRoundId', region.dot.id)"
                @mouseleave="emit('update:hoveredRoundId', null)"
                @click="emit('jump', region.dot.id)"
              />
              <circle
                v-for="dot in dots"
                :key="dot.id"
                :cx="dot.x"
                :cy="dot.y"
                :r="6 * scale"
                :class="['round-map-dot', dot.isCurrent ? 'is-current' : '', dot.isMainline ? 'is-mainline' : '', hoveredRoundId === dot.id ? 'is-hovered' : '']"
                :fill="dot.fill"
                :stroke="dot.isCurrent ? 'white' : (dot.isMainline ? 'rgba(220,244,240,0.4)' : 'none')"
                :stroke-width="(dot.isCurrent ? 1.5 : (dot.isMainline ? 0.8 : 0)) * scale"
              />
            </svg>
          </div>
        </div>
        <p v-else class="empty-copy">—</p>
      </div>
      <div class="round-map-settlement">
        <div class="round-map-settlement-heading">
          <span>{{ settlementRoundLabel }}</span>
          <strong>{{ settlementTitle }}</strong>
        </div>
        <div class="result-score-map round-map-score-map">
          <div
            v-for="entry in settlementLayout"
            :key="`round-map-score-${entry.seat}`"
            :class="['result-score-card', `is-${entry.position}`, { 'is-empty': !entry.hasScores }]"
            role="group"
            :aria-label="entry.showDelta ? t('result.scoreAria', { player: entry.label, rank: entry.rank ?? t('analysis.noData'), before: entry.before, delta: formatDelta(entry.delta), after: entry.after }) : (entry.hasScores ? t('result.scoreOnlyAria', { player: entry.label, score: entry.after }) : entry.label)"
          >
            <span class="result-score-heading">
              <strong class="result-score-seat">{{ entry.label }}</strong>
              <span v-if="entry.rank !== null" class="result-score-rank">{{ entry.rank }}</span>
            </span>
            <span v-if="entry.showDelta" class="result-score-values">
              <span>{{ entry.before }}</span>
              <span :class="{ positive: entry.delta > 0, negative: entry.delta < 0 }">
                {{ entry.delta === 0 ? '' : formatDelta(entry.delta) }}
              </span>
              <strong>{{ entry.after }}</strong>
            </span>
            <strong v-else-if="entry.hasScores" class="round-map-score-current">{{ entry.after }}</strong>
            <span v-else class="round-map-score-empty">—</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { GraphHitRegion } from '../graphHitRegions'
import type {
  RoundMapDotLayout,
  RoundMapEdgeLayout,
  RoundMapRowLayout,
  RoundMapSettlementEntry,
} from '../useRoundMapPresentation'
import { useI18n } from '../i18n'

defineProps<{
  baseX: number
  dots: RoundMapDotLayout[]
  edges: RoundMapEdgeLayout[]
  hitRegions: GraphHitRegion<RoundMapDotLayout>[]
  hoveredRoundId: string | null
  rows: RoundMapRowLayout[]
  scale: number
  settlementLayout: RoundMapSettlementEntry[]
  settlementRoundLabel: string
  settlementTitle: string
  svgHeight: number
  svgWidth: number
  zIndex: number
  formatDelta: (delta: number) => string
}>()

const emit = defineEmits<{
  close: []
  focus: []
  jump: [roundRootId: string]
  'start-drag': [event: MouseEvent]
  'update:hoveredRoundId': [roundRootId: string | null]
}>()
const { t } = useI18n()
</script>

<style scoped>
.round-map-window {
  top: calc(4rem * var(--floating-panel-scale));
  right: calc(1.25rem * var(--floating-panel-scale));
  bottom: auto;
  width: min(calc(56rem * var(--floating-panel-scale)), 94vw);
  max-height: calc(100vh - var(--footer-min-h) - 2rem * var(--floating-panel-scale));
  overflow: hidden;
}

.round-map-panel-body {
  display: grid;
  grid-template-columns: clamp(
    calc(10rem * var(--floating-panel-scale)),
    26%,
    calc(14rem * var(--floating-panel-scale))
  ) minmax(0, 1fr);
  gap: calc(0.8rem * var(--floating-panel-scale));
  align-items: stretch;
  min-height: calc(15rem * var(--floating-panel-scale));
  padding-top: calc(0.55rem * var(--floating-panel-scale));
}

.round-map-body {
  position: relative;
  min-height: 0;
  min-width: 0;
}

.round-map-canvas {
  display: flex;
  align-items: flex-start;
  column-gap: calc(0.3rem * var(--chrome-scale));
  width: max-content;
  min-width: 100%;
}

.round-map-axis {
  position: relative;
  flex: 0 0 calc(2.875rem * var(--ui-scale));
  align-self: flex-start;
}

.round-map-axis-label {
  position: absolute;
  right: 0;
  transform: translateY(-50%);
  font-size: var(--ui-text-body);
  color: var(--text-dim);
  white-space: nowrap;
}

.round-map-scroll {
  position: relative;
  width: 100%;
  min-width: 0;
  max-height: min(60vh, calc(28.75rem * var(--ui-scale)));
  overflow: auto;
  padding: 0;
  background: transparent;
  border: 0;
}

.round-map-window .round-map-scroll {
  height: 100%;
  max-height: min(72vh, calc(30rem * var(--floating-panel-scale)));
  background: rgba(0, 29, 35, 0.34);
}

.round-map-svg {
  flex: 1 0 auto;
  display: block;
  background:
    linear-gradient(to right, rgba(255, 255, 255, 0.03) 0, rgba(255, 255, 255, 0.03) 1px, transparent 1px, transparent calc(1.125rem * var(--ui-scale)));
}

.round-map-dot {
  pointer-events: none;
  transition:
    filter var(--ui-motion-duration) var(--ui-motion-easing),
    transform var(--ui-motion-duration) var(--ui-motion-easing);
}

.round-map-dot.is-current {
  filter: drop-shadow(0 0 2px rgba(255, 255, 255, 0.42));
}

.round-map-dot.is-hovered {
  filter: brightness(1.25);
}

.round-map-hit-region {
  fill: transparent;
  pointer-events: all;
  cursor: pointer;
}

.round-map-settlement {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: calc(0.65rem * var(--floating-panel-scale));
  background: rgba(0, 29, 35, 0.34);
}

.round-map-settlement-heading {
  display: flex;
  flex-direction: column;
  flex: 0 0 calc(3rem * var(--floating-panel-scale));
  height: calc(3rem * var(--floating-panel-scale));
  min-height: calc(3rem * var(--floating-panel-scale));
  gap: calc(0.25rem * var(--floating-panel-scale));
  color: var(--text-dim);
  font-size: var(--ui-text-caption);
}

.round-map-settlement-heading strong {
  color: var(--text-main);
  font-size: var(--ui-text-control);
  font-weight: 700;
}

.round-map-score-map {
  flex: 1;
  align-content: center;
  margin-top: 0;
  padding-top: calc(0.55rem * var(--floating-panel-scale));
}

.round-map-score-map .result-score-values {
  gap: calc(0.35rem * var(--floating-panel-scale));
  line-height: calc(1.2rem * var(--chrome-scale));
}

.round-map-score-map .result-score-card {
  display: flex;
  flex-direction: column;
  justify-content: center;
  height: calc(3.4rem * var(--chrome-scale));
  min-height: calc(3.4rem * var(--chrome-scale));
  overflow: visible;
}

.round-map-score-current {
  display: block;
  color: var(--text-main);
  font-size: var(--ui-text-control);
  line-height: calc(1.2rem * var(--chrome-scale));
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}

.round-map-score-map .result-score-card.is-empty {
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.02);
}

.round-map-score-empty {
  display: block;
  color: var(--text-muted);
  font-size: var(--ui-text-control);
  line-height: calc(1.2rem * var(--chrome-scale));
  text-align: center;
}
</style>
