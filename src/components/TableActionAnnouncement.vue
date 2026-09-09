<template>
  <div
    v-if="actionAnnouncement.visible"
    :key="actionAnnouncement.key"
    :class="['table-callout', `is-${actionAnnouncement.position}`]"
  >
    {{ actionAnnouncement.text }}
  </div>
</template>

<script setup lang="ts">
import { useI18n } from '../i18n'
import { useActionAnnouncement } from '../useActionAnnouncement'
import type { TableSeatView } from '../useTablePresentation'

const props = defineProps<{
  gameView: TrainerGameView
  views: TableSeatView[]
  findNode: (nodeId: string) => TrainerTreeNode | undefined
}>()

const { t } = useI18n()
const { actionAnnouncement } = useActionAnnouncement({
  gameView: props.gameView,
  findNode: props.findNode,
  positionForActor: (actor) => props.views.find((entry) => entry.seat === actor)?.position || 'south',
  t,
})
</script>
