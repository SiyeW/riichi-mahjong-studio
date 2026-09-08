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
