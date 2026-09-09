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

<style scoped>
.grid-info {
  --gi-side-width: calc(40px * var(--center-ui-scale));
  --gi-score-width: calc(76px * var(--center-ui-scale));
  --gi-strip-width: calc((2 * var(--gi-side-width)) + var(--gi-score-width));
  --gi-strip-height: calc(22px * var(--center-ui-scale));
  --gi-edge-inset: calc(6px * var(--center-ui-scale));
  width: var(--center-square-span);
  height: var(--center-square-span);
  grid-area: a-info;
  display: grid;
  margin: auto;
  border: 1px solid rgba(0, 0, 0, 0.55);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.03),
    0 calc(var(--zoom) * 2px) calc(var(--zoom) * 12px) rgba(0, 0, 0, 0.22);
  background: var(--bg-panel);
  z-index: 1;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  grid-template-rows: repeat(5, minmax(0, 1fr));
  grid-template-areas:
    ". . . . ."
    ". ai-round ai-round ai-round ."
    ". ai-tiles ai-tiles ai-tiles ."
    ". ai-doras ai-doras ai-doras ."
    ". . . . .";
}

.info-round {
  grid-area: ai-round;
  background: rgba(0, 0, 0, 0.25);
  color: var(--text-main);
  border: 1px solid rgba(0, 0, 0, 0.40);
  padding: calc(4px * var(--zoom)) calc(10px * var(--zoom));
  border-radius: calc(2px * var(--zoom));
  font-size: var(--table-text-round);
  line-height: 1;
  letter-spacing: 0.03em;
  cursor: pointer;
  transition: filter var(--ui-motion-duration) var(--ui-motion-easing);
}

.info-round:hover {
  filter: brightness(1.10);
}

.info-tiles-left {
  grid-area: ai-tiles;
  display: flex;
  align-items: center;
  justify-content: center;
  justify-self: center;
  align-self: stretch;
  font-size: var(--table-text-center-label);
  font-weight: 700;
  line-height: 1;
  color: var(--text-dim);
}

.info-doras {
  grid-area: ai-doras;
  display: flex;
  gap: 0;
  justify-self: center;
  align-self: start;
}

.info-doras .tileDiv {
  width: calc(var(--tile-img-w) * 0.7);
  height: calc(var(--tile-img-h) * 0.7);
}

.info-doras .tileImg {
  --mahjong-tile-artwork-width: calc(var(--tile-img-w) * 0.7);
  width: calc(var(--tile-img-w) * 0.7);
  height: calc(var(--tile-img-h) * 0.7);
}

.gi-p0-outer,
.gi-p1-outer,
.gi-p2-outer,
.gi-p3-outer {
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: var(--gi-strip-width);
  height: var(--gi-strip-height);
  padding: 0 0 calc(1px * var(--center-ui-scale));
  border-radius: calc(2px * var(--center-ui-scale));
  color: var(--text-dim);
}

.gi-p0-outer.is-east,
.gi-p1-outer.is-east,
.gi-p2-outer.is-east,
.gi-p3-outer.is-east {
  color: var(--text-main);
}

.gi-player-anchor {
  position: absolute;
  z-index: 2;
  display: flex;
  justify-content: center;
  align-items: center;
}

.gi-p0-anchor,
.gi-p2-anchor {
  left: 0;
  right: 0;
  width: var(--gi-strip-width);
  height: var(--gi-strip-height);
  margin-inline: auto;
}

.gi-p0-anchor {
  bottom: var(--gi-edge-inset);
}

.gi-p2-anchor {
  top: var(--gi-edge-inset);
}

.gi-p1-anchor,
.gi-p3-anchor {
  top: 0;
  bottom: 0;
  width: var(--gi-strip-height);
  height: var(--gi-strip-width);
  margin-block: auto;
}

.gi-p1-anchor {
  right: var(--gi-edge-inset);
}

.gi-p3-anchor {
  left: var(--gi-edge-inset);
}

.gi-p1-outer {
  transform: rotate(-90deg);
}

.gi-p2-outer {
  transform: rotate(180deg);
}

.gi-p3-outer {
  transform: rotate(90deg);
}

.gi-seat {
  font-size: var(--table-text-center-label);
  font-weight: 700;
  color: inherit;
  transform: translateY(calc(-0.5px * var(--center-ui-scale)));
}

.gi-score {
  font-size: var(--table-text-score);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
  color: inherit;
}

.gi-p0-outer .gi-score {
  transform: translateY(calc(-0.5px * var(--center-ui-scale)));
}

.gi-riichi-bet {
  font-size: var(--table-text-bet);
  color: inherit;
  visibility: hidden;
  transform: translateX(calc(-2px * var(--center-ui-scale)));
}

.gi-riichi-bet.on {
  visibility: visible;
}

.gi-p0-outer .gi-seat,
.gi-p1-outer .gi-seat,
.gi-p2-outer .gi-seat,
.gi-p3-outer .gi-seat,
.gi-p0-outer .gi-riichi-bet,
.gi-p1-outer .gi-riichi-bet,
.gi-p2-outer .gi-riichi-bet,
.gi-p3-outer .gi-riichi-bet {
  width: var(--gi-side-width);
  flex-shrink: 0;
}

.gi-p0-outer .gi-score,
.gi-p1-outer .gi-score,
.gi-p2-outer .gi-score,
.gi-p3-outer .gi-score {
  width: var(--gi-score-width);
  text-align: center;
  flex-shrink: 0;
}

.gi-p0-outer .gi-seat,
.gi-p1-outer .gi-seat,
.gi-p2-outer .gi-seat,
.gi-p3-outer .gi-seat {
  text-align: right;
}

.gi-p0-outer .gi-riichi-bet,
.gi-p1-outer .gi-riichi-bet,
.gi-p2-outer .gi-riichi-bet,
.gi-p3-outer .gi-riichi-bet {
  text-align: left;
}

.gi-p0-outer.is-actor,
.gi-p1-outer.is-actor,
.gi-p2-outer.is-actor,
.gi-p3-outer.is-actor {
  background: rgba(255, 193, 78, 0.12);
  border: 1px solid rgba(255, 193, 78, 0.55);
}
</style>
