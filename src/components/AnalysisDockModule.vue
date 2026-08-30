<template>
  <section
    class="panel dock-module analysis-dock"
    :class="{
      'reset-without-motion': suppressTransitions,
      'is-dragging': dragging,
    }"
    :style="{ '--floating-panel-scale': uiScale }"
    :aria-label="title"
  >
    <div class="dock-module-header analysis-dock-header">
      <div
        class="dock-module-drag-handle"
        v-ui-tooltip="t('workspace.dragPanel', { panel: title })"
        @pointerdown="emit('drag-start', $event)"
      >
        <h2>{{ title }}</h2>
      </div>
      <div class="dock-module-header-actions">
        <button
          v-if="section === 'opponents' && hasOpponentGroundTruth"
          class="analysis-dock-mode"
          @click="emit('toggle-mode')"
        >
          {{ shantenViewMode === 'predictions' ? t('analysis.predictions') : t('analysis.groundTruth') }}
        </button>
        <button
          class="floating-panel-close dock-module-close"
          :aria-label="t('common.close')"
          @click="emit('close')"
        >&times;</button>
      </div>
    </div>
    <div class="analysis-dock-body">
      <p v-if="loading" class="shanten-panel-state">{{ t('common.loading') }}</p>
      <template v-else>
        <p v-if="loadError" class="shanten-panel-state is-error">{{ loadError }}</p>
        <AnalysisPanel
          v-else
          :section="section"
          :analysis="analysis"
          :shanten-opponents="shantenOpponents"
          :shanten-colors="shantenColors"
          :shanten-labels="shantenLabels"
          :shanten-short-labels="shantenShortLabels"
          :reduce-motion="reduceMotion"
          :controlled-seat="controlledSeat"
          :dealer="dealer"
          :tile-image-src="tileImageSrc"
          :tile-face-label="tileFaceLabel"
          :perceptual-surface="perceptualSurface"
          :count-spacing="countSpacing"
          :count-layout="countLayout"
        />
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from '../i18n'
import type { AnalysisCountLayout, AnalysisCountSpacing } from '../analysisCountSpacing'
import type { PerceptualSurfaceBinding } from '../perceptualSurface'
import AnalysisPanel from './AnalysisPanel.vue'

const { t } = useI18n()

defineProps<{
  section: 'opponents' | 'game' | 'risk' | 'counts'
  title: string
  dragging: boolean
  suppressTransitions: boolean
  uiScale: number
  perceptualSurface: PerceptualSurfaceBinding
  loading: boolean
  loadError: string
  analysis: Record<string, unknown> | null | undefined
  shantenOpponents: Array<{ key: string; seat: number; label: string; probabilities: number[] }>
  shantenColors: string[]
  shantenLabels: string[]
  shantenShortLabels: string[]
  reduceMotion: boolean
  controlledSeat: number
  dealer: number
  tileImageSrc: (tile: string) => string
  tileFaceLabel: (tile: string) => string
  hasOpponentGroundTruth: boolean
  shantenViewMode: 'predictions' | 'ground_truth'
  countSpacing: AnalysisCountSpacing
  countLayout: AnalysisCountLayout
}>()

const emit = defineEmits<{
  'drag-start': [event: PointerEvent]
  'toggle-mode': []
  close: []
}>()
</script>
