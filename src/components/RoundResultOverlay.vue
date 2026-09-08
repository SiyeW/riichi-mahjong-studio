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
