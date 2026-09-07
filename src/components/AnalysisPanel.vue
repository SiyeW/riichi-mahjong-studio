<template>
  <div
    ref="analysisRootElement"
    class="unified-analysis"
    :class="{
      'is-opponent-section': section === 'opponents',
      'reduce-motion': reduceMotion,
      'is-risk-section': section === 'risk',
      'is-count-section': section === 'counts',
    }"
  >
    <OpponentAnalysisSection
      v-if="section === 'opponents'"
      :analysis="analysis"
      :shanten-opponents="shantenOpponents"
      :shanten-colors="shantenColors"
      :shanten-labels="shantenLabels"
      :shanten-short-labels="shantenShortLabels"
      :reduce-motion="reduceMotion"
      :controlled-seat="controlledSeat"
      :dealer="dealer"
      :perceptual-surface="perceptualSurface"
    />
    <GameAnalysisSection
      v-else-if="section === 'game'"
      :analysis="analysis"
      :shanten-opponents="shantenOpponents"
      :controlled-seat="controlledSeat"
      :dealer="dealer"
      :perceptual-surface="perceptualSurface"
    />
    <DealInRiskSection
      v-else-if="section === 'risk'"
      :analysis="analysis"
      :shanten-opponents="shantenOpponents"
      :controlled-seat="controlledSeat"
      :dealer="dealer"
      :tile-image-src="tileImageSrc"
      :tile-face-label="tileFaceLabel"
      :perceptual-surface="perceptualSurface"
    />
    <TileCountAnalysisSection
      v-else
      :analysis="analysis"
      :shanten-opponents="shantenOpponents"
      :controlled-seat="controlledSeat"
      :dealer="dealer"
      :tile-image-src="tileImageSrc"
      :tile-face-label="tileFaceLabel"
      :perceptual-surface="perceptualSurface"
      :count-layout="countLayout"
      @update:count-layout="emit('update:countLayout', $event)"
    />
    <AnalysisHoverTooltip
      v-if="tooltip"
      v-model:element="tooltipElement"
      :tooltip="tooltip"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { AnalysisCountLayout } from '../analysisCountSpacing'
import type { AnalysisPanelProps } from '../analysisPanelTypes'
import { useAnalysisHoverTooltip } from '../useAnalysisHoverTooltip'
import AnalysisHoverTooltip from './AnalysisHoverTooltip.vue'
import DealInRiskSection from './DealInRiskSection.vue'
import GameAnalysisSection from './GameAnalysisSection.vue'
import OpponentAnalysisSection from './OpponentAnalysisSection.vue'
import TileCountAnalysisSection from './TileCountAnalysisSection.vue'

defineProps<AnalysisPanelProps>()
const emit = defineEmits<{ 'update:countLayout': [value: AnalysisCountLayout] }>()
const analysisRootElement = ref<HTMLElement | null>(null)
const { tooltip, tooltipElement } = useAnalysisHoverTooltip(analysisRootElement)
</script>

<style src="./AnalysisPanel.css"></style>
