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
