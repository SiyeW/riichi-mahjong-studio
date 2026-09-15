<template>
  <div
    ref="analysisRootElement"
    class="analysis-panel-content"
    :class="{
      'is-opponent-section': section === 'opponents',
      'reduce-motion': reduceMotion,
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
        :reduce-motion="reduceMotion"
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
        :tile-image-src="tileImageSrc"
        :tile-face-label="tileFaceLabel"
        :perceptual-surface="perceptualSurface"
        :count-layout="countLayout"
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
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
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
const { tooltip, tooltipElement, controller: tooltipController } = useAnalysisHoverTooltip(analysisRootElement)
let updateAnimation: Animation | null = null
let updateSnapshot: HTMLElement | null = null

function cancelUpdateAnimation() {
  updateAnimation?.cancel()
  updateAnimation = null
  updateSnapshot?.remove()
  updateSnapshot = null
}

watch(() => props.analysis, () => {
  tooltipController.clear()
  cancelUpdateAnimation()
  if (props.reduceMotion) return
  const liveElement = analysisLiveElement.value
  if (!liveElement) return
  const snapshot = liveElement.cloneNode(true) as HTMLElement
  const sourceCanvases = liveElement.querySelectorAll('canvas')
  const snapshotCanvases = snapshot.querySelectorAll('canvas')
  sourceCanvases.forEach((source, index) => {
    const target = snapshotCanvases[index]
    if (!target) return
    target.width = source.width
    target.height = source.height
    target.getContext('2d')?.drawImage(source, 0, 0)
  })
  snapshot.classList.add('analysis-panel-snapshot')
  snapshot.setAttribute('aria-hidden', 'true')
  snapshot.inert = true
  snapshot.removeAttribute('id')
  snapshot.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'))
  updateSnapshot = snapshot
  void nextTick(() => {
    const rootElement = analysisRootElement.value
    if (!rootElement || props.reduceMotion || updateSnapshot !== snapshot) return
    rootElement.appendChild(snapshot)
    const animation = snapshot.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: getUiMotionDurationMs(), easing: getUiMotionEasing() },
    )
    updateAnimation = animation
    animation.addEventListener('finish', () => {
      if (updateAnimation !== animation) return
      updateAnimation = null
      snapshot.remove()
      if (updateSnapshot === snapshot) updateSnapshot = null
    }, { once: true })
  })
}, { flush: 'sync' })

watch(() => props.reduceMotion, (reduced) => {
  if (reduced) cancelUpdateAnimation()
})

onBeforeUnmount(cancelUpdateAnimation)
</script>

<style src="./AnalysisPanel.css"></style>
<style src="./AnalysisTileCharts.css"></style>
