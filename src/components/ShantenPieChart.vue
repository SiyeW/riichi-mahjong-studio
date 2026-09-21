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
        ref="emptyRingElement"
        class="shanten-empty-ring"
        cx="0"
        cy="0"
        r="0.96"
      />
      <path
        v-for="(label, index) in sliceLabels"
        :key="label"
        :ref="(element) => setSliceElement(index, element)"
        d="M 0 0 Z"
        :fill="colors[index]"
        :stroke="colors[index]"
        stroke-width="0"
        stroke-linejoin="round"
        tabindex="-1"
        @mouseenter="enterSlice($event, index)"
        @mouseleave="leaveSlice(index)"
        @focus="enterSlice($event, index)"
        @blur="leaveSlice(index)"
      />
      <path
        v-if="highlightedSlicePath"
        class="shanten-hover-outline"
        :d="highlightedSlicePath"
        fill="none"
        stroke="rgba(228, 241, 237, 0.82)"
        stroke-width="0.035"
        stroke-linejoin="round"
      />
      <text
        v-for="(label, index) in shortLabels"
        :key="`${index}:${label}`"
        :ref="(element) => setLabelElement(index, element)"
        class="shanten-slice-label"
        x="0"
        y="0"
      >{{ label }}</text>
    </svg>
    <div class="shanten-opp-label">{{ label }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from '../i18n'
import { getUiMotionDurationMs, getUiMotionEasingFunction } from '../uiMotion'

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
  'slice-enter': [event: Event, label: string, probability: number]
  'slice-leave': []
}>()

type SliceGeometry = Readonly<{
  path: string
  probability: number
  textX: number
  textY: number
}>

const emptyRingElement = ref<SVGCircleElement | null>(null)
const sliceElements: Array<SVGPathElement | null> = []
const labelElements: Array<SVGTextElement | null> = []
const highlightedSliceIndex = ref<number | null>(null)
const highlightedSlicePath = ref('')
let displayedProbabilities: number[] = []
let animationFrame = 0

function normalizeProbabilities(values: readonly number[]): number[] {
  const sanitized = props.sliceLabels.map((_, index) => Math.max(0, Number(values[index]) || 0))
  const total = sanitized.reduce((sum, probability) => sum + probability, 0)
  if (total > 0) return sanitized.map((probability) => probability / total)
  return props.sliceLabels.map(() => 0)
}

function sliceGeometry(probabilities: readonly number[]): SliceGeometry[] {
  let cumulative = 0
  return probabilities.map((probability) => {
    const startAngle = (cumulative * 2 * Math.PI) - (Math.PI / 2)
    cumulative += probability
    const endAngle = (cumulative * 2 * Math.PI) - (Math.PI / 2)
    const middleAngle = (startAngle + endAngle) / 2
    const isFullCircle = probability >= 0.999999
    const x1 = Math.cos(startAngle)
    const y1 = Math.sin(startAngle)
    const x2 = Math.cos(endAngle)
    const y2 = Math.sin(endAngle)
    return {
      path: isFullCircle
        ? 'M 0 -1 A 1 1 0 1 1 0 1 A 1 1 0 1 1 0 -1 Z'
        : `M 0 0 L ${x1} ${y1} A 1 1 0 ${probability > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z`,
      probability,
      textX: Math.cos(middleAngle) * 0.62,
      textY: Math.sin(middleAngle) * 0.62,
    }
  })
}

function setSliceElement(index: number, element: unknown) {
  sliceElements[index] = element as SVGPathElement | null
}

function setLabelElement(index: number, element: unknown) {
  labelElements[index] = element as SVGTextElement | null
}

function renderProbabilities(probabilities: readonly number[]) {
  const slices = sliceGeometry(probabilities)
  const empty = slices.every(slice => slice.probability === 0)
  if (emptyRingElement.value) emptyRingElement.value.style.display = empty ? '' : 'none'
  slices.forEach((slice, index) => {
    const path = sliceElements[index]
    if (path) {
      path.setAttribute('d', slice.path)
      path.setAttribute('stroke-width', slice.probability > 0 ? '0.012' : '0')
      path.setAttribute('tabindex', slice.probability > 0 ? '0' : '-1')
      path.style.display = empty ? 'none' : ''
    }
    const label = labelElements[index]
    if (label) {
      label.setAttribute('x', String(slice.textX))
      label.setAttribute('y', String(slice.textY))
      label.style.display = !empty && slice.probability > 0.05 ? '' : 'none'
    }
  })
  const highlighted = highlightedSliceIndex.value
  if (highlighted !== null) highlightedSlicePath.value = slices[highlighted]?.path || ''
}

function enterSlice(event: Event, index: number) {
  highlightedSliceIndex.value = index
  highlightedSlicePath.value = sliceElements[index]?.getAttribute('d') || ''
  const target = normalizeProbabilities(props.probabilities)
  emit('slice-enter', event, props.sliceLabels[index] || '', target[index] || 0)
}

function leaveSlice(index: number) {
  if (highlightedSliceIndex.value === index) {
    highlightedSliceIndex.value = null
    highlightedSlicePath.value = ''
  }
  emit('slice-leave')
}

function stopAnimation() {
  if (!animationFrame) return
  cancelAnimationFrame(animationFrame)
  animationFrame = 0
}

function animateTo(values: readonly number[]) {
  stopAnimation()
  const source = normalizeProbabilities(displayedProbabilities)
  const target = normalizeProbabilities(values)
  if (!displayedProbabilities.length || props.reduceMotion || target.every((value, index) => Math.abs(value - source[index]) <= 1e-6)) {
    displayedProbabilities = target
    renderProbabilities(displayedProbabilities)
    return
  }
  const startedAt = performance.now()
  const duration = getUiMotionDurationMs()
  const easing = getUiMotionEasingFunction()
  const step = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / duration)
    const eased = easing(progress)
    displayedProbabilities = source.map(
      (value, index) => value + ((target[index] - value) * eased),
    )
    renderProbabilities(displayedProbabilities)
    if (progress < 1) animationFrame = requestAnimationFrame(step)
    else animationFrame = 0
  }
  animationFrame = requestAnimationFrame(step)
}

const normalizedTarget = computed(() => normalizeProbabilities(props.probabilities))
const isEmpty = computed(() => normalizedTarget.value.every(value => value === 0))
const chartAriaLabel = computed(() => (
  isEmpty.value
    ? t('shanten.emptyAria', { opponent: props.label })
    : t('shanten.chartAria', { opponent: props.label })
))

watch(() => props.probabilities, values => {
  void nextTick(() => animateTo(values))
})
watch(() => props.reduceMotion, (reduced) => {
  if (reduced) animateTo(props.probabilities)
})
watch(() => [props.colors, props.sliceLabels, props.shortLabels], () => {
  void nextTick(() => renderProbabilities(displayedProbabilities))
})

onMounted(() => {
  displayedProbabilities = normalizeProbabilities(props.probabilities)
  renderProbabilities(displayedProbabilities)
})
onBeforeUnmount(stopAnimation)
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
