<template>
  <div class="settings-modal-backdrop" @click.self="emit('close')">
    <section class="wall-view-panel mjai-debug-panel">
      <div class="settings-modal-header">
        <h2>{{ t('debug.title') }}</h2>
        <div class="settings-modal-actions">
          <button
            class="settings-btn-secondary"
            :disabled="!gameLoaded || clearingAnalysisCaches"
            @click="emit('clear-cache')"
          >
            {{ clearingAnalysisCaches ? t('debug.clearingCache') : t('debug.clearCache') }}
          </button>
          <button class="settings-btn-secondary" @click="emit('close')">
            {{ t('debug.close') }}
          </button>
        </div>
      </div>
      <p v-if="cacheClearMessage" class="mjai-cache-clear-message">{{ cacheClearMessage }}</p>
      <div class="mjai-debug-info">
        <span v-if="debugData.caller">{{ t('debug.caller', { value: String(debugData.caller) }) }}</span>
        <span v-if="debugData.seat != null">{{ t('debug.seat', { value: String(debugData.seat) }) }}</span>
        <span v-if="debugData.phase">{{ t('debug.phase', { value: String(debugData.phase) }) }}</span>
        <span v-if="debugData.eventCount != null">{{ t('debug.eventCount', { value: String(debugData.eventCount) }) }}</span>
        <span v-if="debugData.responseType">{{ t('debug.response', { value: String(debugData.responseType) }) }}</span>
      </div>
      <pre class="mjai-debug-pre">{{ debugJson }}</pre>
      <div class="mjai-debug-section-label">{{ t('debug.shantenModel') }}</div>
      <pre class="mjai-debug-pre">{{ shantenJson }}</pre>
      <div class="mjai-debug-status">{{ shantenStatus }}</div>
      <pre v-if="hasShantenRawData" class="mjai-debug-pre">{{ shantenRawJson }}</pre>
    </section>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from '../i18n'

defineProps<{
  cacheClearMessage: string
  clearingAnalysisCaches: boolean
  debugData: Record<string, unknown>
  debugJson: string
  gameLoaded: boolean
  hasShantenRawData: boolean
  shantenJson: string
  shantenRawJson: string
  shantenStatus: string
}>()

const emit = defineEmits<{
  'clear-cache': []
  close: []
}>()
const { t } = useI18n()
</script>

<style scoped>
.mjai-debug-panel {
  width: min(95vw, calc(56.25rem * var(--ui-scale)));
  max-height: 90vh;
}

.settings-modal-header {
  position: static;
  top: auto;
  z-index: auto;
  margin-left: 0;
  margin-right: 0;
  margin-bottom: calc(0.75rem * var(--chrome-scale));
  padding: 0 0 calc(0.35rem * var(--chrome-scale));
  background: transparent;
}

.mjai-debug-info {
  display: flex;
  flex-wrap: wrap;
  gap: calc(0.4rem * var(--chrome-scale)) calc(1.2rem * var(--chrome-scale));
  padding: calc(0.4rem * var(--chrome-scale)) calc(0.6rem * var(--chrome-scale));
  margin-bottom: calc(0.5rem * var(--chrome-scale));
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  color: var(--text-dim);
  font-size: var(--ui-text-control);
}

.mjai-debug-pre {
  flex: 1;
  max-height: 18vh;
  overflow: auto;
  padding: calc(0.6rem * var(--chrome-scale));
  border-radius: calc(4px * var(--chrome-scale));
  background: rgba(0, 0, 0, 0.3);
  color: var(--text-main);
  font-size: var(--ui-text-body);
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
}

.mjai-debug-status {
  padding: 0.2rem 0.4rem;
  color: var(--text-dim);
  font-size: var(--ui-text-caption);
}

.mjai-cache-clear-message {
  margin: 0 0 calc(0.5rem * var(--chrome-scale));
  padding: calc(0.35rem * var(--chrome-scale)) calc(0.5rem * var(--chrome-scale));
  border-left: calc(2px * var(--chrome-scale)) solid rgba(88, 185, 126, 0.72);
  background: rgba(20, 88, 61, 0.2);
  color: rgba(226, 241, 237, 0.84);
  font-size: var(--ui-text-body);
}
</style>
