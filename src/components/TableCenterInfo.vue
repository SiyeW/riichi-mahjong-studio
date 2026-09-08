<template>
  <div class="grid-info">
    <button class="info-round" @click.stop="$emit('toggle-round-map')">{{ roundLabel }}</button>
    <span class="info-tiles-left">x{{ table.wallRemaining }}</span>
    <span class="info-doras">
      <div v-for="(tile, index) in doraSlots" :key="`dora-${index}`" class="tileDiv">
        <img :src="tileImageSrc(tile)" class="tileImg" :alt="tileFaceLabel(tile)" />
      </div>
    </span>
    <span
      v-for="view in orderedViews"
      :key="`center-seat-${view.seat}`"
      :class="['gi-player-anchor', `gi-p${positionIndex[view.position]}-anchor`]"
    >
      <span
        :class="[
          `gi-p${positionIndex[view.position]}-outer`,
          { 'is-actor': isCurrentActorSeat(view.seat), 'is-east': view.seat === table.dealer },
        ]"
      >
        <span class="gi-seat">{{ seatWindLabel(view.seat) }}</span>
        <span class="gi-score">{{ table.scores?.[view.seat] ?? 0 }}</span>
        <span class="gi-riichi-bet" :class="{ on: view.riichiAccepted }">-1000</span>
      </span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { TableSeatView } from '../useTablePresentation'

const props = defineProps<{
  table: NonNullable<TrainerGameView['table']>
  views: TableSeatView[]
  roundLabel: string
  doraSlots: string[]
  isCurrentActorSeat: (seat: number) => boolean
  seatWindLabel: (seat: number) => string
  tileFaceLabel: (tile: string) => string
  tileImageSrc: (tile: string) => string
}>()

defineEmits<{
  'toggle-round-map': []
}>()

const positionIndex: Record<TableSeatView['position'], number> = {
  south: 0,
  east: 1,
  north: 2,
  west: 3,
}
const positionOrder: TableSeatView['position'][] = ['south', 'east', 'north', 'west']
const orderedViews = computed(() => positionOrder.flatMap((position) => (
  props.views.filter((view) => view.position === position)
)))
</script>
