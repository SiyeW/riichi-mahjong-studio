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
import type { GameTreeNode } from '../contracts/game'
import { useActionAnnouncement } from '../useActionAnnouncement'
import type { TableSeatView } from '../useTablePresentation'

const props = defineProps<{
  gameView: TrainerGameView
  views: TableSeatView[]
  findNode: (nodeId: string) => GameTreeNode | undefined
}>()

const { t } = useI18n()
const { actionAnnouncement } = useActionAnnouncement({
  gameView: props.gameView,
  findNode: props.findNode,
  positionForActor: (actor) => props.views.find((entry) => entry.seat === actor)?.position || 'south',
  t,
})
</script>

<style scoped>
.table-callout {
  position: absolute;
  left: var(--grid-center-x);
  top: var(--grid-center-y);
  transform: translate(-50%, -50%);
  z-index: 6;
  pointer-events: none;
  font-size: var(--table-text-callout);
  line-height: 1;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: rgba(255, 247, 227, 0.96);
  text-shadow:
    0 0 calc(var(--zoom) * 10px) rgba(0, 0, 0, 0.32),
    0 calc(var(--zoom) * 2px) calc(var(--zoom) * 4px) rgba(0, 0, 0, 0.38);
  white-space: nowrap;
  --callout-enter-x: 0px;
  --callout-enter-y: calc(var(--zoom) * 6px);
  --callout-drift-x: 0px;
  --callout-drift-y: calc(var(--zoom) * -10px);
  animation: table-callout-fade 1500ms ease forwards;
}

.table-callout.is-south {
  left: var(--grid-center-x);
  top: calc(var(--grid-center-y) + (var(--river-dark-h) / 2) - (var(--zoom) * 22px));
}

.table-callout.is-north {
  left: var(--grid-center-x);
  top: calc(var(--grid-center-y) - (var(--river-dark-h) / 2) + (var(--zoom) * 22px));
  --callout-enter-y: calc(var(--zoom) * -6px);
  --callout-drift-y: calc(var(--zoom) * 10px);
}

.table-callout.is-west {
  left: calc(var(--grid-center-x) - (var(--river-dark-w) / 2) + (var(--zoom) * 22px));
  top: var(--grid-center-y);
  --callout-enter-x: calc(var(--zoom) * -6px);
  --callout-enter-y: 0px;
  --callout-drift-x: calc(var(--zoom) * 10px);
  --callout-drift-y: 0px;
}

.table-callout.is-east {
  left: calc(var(--grid-center-x) + (var(--river-dark-w) / 2) - (var(--zoom) * 22px));
  top: var(--grid-center-y);
  --callout-enter-x: calc(var(--zoom) * 6px);
  --callout-enter-y: 0px;
  --callout-drift-x: calc(var(--zoom) * -10px);
  --callout-drift-y: 0px;
}

@keyframes table-callout-fade {
  0% {
    opacity: 0;
    transform: translate(calc(-50% + var(--callout-enter-x)), calc(-50% + var(--callout-enter-y))) scale(0.94);
  }
  12% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(calc(-50% + var(--callout-drift-x)), calc(-50% + var(--callout-drift-y))) scale(1.02);
  }
}
</style>
