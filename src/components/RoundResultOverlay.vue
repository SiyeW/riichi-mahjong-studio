<template>
  <div
    v-if="gameView.table?.resultInfo"
    class="result-overlay"
    @contextmenu.stop.prevent="continueFromResult"
  >
    <div class="result-overlay-card">
      <div class="result-overlay-header">
        <h3>{{ localizedResultTitle(gameView.table.resultInfo.title, t) }}</h3>
        <div v-if="resultHasHora" class="result-overlay-indicators">
          <div class="result-indicator-group">
            <span class="result-indicator-tiles">
              <img
                v-for="(tile, index) in resultDoraSlots"
                :key="`result-dora-${index}`"
                class="tileImg result-indicator-tile"
                :src="tileImageSrc(tile)"
                :alt="tile === '?' ? t('result.unrevealedDora') : t('result.doraIndicator', { tile: tileFaceLabel(tile) })"
              />
            </span>
          </div>
          <div class="result-indicator-group">
            <span class="result-indicator-tiles">
              <img
                v-for="(tile, index) in resultUraSlots"
                :key="`result-ura-${index}`"
                class="tileImg result-indicator-tile"
                :src="tileImageSrc(tile)"
                :alt="tile === '?' ? t('result.unrevealedUra') : t('result.uraIndicator', { tile: tileFaceLabel(tile) })"
              />
            </span>
          </div>
        </div>
      </div>
      <div v-if="resultYakuItems.length" class="result-overlay-yaku">
        <span v-for="(yaku, index) in resultYakuItems" :key="`${yaku.name}-${index}`" class="result-yaku-item">
          <span class="result-yaku-name">{{ yaku.label }}</span>
          <strong v-if="formatResultYakuValue(yaku)">{{ formatResultYakuValue(yaku) }}</strong>
        </span>
      </div>
      <div v-if="resultHanFuLabel || resultPointsLabel || resultHandLabel" class="result-overlay-hand-value">
        <span v-if="resultHanFuLabel" class="result-hanfu">{{ resultHanFuLabel }}</span>
        <strong v-if="resultPointsLabel" class="result-points">{{ resultPointsLabel }}</strong>
        <span v-if="resultHandLabel" class="result-hand-label">{{ resultHandLabel }}</span>
      </div>
      <div class="result-score-map">
        <div
          v-for="entry in resultScoreLayout"
          :key="`result-score-${entry.seat}`"
          :class="['result-score-card', `is-${entry.position}`]"
          role="group"
          :aria-label="t('result.scoreAria', { player: entry.label, rank: entry.rank, before: entry.before, delta: formatDelta(entry.delta), after: entry.after })"
        >
          <span class="result-score-heading">
            <strong class="result-score-seat">{{ entry.label }}</strong>
            <span class="result-score-rank">{{ entry.rank }}</span>
          </span>
          <strong v-if="resultIsMatchEnd" class="result-final-score">{{ entry.after }}</strong>
          <span v-else class="result-score-values">
            <span>{{ entry.before }}</span>
            <span :class="{ positive: entry.delta > 0, negative: entry.delta < 0 }">{{ entry.delta === 0 ? '' : formatDelta(entry.delta) }}</span>
            <strong>{{ entry.after }}</strong>
          </span>
        </div>
      </div>
      <button
        v-if="!resultIsMatchEnd"
        class="result-dismiss-btn"
        :aria-disabled="isReadOnlyRecord || status.mode !== 'play'"
        @click="emit('advance')"
      >
        {{ isReadOnlyRecord ? t('common.readOnly') : t('common.continue') }}
      </button>
      <button v-else class="result-dismiss-btn" @click="emit('show-round-map')">
        {{ t('roundMap.title') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatDelta } from '../useDecisionPresentation'
import { useI18n } from '../i18n'
import { localizedResultTitle, useRoundResultPresentation } from '../useRoundResultPresentation'

const props = defineProps<{
  gameView: TrainerGameView
  status: TrainerStatusSnapshot
  isReadOnlyRecord: boolean
  relativeSeatLabel: (seat: number) => string
  tileFaceLabel: (tile: string) => string
  tileImageSrc: (tile: string) => string
}>()

const emit = defineEmits<{
  advance: []
  'show-round-map': []
}>()

const { t } = useI18n()
const {
  formatResultYakuValue,
  resultDoraSlots,
  resultHandLabel,
  resultHanFuLabel,
  resultHasHora,
  resultIsMatchEnd,
  resultPointsLabel,
  resultScoreLayout,
  resultUraSlots,
  resultYakuItems,
} = useRoundResultPresentation({
  gameView: props.gameView,
  status: props.status,
  t,
  relativeSeatLabel: props.relativeSeatLabel,
})

function continueFromResult() {
  if (!resultIsMatchEnd.value) emit('advance')
}
</script>

<style scoped>
.result-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  pointer-events: none;
}

