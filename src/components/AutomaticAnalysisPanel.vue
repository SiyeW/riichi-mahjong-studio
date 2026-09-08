<template>
  <div class="settings-preview auto-analysis-panel">
    <div class="auto-analysis-row">
      <button
        class="auto-analysis-button"
        :class="{ running: autoAnalysisRunning }"
        :disabled="!status.gameLoaded || autoAnalysisRequestInFlight"
        @click="toggleAutoAnalysis"
      >
        {{ autoAnalysisRunning ? t('console.stop') : t('console.autoAnalysis') }}
      </button>
      <div
        class="auto-analysis-progress"
        role="progressbar"
        :aria-valuemin="0"
        :aria-valuemax="100"
        :aria-valuenow="autoAnalysisPercent"
        :aria-label="autoAnalysisLabel"
      >
        <canvas ref="autoAnalysisCanvasEl" class="auto-analysis-progress-canvas" aria-hidden="true"></canvas>
        <small>{{ autoAnalysisLabel }}</small>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useAutomaticAnalysis } from '../useAutomaticAnalysis'
import { useI18n } from '../i18n'

const props = defineProps<{
  status: TrainerStatusSnapshot
  applyStatus: (status: TrainerStatusSnapshot) => void
}>()

const { t } = useI18n()
const {
  autoAnalysisCanvasEl,
  autoAnalysisLabel,
  autoAnalysisPercent,
  autoAnalysisRequestInFlight,
  autoAnalysisRunning,
  toggleAutoAnalysis,
} = useAutomaticAnalysis({
  status: props.status,
  t,
  applyStatus: props.applyStatus,
})
</script>
