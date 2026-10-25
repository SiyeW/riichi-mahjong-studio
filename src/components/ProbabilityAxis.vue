<template>
  <div class="analysis-probability-axis" aria-hidden="true">
    <span v-for="tick in ticks" :key="tick.value" :style="{ top: `${position(tick.value) * 100}%` }">
      <i />
      <small :style="labelStyle(tick.value)">{{ tick.label }}</small>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { probabilityScaleRatio, probabilityScaleTicks } from '../analysisProbabilityScale'
const props = withDefaults(defineProps<{
  scale: number
  direction?: 'up' | 'down'
  height?: number
  labelSpacing?: number
  clampEndpoints?: boolean
}>(), { direction: 'down', labelSpacing: 0 })
const ticks = computed(() => {
  const every = props.height && props.labelSpacing
    ? Math.max(1, Math.ceil(props.labelSpacing * props.scale / (props.height * .1))) : 1
  return probabilityScaleTicks(props.scale).map((tick, index) => ({
    ...tick, label: index % (2 * every) === 0 ? tick.label : '',
  }))
})
function position(value: number) {
  const ratio = probabilityScaleRatio(value, props.scale)
  return props.direction === 'up' ? 1 - ratio : ratio
}
function labelStyle(value: number) {
  if (!props.clampEndpoints) return undefined
  const fraction = position(value)
  if (fraction === 1) return { transform: 'translateY(-100%)' }
  if (fraction === 0) return { transform: 'none' }
  return undefined
}
</script>

<style scoped>
:where(.analysis-probability-axis) {
  position: relative;
  width: var(--probability-axis-width, calc(4ch + var(--probability-axis-label-left, 0.32rem * var(--floating-panel-scale))));
  font-size: var(--ui-text-caption);
  color: rgba(210, 224, 221, 0.52);
  pointer-events: none;
}
.analysis-probability-axis > span { position: absolute; left: 0; width: 100%; height: 0; }
.analysis-probability-axis > span i {
  position: absolute; left: 0;
  width: var(--probability-axis-tick-width, calc(0.2rem * var(--floating-panel-scale)));
  border-top: 1px solid rgba(198, 214, 211, 0.42);
}
.analysis-probability-axis > span small {
  position: absolute; left: var(--probability-axis-label-left, calc(0.32rem * var(--floating-panel-scale)));
  color: rgba(210, 224, 221, 0.56); font-size: var(--ui-text-caption);
  font-variant-numeric: tabular-nums; line-height: 1; white-space: nowrap; transform: translateY(-50%);
}
</style>
