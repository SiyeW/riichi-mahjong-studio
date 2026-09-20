<template>
  <div
    ref="analysisRootElement"
    class="analysis-panel-content"
    :class="{
      'is-opponent-section': section === 'opponents',
      'reduce-motion': childReduceMotion,
      'is-risk-section': section === 'risk',
      'is-count-section': section === 'counts',
    }"
  >
    <div ref="analysisLiveElement" class="analysis-panel-live">
      <OpponentAnalysisSection
        v-if="section === 'opponents'"
        :analysis="analysis"
        :analysis-opponents="analysisOpponents"
        :shanten-colors="shantenColors"
        :shanten-labels="shantenLabels"
        :shanten-short-labels="shantenShortLabels"
        :reduce-motion="childReduceMotion"
        :controlled-seat="controlledSeat"
        :dealer="dealer"
        :perceptual-surface="perceptualSurface"
      />
      <GameAnalysisSection
        v-else-if="section === 'game'"
        :analysis="analysis"
        :analysis-opponents="analysisOpponents"
        :controlled-seat="controlledSeat"
        :dealer="dealer"
        :perceptual-surface="perceptualSurface"
      />
      <DealInRiskSection
        v-else-if="section === 'risk'"
        :analysis="analysis"
        :analysis-opponents="analysisOpponents"
        :controlled-seat="controlledSeat"
        :dealer="dealer"
        :reduce-motion="childReduceMotion"
        :tile-image-src="tileImageSrc"
        :tile-face-label="tileFaceLabel"
        :perceptual-surface="perceptualSurface"
      />
      <TileCountAnalysisSection
        v-else
        :analysis="analysis"
        :analysis-opponents="analysisOpponents"
        :controlled-seat="controlledSeat"
        :dealer="dealer"
        :table="table"
        :tile-image-src="tileImageSrc"
        :tile-face-label="tileFaceLabel"
        :perceptual-surface="perceptualSurface"
        :count-layout="countLayout"
        :reduce-motion="childReduceMotion"
        @update:count-layout="emit('update:countLayout', $event)"
      />
    </div>
    <AnalysisHoverTooltip
      v-if="tooltip"
      v-model:element="tooltipElement"
      :tooltip="tooltip"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { AnalysisCountLayout } from '../analysisCountSpacing'
import type { AnalysisPanelProps } from '../analysisPanelTypes'
import { getUiMotionDurationMs, getUiMotionEasing } from '../uiMotion'
import { useAnalysisHoverTooltip } from '../useAnalysisHoverTooltip'
import AnalysisHoverTooltip from './AnalysisHoverTooltip.vue'
import DealInRiskSection from './DealInRiskSection.vue'
import GameAnalysisSection from './GameAnalysisSection.vue'
import OpponentAnalysisSection from './OpponentAnalysisSection.vue'
import TileCountAnalysisSection from './TileCountAnalysisSection.vue'

const props = defineProps<AnalysisPanelProps>()
const emit = defineEmits<{ 'update:countLayout': [value: AnalysisCountLayout] }>()
const analysisRootElement = ref<HTMLElement | null>(null)
const analysisLiveElement = ref<HTMLElement | null>(null)
const { tooltip, tooltipElement } = useAnalysisHoverTooltip(analysisRootElement)
const presentationMotion = ref(false)
const childReduceMotion = computed(() => props.reduceMotion || presentationMotion.value)
let presentationAnimation: Animation | null = null
let presentationFrame = 0

function clearPresentationLayer() {
  const element = analysisLiveElement.value
  element?.style.removeProperty('opacity')
  element?.style.removeProperty('will-change')
}

function cancelPresentationAnimation() {
  if (presentationFrame) {
    cancelAnimationFrame(presentationFrame)
    presentationFrame = 0
  }
  presentationAnimation?.cancel()
  presentationAnimation = null
  clearPresentationLayer()
  presentationMotion.value = false
}

watch(() => props.analysis, () => {
  cancelPresentationAnimation()
  if (props.reduceMotion) return
  presentationMotion.value = true
  void nextTick(() => {
    const element = analysisLiveElement.value
    if (!element || props.reduceMotion) {
      presentationMotion.value = false
      return
    }
    // Give Chromium one paint to upload the completed panel into a temporary
    // compositing layer. Starting the opacity animation in the same task as
    // the data update makes the short transition compete with panel raster.
    element.style.opacity = '0.88'
    element.style.willChange = 'opacity'
    presentationFrame = requestAnimationFrame(() => {
      presentationFrame = 0
      if (!element.isConnected || props.reduceMotion) {
        clearPresentationLayer()
        presentationMotion.value = false
        return
      }
      const animation = element.animate(
        [{ opacity: 0.88 }, { opacity: 1 }],
        { duration: getUiMotionDurationMs(), easing: getUiMotionEasing() },
      )
      element.style.removeProperty('opacity')
      presentationAnimation = animation
      const finish = () => {
        if (presentationAnimation !== animation) return
        presentationAnimation = null
        clearPresentationLayer()
        presentationMotion.value = false
      }
      animation.addEventListener('finish', finish, { once: true })
      animation.addEventListener('cancel', finish, { once: true })
    })
  })
}, { flush: 'sync' })

watch(() => props.reduceMotion, (reduced) => {
  if (reduced) cancelPresentationAnimation()
})

onBeforeUnmount(cancelPresentationAnimation)
</script>

<style src="./AnalysisPanel.css"></style>
<style src="./AnalysisTileCharts.css"></style>
