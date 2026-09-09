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
import type { StudioStatus } from '../contracts/runtime'

const props = defineProps<{
  status: StudioStatus
  applyStatus: (status: StudioStatus) => void
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

<style scoped>
.auto-analysis-panel {
  padding: calc(0.4rem * var(--chrome-scale)) calc(0.44rem * var(--chrome-scale));
}

.auto-analysis-row {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: stretch;
  gap: calc(0.38rem * var(--chrome-scale));
  min-width: 0;
}

.auto-analysis-button {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--border-dark);
  background: var(--surface-control-active);
  color: var(--text-main);
  padding: calc(0.34rem * var(--chrome-scale)) calc(0.66rem * var(--chrome-scale));
  border-radius: calc(0.1875rem * var(--chrome-scale));
  font-size: var(--ui-text-control);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--ui-motion-duration) var(--ui-motion-easing),
    opacity var(--ui-motion-duration) var(--ui-motion-easing);
}

.auto-analysis-button:hover:not(:disabled) {
  background: rgba(30, 145, 84, 0.96);
}

.auto-analysis-button.running {
  background: rgba(137, 66, 55, 0.88);
}

.auto-analysis-button.running:hover:not(:disabled) {
  background: rgba(159, 76, 63, 0.96);
}

.auto-analysis-button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.auto-analysis-progress {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  display: grid;
  place-items: center;
  border: 1px solid rgba(130, 185, 175, 0.16);
  border-radius: calc(0.1875rem * var(--chrome-scale));
  background: var(--tree-surface-bg);
}

.auto-analysis-progress-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.auto-analysis-progress small {
  position: relative;
  z-index: 1;
  max-width: 100%;
  overflow: hidden;
  color: rgba(235, 245, 242, 0.86);
  font-size: var(--ui-text-caption);
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
  text-shadow: 0 1px 2px rgba(0, 18, 23, 0.96);
}

@container console-dock (max-width: 12rem) {
  .auto-analysis-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .auto-analysis-progress {
    min-height: calc(1.75rem * var(--ui-scale));
  }
}
</style>
