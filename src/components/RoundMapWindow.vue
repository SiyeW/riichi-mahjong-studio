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
