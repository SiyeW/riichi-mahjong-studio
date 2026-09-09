<template>
  <aside class="panel dock-module side-panel console-dock" :class="{ 'is-dragging': dragging }">
    <div class="dock-module-header panel-header">
      <div
        class="dock-module-drag-handle"
        v-ui-tooltip="t('workspace.dragPanel', { panel: t('console.title') })"
        @pointerdown="emit('drag-start', $event)"
      >
        <h2>{{ t('console.title') }}</h2>
      </div>
      <button
        class="floating-panel-close dock-module-close"
        :aria-label="t('common.close')"
        @click="emit('close')"
      >&times;</button>
    </div>
    <div class="console-dock-body">
      <slot />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { useI18n } from '../i18n'

defineProps<{ dragging: boolean }>()
const emit = defineEmits<{
  'drag-start': [event: PointerEvent]
  close: []
}>()
const { t } = useI18n()
</script>

<style scoped>
.console-dock {
  container-name: console-dock;
  container-type: inline-size;
}

.console-dock-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: calc(0.36rem * var(--chrome-scale));
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: calc(0.5rem * var(--chrome-scale)) calc(0.48rem * var(--chrome-scale)) calc(0.7rem * var(--chrome-scale));
}
</style>
