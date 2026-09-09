<template>
  <span
    v-for="view in orderedViews"
    :key="`river-seat-${view.seat}`"
    :class="['grid-discard', `pov-p${positionIndex[view.position]}`, `grid-discard-p${positionIndex[view.position]}`]"
  >
    <span
      v-for="(row, rowIndex) in riverDisplayRows(view)"
      :key="`river-${view.seat}-${rowIndex}`"
      class="river-row"
    >
      <div
        v-for="slot in row"
        :key="slot.key"
        :class="['tileDiv', slot.isPending ? 'tileDivPending' : '', slot.isRiichiDiscard ? 'river-riichi' : '', { 'history-jump-target': canJumpToHistoricalNode(slot.sourceNodeId) }]"
        :data-pending-discard-seat="slot.isPending ? view.seat : undefined"
        v-ui-tooltip="historicalJumpTitle(slot.sourceNodeId, t('history.discard'))"
        @dblclick.stop="jumpToHistoricalNode(slot.sourceNodeId)"
      >
        <img
          :src="tileImageSrc(slot.tile)"
          :class="['tileImg', slot.isClaimed ? 'river-claimed called' : (slot.isTsumogiri && showTsumogiriTone ? 'river-tsumogiri' : ''), slot.isPending ? 'last-discard' : '', slot.isRiichiDiscard ? 'river-riichi' : '']"
          :alt="tileFaceLabel(slot.tile)"
        />
      </div>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../i18n'
import type { RiverDisplaySlot, TableSeatView } from '../useTablePresentation'

const props = defineProps<{
  views: TableSeatView[]
  showTsumogiriTone: boolean
  riverDisplayRows: (view: TableSeatView) => RiverDisplaySlot[][]
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
const positionOrder: TableSeatView['position'][] = ['south', 'west', 'north', 'east']
const orderedViews = computed(() => positionOrder.flatMap((position) => (
  props.views.filter((view) => view.position === position)
)))
</script>

<style scoped src="./TableRivers.css"></style>
