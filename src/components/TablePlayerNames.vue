<template>
  <div class="table-player-names">
    <div v-for="view in orderedViews" :key="view.seat" :data-player-seat="view.seat"
      :class="['table-player-name', `table-player-name--${view.position}`,
        { 'has-third-river-row': Boolean(riverDisplayRows(view)[2]?.length) }]">
      <PlayerNameEditor :name="playerNames?.[view.seat] || ''" :draft="nameDrafts.get(view.seat)"
        :error="nameError" :save="saveNames" @draft="emit('name-draft', view.seat, $event)"
        @cancel="emit('name-cancel', view.seat)" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { RiverDisplaySlot, TableSeatView } from '../useTablePresentation'
import PlayerNameEditor from './PlayerNameEditor.vue'

const props = defineProps<{
  views: TableSeatView[]
  riverDisplayRows: (view: TableSeatView) => RiverDisplaySlot[][]
  playerNames?: string[]
  nameDrafts: Map<number, string>
  nameError: string
  saveNames: () => Promise<void>
}>()
const emit = defineEmits<{
  'name-draft': [seat: number, name: string]
  'name-cancel': [seat: number]
}>()
const positionOrder: TableSeatView['position'][] = ['south', 'east', 'north', 'west']
const orderedViews = computed(() => positionOrder.flatMap(position => (
  props.views.filter(view => view.position === position)
)))
</script>

<style scoped>
.table-player-names {
  /* Share the dark square's bounds; names must not affect the table grid. */
  position: absolute;
  inset: var(--grid-top-row) var(--grid-side-col) var(--grid-bottom-row);
  z-index: 2;
  pointer-events: none;
  font-size: var(--table-text-center-label);
  --name-inset: calc(6px * var(--zoom));
  --name-height: calc(1.35em + 2px);
  /* Use the free edge until the third river row actually occupies it.
     Leave the perpendicular corner label its own line height. */
  --name-width: calc(var(--river-dark-w) - 3 * var(--name-inset) - var(--name-height));
}
.table-player-name {
  position: absolute;
  width: var(--name-width);
  height: var(--name-height);
  transform-origin: 0 0;
  text-align: left;
  pointer-events: auto;
  /* The dark square is a pseudo-element, so declare its actual surface here
     for the shared in-place reveal's background sampling. */
  background: var(--bg-river);
}
.table-player-name.has-third-river-row {
  --name-width: calc(var(--grid-river-col) - 2 * var(--name-inset));
}
.table-player-name--south {
  left: var(--name-inset);
  bottom: var(--name-inset);
}
.table-player-name--north {
  right: var(--name-inset);
  top: var(--name-inset);
  text-align: right;
}
.table-player-name--west {
  left: calc(var(--name-inset) + var(--name-height));
  top: var(--name-inset);
  transform: rotate(90deg);
}
.table-player-name--east {
  left: calc(100% - var(--name-inset) - var(--name-height));
  top: calc(100% - var(--name-inset));
  transform: rotate(-90deg);
}
</style>
