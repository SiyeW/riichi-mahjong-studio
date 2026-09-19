<template>
  <div
    ref="tooltipElement"
    class="ui-hover-tooltip analysis-floating-tooltip"
    :class="{
      'is-positioned': tooltip.positioned,
      'is-outcome-detail': tooltip.variant === 'outcome-detail',
    }"
    :style="{ left: `${tooltip.left}px`, top: `${tooltip.top}px` }"
    role="tooltip"
  >
    <strong>{{ tooltip.title }}</strong>
    <span v-for="line in tooltip.lines" :key="line" class="analysis-floating-tooltip-line">{{ line }}</span>
    <div v-if="tooltip.variant === 'outcome-detail'" class="analysis-outcome-detail-bar" aria-hidden="true">
      <i
        v-for="row in tooltip.rows"
        :key="`segment-${row.label}-${row.value}`"
        :style="{ width: `${(row.proportion ?? 0) * 100}%`, background: row.segmentColor }"
      />
    </div>
    <div
      v-for="row in tooltip.rows"
      :key="`${row.label}-${row.value}`"
      class="ui-hover-tooltip-row"
      :class="{ 'has-segment': row.segmentColor }"
    >
      <span><i v-if="row.segmentColor" class="analysis-outcome-detail-swatch" :style="{ background: row.segmentColor }" />{{ row.label }}</span>
      <span>{{ row.value }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AnalysisHoverTooltipState } from '../useAnalysisHoverTooltip'

defineProps<{ tooltip: AnalysisHoverTooltipState }>()
const tooltipElement = defineModel<HTMLElement | null>('element', { required: true })
</script>

<style scoped src="./AnalysisHoverTooltip.css"></style>
