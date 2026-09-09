<template>
  <div
    ref="tooltipElement"
    class="ui-hover-tooltip analysis-floating-tooltip"
    :class="{ 'is-positioned': tooltip.positioned }"
    :style="{ left: `${tooltip.left}px`, top: `${tooltip.top}px` }"
    role="tooltip"
  >
    <strong>{{ tooltip.title }}</strong>
    <span v-for="line in tooltip.lines" :key="line" class="analysis-floating-tooltip-line">{{ line }}</span>
    <div
      v-for="row in tooltip.rows"
      :key="`${row.label}-${row.value}`"
      class="ui-hover-tooltip-row"
      :class="{ 'has-bar': row.barWidth }"
    >
      <span>{{ row.label }}</span>
      <i v-if="row.barWidth" class="analysis-tooltip-bar">
        <span :style="{ width: row.barWidth, background: row.barColor }" />
      </i>
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
