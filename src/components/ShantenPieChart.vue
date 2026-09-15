<template>
  <div class="shanten-chart">
    <svg
      viewBox="-1 -1 2 2"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      :class="{ 'is-empty': isEmpty }"
      :aria-label="chartAriaLabel"
    >
      <circle
        v-if="isEmpty"
        class="shanten-empty-ring"
        cx="0"
        cy="0"
        r="0.96"
      />
      <template v-else>
        <path
          v-for="(slice, index) in slices"
          :key="index"
          :d="slice.path"
          :fill="slice.color"
          :stroke="slice.color"
          :stroke-width="slice.probability > 0 ? 0.012 : 0"
          stroke-linejoin="round"
          @mouseenter="emit('slice-enter', $event, slice.label, slice.probability)"
          @mouseleave="emit('slice-leave')"
        />
        <text
          v-for="slice in labeledSlices"
          :key="slice.text"
          class="shanten-slice-label"
          :x="slice.textX"
          :y="slice.textY"
        >{{ slice.text }}</text>
      </template>
    </svg>
    <div class="shanten-opp-label">{{ label }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../i18n'

const { t } = useI18n()

const props = defineProps<{
  label: string
  probabilities: number[]
  colors: string[]
  sliceLabels: string[]
  shortLabels: string[]
  reduceMotion: boolean
}>()

const emit = defineEmits<{
  'slice-enter': [event: MouseEvent, label: string, probability: number]
  'slice-leave': []
}>()

function normalizeProbabilities(values: number[]): number[] {
  const sanitized = props.sliceLabels.map((_, index) => Math.max(0, Number(values[index]) || 0))
  const total = sanitized.reduce((sum, probability) => sum + probability, 0)
  if (total > 0) return sanitized.map((probability) => probability / total)
  return props.sliceLabels.map(() => 0)
}

const normalizedProbabilities = computed(() => normalizeProbabilities(props.probabilities))
const isEmpty = computed(() => normalizedProbabilities.value.every((value) => value === 0))
const chartAriaLabel = computed(() => (
  isEmpty.value
    ? t('shanten.emptyAria', { opponent: props.label })
    : t('shanten.chartAria', { opponent: props.label })
))
const slices = computed(() => {
  let cumulative = 0
  return normalizedProbabilities.value.map((probability, index) => {
    const startAngle = (cumulative * 2 * Math.PI) - (Math.PI / 2)
    cumulative += probability
    const endAngle = (cumulative * 2 * Math.PI) - (Math.PI / 2)
    const middleAngle = (startAngle + endAngle) / 2
    const isFullCircle = probability >= 0.999999
    const textRadius = 0.62
    const x1 = Math.cos(startAngle)
    const y1 = Math.sin(startAngle)
    const x2 = Math.cos(endAngle)
    const y2 = Math.sin(endAngle)
    const largeArc = probability > 0.5 ? 1 : 0
    return {
      path: isFullCircle
        ? 'M 0 -1 A 1 1 0 1 1 0 1 A 1 1 0 1 1 0 -1 Z'
        : `M 0 0 L ${x1} ${y1} A 1 1 0 ${largeArc} 1 ${x2} ${y2} Z`,
      color: props.colors[index],
      label: props.sliceLabels[index],
      probability,
      text: props.shortLabels[index],
      textX: Math.cos(middleAngle) * textRadius,
      textY: Math.sin(middleAngle) * textRadius,
    }
  })
})

const labeledSlices = computed(() => slices.value.filter((slice) => slice.probability > 0.05))
</script>

<style scoped>
.shanten-empty-ring {
  fill: none;
  stroke: rgb(164 177 177 / 45%);
  stroke-width: 0.08;
}

svg.is-empty {
  animation: none;
}
</style>

<style scoped src="./ShantenPieChart.css"></style>
