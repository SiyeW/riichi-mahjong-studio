<template>
  <div class="settings-preview auto-analysis-panel">
    <div class="auto-analysis-row">
      <span class="hover-action-menu auto-analysis-menu">
        <button
          class="auto-analysis-button"
          :class="{ running: autoAnalysisRunning }"
          :disabled="!status.gameLoaded || autoAnalysisRequestInFlight"
          @click="toggleAutoAnalysis"
        >
          {{ autoAnalysisRunning ? t('console.stop') : t('console.autoAnalysis') }}
        </button>
        <span class="hover-action-menu-items auto-analysis-menu-items" role="menu" :aria-label="t('console.autoAnalysis')">
          <button
            class="auto-analysis-menu-action"
            role="menuitem"
            :disabled="!status.gameLoaded || clearingAnalysisCaches"
            @click="clearCache"
          >{{ clearingAnalysisCaches ? t('console.clearingCache') : t('console.clearCache') }}</button>
          <small v-if="cacheClearMessage" class="auto-analysis-menu-status" role="status">{{ cacheClearMessage }}</small>
        </span>
      </span>
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
  cacheClearMessage: string
  clearingAnalysisCaches: boolean
}>()
const emit = defineEmits<{ 'clear-cache': [] }>()

function clearCache(event: MouseEvent) {
  emit('clear-cache')
  if (event.detail > 0) (event.currentTarget as HTMLButtonElement).blur()
}

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

.auto-analysis-menu {
  min-width: 0;
}

.auto-analysis-menu-items {
  box-sizing: border-box;
  width: min(calc(18rem * var(--chrome-scale)), calc(100cqw - 1.2rem));
  min-width: 0;
}

.auto-analysis-menu-action {
  width: 100%;
  padding: calc(0.35rem * var(--chrome-scale)) calc(0.55rem * var(--chrome-scale));
  border: 0;
  border-radius: calc(0.12rem * var(--ui-scale));
  background: transparent;
  color: var(--text-main);
  font: inherit;
  font-size: var(--ui-text-control);
  text-align: left;
  cursor: pointer;
}

.auto-analysis-menu-action:hover:not(:disabled),
.auto-analysis-menu-action:focus-visible {
  background: rgba(228, 241, 237, 0.08);
  outline: 1px solid rgba(228, 241, 237, 0.28);
}

.auto-analysis-menu-action:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

.auto-analysis-menu-status {
  padding: calc(0.25rem * var(--chrome-scale)) calc(0.55rem * var(--chrome-scale));
  color: var(--text-dim);
  font-size: var(--ui-text-caption);
  white-space: normal;
  overflow-wrap: anywhere;
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
