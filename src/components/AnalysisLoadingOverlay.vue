<template>
  <div class="analysis-loading-overlay" role="status" aria-live="polite">
    <span>{{ t('common.loading') }}</span>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from '../i18n'
const { t } = useI18n()
</script>

<style scoped>
.analysis-loading-overlay {
  --feedback-scale: var(--floating-panel-scale, var(--chrome-scale));
  position: absolute; inset: 0; z-index: 8;
  display: grid; place-items: center; pointer-events: none;
  background: color-mix(in srgb, var(--surface-panel) 56%, transparent);
}
.analysis-loading-overlay > span {
  padding: calc(0.35rem * var(--feedback-scale)) calc(0.7rem * var(--feedback-scale));
  border: 1px solid var(--border-default); border-radius: var(--ui-radius-control);
  color: var(--text-main); background: var(--surface-control-quiet); font-size: var(--ui-text-body);
}
</style>
