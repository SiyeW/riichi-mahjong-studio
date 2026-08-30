<template>
  <Teleport :to="portalTarget">
    <div
      ref="tooltipElement"
      :id="tooltipId"
      class="ui-hover-tooltip ui-hover-tooltip-portal count-prediction-tooltip"
      :style="{ left: `${position.left}px`, top: `${position.top}px`, visibility: positioned ? 'visible' : 'hidden' }"
      role="tooltip"
    >
      <strong class="count-tooltip-heading">
        <i :style="{ backgroundColor: palette[2] }" aria-hidden="true" />
        {{ sourceLabel }}
      </strong>
      <div class="count-tooltip-content">
        <div class="count-tooltip-diagram">
          <div v-if="entries.length" class="count-tooltip-stack" aria-hidden="true">
            <i
              v-for="entry in entries"
              :key="entry.count"
              :style="{ flexGrow: entry.probability, backgroundColor: entry.color }"
            />
          </div>
          <img class="count-tooltip-tile" :src="tileImage" :alt="tileLabel" />
        </div>
        <div class="count-tooltip-details">
          <div v-if="entries.length" class="count-tooltip-key">
            <div v-for="entry in entries" :key="entry.count" class="count-tooltip-entry">
              <i :style="{ backgroundColor: entry.color }" aria-hidden="true" />
              <span>{{ t('analysis.countUnit', { value: entry.count }) }}</span>
              <span>{{ formatProbability(entry.probability) }}</span>
            </div>
          </div>
          <span v-if="scalarLabel" class="count-tooltip-estimate">{{ scalarLabel }}</span>
          <span v-else-if="!entries.length" class="count-tooltip-estimate">{{ t('analysis.noData') }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from '../i18n'
import { countTooltipDistribution } from '../countTooltip'
import type { NumericPrediction } from '../numericPrediction'

const props = defineProps<{
  anchor: Element
  sourceLabel: string
  tileImage: string
  tileLabel: string
  redFive: boolean
  prediction: NumericPrediction
  palette: string[]
}>()
const emit = defineEmits<{ close: [] }>()
const { t, numberLocale } = useI18n()
const tooltipId = useId()
// Keep the shared UI tokens without inheriting the dock's clipping region.
const portalTarget = computed(() => props.anchor.closest('.shell') || document.body)
const tooltipElement = ref<HTMLElement | null>(null)
const position = ref({ left: 0, top: 0 })
const positioned = ref(false)
let positionFrame = 0

const entries = computed(() => countTooltipDistribution(props.prediction.distribution, props.redFive, props.palette))
const scalarLabel = computed(() => {
  if (props.prediction.scalarValue === null) return ''
  if (props.prediction.scalarSource === 'distribution' && !entries.value.length) return ''
  const value = props.prediction.scalarValue.toLocaleString(numberLocale.value, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return t(props.prediction.scalarSource === 'point-estimate' ? 'analysis.predictedCount' : 'analysis.expectedCount', { value })
})

function formatProbability(value: number): string {
  if (value === 0) return value.toLocaleString(numberLocale.value, { style: 'percent' })
  if (value < 0.0001) {
    return `<${(0.0001).toLocaleString(numberLocale.value, { style: 'percent', minimumFractionDigits: 2 })}`
  }
  const digits = value < 0.001 ? 2 : 1
  return value.toLocaleString(numberLocale.value, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function placeTooltip() {
  const tooltip = tooltipElement.value
  if (!tooltip || !props.anchor.isConnected) return
  const anchor = props.anchor.getBoundingClientRect()
  const bounds = tooltip.getBoundingClientRect()
  const inset = 8
  const gap = 8
  const above = anchor.top - inset
  const below = window.innerHeight - anchor.bottom - inset
  const preferAbove = above >= bounds.height + gap || above >= below
  const top = preferAbove ? anchor.top - bounds.height - gap : anchor.bottom + gap
  position.value = {
    left: Math.max(inset, Math.min(window.innerWidth - bounds.width - inset, anchor.left + (anchor.width - bounds.width) / 2)),
    top: Math.max(inset, Math.min(window.innerHeight - bounds.height - inset, top)),
  }
  positioned.value = true
}

function schedulePosition() {
  cancelAnimationFrame(positionFrame)
  positioned.value = false
  void nextTick(() => { positionFrame = requestAnimationFrame(placeTooltip) })
}

function dismiss() { emit('close') }
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') dismiss()
}

function removeDescription(anchor: Element) {
  const ids = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== tooltipId)
  if (ids.length) anchor.setAttribute('aria-describedby', ids.join(' '))
  else anchor.removeAttribute('aria-describedby')
}

watch(() => props.anchor, (anchor, previous) => {
  if (previous) removeDescription(previous)
  const ids = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
  anchor.setAttribute('aria-describedby', [...new Set([...ids, tooltipId])].join(' '))
}, { immediate: true })

onMounted(() => {
  schedulePosition()
  window.addEventListener('resize', dismiss)
  window.addEventListener('scroll', dismiss, true)
  window.addEventListener('keydown', onKeydown)
})
watch(() => [props.anchor, props.prediction, props.palette, numberLocale.value], schedulePosition)
onBeforeUnmount(() => {
  removeDescription(props.anchor)
  cancelAnimationFrame(positionFrame)
  window.removeEventListener('resize', dismiss)
  window.removeEventListener('scroll', dismiss, true)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.count-tooltip-heading {
  display: flex;
  align-items: center;
  gap: calc(0.4rem * var(--chrome-scale));
}

.count-tooltip-heading i,
.count-tooltip-entry i {
  display: block;
  flex: 0 0 auto;
  width: calc(0.65rem * var(--chrome-scale));
  height: calc(0.65rem * var(--chrome-scale));
}

.count-tooltip-content {
  display: grid;
  grid-template-columns: calc(1.25rem * var(--chrome-scale)) max-content;
  align-items: center;
  column-gap: calc(0.65rem * var(--chrome-scale));
}

.count-tooltip-diagram {
  display: grid;
  align-self: start;
  gap: calc(0.086rem * var(--chrome-scale));
}

.count-tooltip-details {
  display: grid;
  align-self: stretch;
  align-content: space-between;
  gap: calc(0.4rem * var(--chrome-scale));
}

.count-tooltip-stack {
  display: flex;
  flex-direction: column;
  /* The same 100% chart for every tile, independent of legend row count. */
  height: calc(6rem * var(--chrome-scale));
  overflow: hidden;
}

.count-tooltip-stack i {
  display: block;
  flex-basis: 0;
  min-height: 0;
}

.count-tooltip-key {
  display: grid;
  grid-template-columns: auto auto auto;
  align-items: center;
  column-gap: calc(0.4rem * var(--chrome-scale));
  row-gap: calc(0.125rem * var(--chrome-scale));
}

.count-tooltip-entry {
  display: grid;
  grid-template-columns: subgrid;
  grid-column: 1 / -1;
  align-items: center;
}

.count-tooltip-entry > :last-child {
  padding-left: calc(0.4rem * var(--chrome-scale));
  color: var(--text-main);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.count-tooltip-tile {
  display: block;
  box-sizing: border-box;
  width: 100%;
  aspect-ratio: 2.45 / 3.18;
  padding: calc(0.07rem * var(--chrome-scale));
  border-radius: calc(0.11rem * var(--chrome-scale));
  background: #fff;
  filter: brightness(92%) saturate(80%);
}

.count-tooltip-estimate {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
