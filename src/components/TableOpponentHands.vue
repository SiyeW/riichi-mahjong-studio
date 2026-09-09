<template>
  <span
    v-for="seat in seats"
    :key="`opponent-hand-${seat.view.seat}`"
    :class="[
      'grid-hand',
      `pov-p${positionIndex[seat.view.position]}`,
      `grid-hand-p${positionIndex[seat.view.position]}`,
      { 'hands-hidden': !visibleHands },
    ]"
  >
    <span
      :class="[
        `pov-p${positionIndex[seat.view.position]}`,
        `hand-closed-p${positionIndex[seat.view.position]}`,
        'opponent-hand-toggle',
      ]"
      role="button"
      tabindex="0"
      :aria-label="visibleHandsToggleLabel"
      v-ui-tooltip="visibleHandsToggleLabel"
      @click.stop="toggleVisibleHands"
      @keydown.enter.prevent="toggleVisibleHands"
      @keydown.space.prevent="toggleVisibleHands"
    >
      <div
        v-for="(tile, index) in seat.handParts.closed"
        :key="`p${positionIndex[seat.view.position]}h-${index}`"
        :class="['tileDiv', { 'hand-discard-gap': tile === handDiscardGap }]"
        :data-hand-gap-seat="tile === handDiscardGap ? seat.view.seat : undefined"
      >
        <img
          v-if="tile !== handDiscardGap"
          :src="tileImageSrc(tile)"
          class="tileImg"
          :alt="tileFaceLabel(tile)"
        />
      </div>
      <span
        v-if="seat.handParts.drawn"
        :class="['draw-gap', `draw-gap-p${positionIndex[seat.view.position]}`]"
      ></span>
      <div
        v-if="seat.handParts.drawn"
        :class="['tileDiv', 'is-drawn', { 'hand-discard-gap': seat.handParts.drawn === handDiscardGap }]"
        :data-hand-gap-seat="seat.handParts.drawn === handDiscardGap ? seat.view.seat : undefined"
      >
        <img
          v-if="seat.handParts.drawn !== handDiscardGap"
          :src="tileImageSrc(seat.handParts.drawn)"
          class="tileImg"
          :alt="tileFaceLabel(seat.handParts.drawn)"
        />
      </div>
      <div v-if="seat.view.hand.length < 13" class="tileDiv narrow" style="opacity: 0">
        <img :src="tileImageSrc('?')" class="tileImg" alt="" />
      </div>
    </span>
    <span
      v-if="seat.view.melds.length"
      :class="[`pov-p${positionIndex[seat.view.position]}`, `hand-calls-p${positionIndex[seat.view.position]}`]"
    >
      <template
        v-for="(meld, reversedIndex) in seat.view.melds.slice().reverse()"
        :key="`p${positionIndex[seat.view.position]}m-${reversedIndex}`"
      >
        <div
          v-for="(item, tileIndex) in meldDisplayTiles(meld, seat.view.seat)"
          :key="`p${positionIndex[seat.view.position]}mt-${tileIndex}`"
          class="tileDiv"
        >
          <img
            :class="[
              'tileImg',
              item.tileClass,
              { 'history-jump-target': canJumpToHistoricalNode(meldNodeId(seat.view.seat, seat.view.melds.length - 1 - reversedIndex)) },
            ]"
            :src="item.isBack ? tileImageSrc('?') : tileImageSrc(item.tile)"
            :alt="tileFaceLabel(item.tile)"
            v-ui-tooltip="historicalJumpTitle(
              meldNodeId(seat.view.seat, seat.view.melds.length - 1 - reversedIndex),
              item.isKakan ? t('history.ponTile') : t('history.meld'),
            )"
            @dblclick.stop="jumpToHistoricalNode(meldNodeId(seat.view.seat, seat.view.melds.length - 1 - reversedIndex))"
          />
          <img
            v-if="item.isKakan"
            :class="[
              'tileImg',
              item.tileClass,
              'kakan-stack',
              { 'history-jump-target': canJumpToHistoricalNode(meldNodeId(seat.view.seat, seat.view.melds.length - 1 - reversedIndex, 'kakan')) },
            ]"
            :src="item.isBack ? tileImageSrc('?') : tileImageSrc(item.tile)"
            :alt="tileFaceLabel(item.tile)"
            v-ui-tooltip="historicalJumpTitle(
              meldNodeId(seat.view.seat, seat.view.melds.length - 1 - reversedIndex, 'kakan'),
              t('history.kakanTile'),
            )"
            @dblclick.stop="jumpToHistoricalNode(meldNodeId(seat.view.seat, seat.view.melds.length - 1 - reversedIndex, 'kakan'))"
          />
        </div>
      </template>
    </span>
  </span>
</template>

<script setup lang="ts">
import { useI18n } from '../i18n'
import type { HandParts, MeldDisplayTile, TableSeatView } from '../useTablePresentation'

export interface OpponentHandPresentation {
  view: TableSeatView
  handParts: HandParts
}

defineProps<{
  seats: OpponentHandPresentation[]
  visibleHands: boolean
  visibleHandsToggleLabel: string
  handDiscardGap: string
  toggleVisibleHands: () => void
  meldDisplayTiles: (meld: Record<string, unknown>, actor: number) => MeldDisplayTile[]
  meldNodeId: (seat: number, meldIndex: number, kind?: 'kakan') => string | null
  canJumpToHistoricalNode: (nodeId: string | null | undefined) => boolean
  historicalJumpTitle: (nodeId: string | null | undefined, source: string) => string | undefined
  jumpToHistoricalNode: (nodeId: string | null | undefined) => void
  tileFaceLabel: (tile: string) => string
  tileImageSrc: (tile: string) => string
}>()

const { t } = useI18n()
const positionIndex: Record<TableSeatView['position'], number> = {
  south: 0,
  east: 1,
  north: 2,
  west: 3,
}
</script>

<style scoped src="./TableOpponentHands.css"></style>