.result-overlay-card {
  pointer-events: auto;
  width: min(calc(38rem * var(--chrome-scale)), 94%);
  max-width: none;
  padding: var(--overlay-card-padding);
  background: var(--overlay-card-bg);
  border: var(--overlay-card-border);
  box-shadow: var(--overlay-card-shadow);
  display: flex;
  flex-direction: column;
  gap: 0;
}

.result-overlay-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(1rem * var(--chrome-scale));
  margin-bottom: calc(0.24rem * var(--chrome-scale));
}

.result-overlay h3 {
  margin: 0;
  font-size: var(--ui-text-display);
  line-height: var(--ui-text-display);
}

.result-overlay-indicators {
  display: flex;
  align-items: center;
  gap: calc(1rem * var(--chrome-scale));
  margin-left: auto;
}

.result-indicator-group {
  display: flex;
  align-items: center;
  min-width: 0;
}

.result-indicator-tiles {
  display: flex;
  align-items: center;
}

.result-indicator-tile {
  --mahjong-tile-artwork-width: calc(1.545rem * var(--ui-scale));
  width: calc(1.545rem * var(--ui-scale));
  height: calc(2rem * var(--ui-scale));
}

.result-overlay-hand-value {
  display: flex;
  align-items: baseline;
  justify-content: flex-start;
  gap: calc(0.8rem * var(--chrome-scale));
  margin: calc(0.42rem * var(--chrome-scale)) 0 calc(0.36rem * var(--chrome-scale));
  padding: calc(0.55rem * var(--chrome-scale)) calc(0.70rem * var(--chrome-scale));
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(140, 190, 185, 0.10);
}

.result-overlay-hand-value > * + * {
  padding-left: calc(0.8rem * var(--chrome-scale));
  border-left: 1px solid rgba(140, 190, 185, 0.16);
}

.result-hanfu {
  color: var(--text-main);
  font-weight: 600;
  font-size: var(--ui-text-heading);
}

.result-points {
  color: #ffd979;
  font-size: var(--ui-text-title);
  transform: translateY(calc(0.06rem * var(--chrome-scale)));
}

.result-hand-label {
  color: #ffd979;
  font-size: var(--ui-text-heading);
  font-weight: 700;
}

.result-overlay-yaku {
  display: flex;
  flex-wrap: wrap;
  gap: calc(0.30rem * var(--chrome-scale));
  margin: calc(0.36rem * var(--chrome-scale)) 0 calc(0.12rem * var(--chrome-scale));
}

.result-yaku-item {
  display: inline-flex;
  align-items: baseline;
  gap: calc(0.35rem * var(--chrome-scale));
  padding: calc(0.26rem * var(--chrome-scale)) calc(0.50rem * var(--chrome-scale));
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(140, 190, 185, 0.08);
  color: var(--text-main);
  font-size: var(--ui-text-control);
}

.result-yaku-item strong {
  color: #ffd979;
  font-size: var(--ui-text-body);
  white-space: nowrap;
}

.result-final-score {
  display: block;
  color: var(--text-main);
  font-size: var(--ui-text-heading);
  line-height: calc(1.35rem * var(--chrome-scale));
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}

.result-dismiss-btn {
  margin-top: calc(0.75rem * var(--chrome-scale));
  padding: calc(0.55rem * var(--chrome-scale)) 0;
  width: 100%;
  border: 1px solid rgba(140, 190, 185, 0.18);
  background: rgba(8, 80, 94, 0.7);
  color: var(--text-main);
  font-size: var(--ui-text-control);
  cursor: pointer;
  transition: background var(--ui-motion-duration) var(--ui-motion-easing);
}

.result-dismiss-btn:hover {
  background: rgba(12, 105, 120, 0.85);
}
</style>
