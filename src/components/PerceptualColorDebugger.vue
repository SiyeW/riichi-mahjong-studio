<template>
  <aside
    ref="panelElement"
    class="perceptual-color-debugger"
    :style="panelStyle"
    aria-label="界面调试"
  >
    <header class="perceptual-color-debugger-header" @pointerdown="startDragging">
      <strong>界面调试</strong>
      <button type="button" aria-label="关闭界面调试" @pointerdown.stop @click="$emit('close')">×</button>
    </header>

    <div class="perceptual-color-debugger-body">
      <label class="perceptual-color-debugger-toggle">
        <input
          type="checkbox"
          :checked="bypassed"
          @change="setBypassed(($event.target as HTMLInputElement).checked)"
        >
        暂时绕过矫正
      </label>

      <label v-for="control in controls" :key="control.key" class="perceptual-color-debugger-control">
        <span>{{ control.label }}</span>
        <input
          type="range"
          :min="control.min"
          :max="control.max"
          :step="control.step"
          :value="tuning[control.key]"
          @input="setTuningValue(control.key, Number(($event.target as HTMLInputElement).value))"
        >
        <input
          type="number"
          :min="control.min"
          :max="control.max"
          :step="control.step"
          :value="tuning[control.key]"
          @change="setTuningValue(control.key, Number(($event.target as HTMLInputElement).value))"
        >
      </label>

      <div class="perceptual-color-debugger-parameters">
        <code>{{ tuningJson }}</code>
        <button type="button" @click="$emit('reset')">恢复默认值</button>
      </div>

      <div class="perceptual-color-debugger-section">
        <strong>枚数预测</strong>
        <div class="perceptual-color-debugger-choice" role="group" aria-label="枚数预测布局">
          <button
            type="button"
            :class="{ active: countLayout === 'tile-groups' }"
            @click="$emit('update:countLayout', 'tile-groups')"
          >按牌分组</button>
          <button
            type="button"
            :class="{ active: countLayout === 'source-rows' }"
            @click="$emit('update:countLayout', 'source-rows')"
          >按来源分行</button>
        </div>
        <label v-for="control in spacingControls" :key="control.key" class="perceptual-color-debugger-control">
          <span>{{ control.label }}</span>
          <input
            type="range"
            :min="control.min"
            :max="control.max"
            :step="1"
            :value="countSpacing[control.key]"
            @input="setSpacingValue(control.key, Number(($event.target as HTMLInputElement).value))"
          >
          <input
            type="number"
            :min="control.min"
            :max="control.max"
            :step="1"
            :value="countSpacing[control.key]"
            @change="setSpacingValue(control.key, Number(($event.target as HTMLInputElement).value))"
          >
        </label>
        <small>单位为设备像素；牌山间距仅用于按牌分组。</small>
      </div>

      <div class="perceptual-color-debugger-surfaces">
        <div class="perceptual-color-debugger-surface-heading">
          <span>实际底色</span>
          <small>蓝 / 橙 / 绿 / 红</small>
        </div>
        <div v-for="surface in surfaces" :key="surface.label" class="perceptual-color-debugger-surface">
          <span>{{ surfaceName(surface.label) }}</span>
          <code>{{ surface.surface }}</code>
          <i
            v-for="(color, index) in surface.colors"
            :key="index"
            :style="{ backgroundColor: color }"
          />
        </div>
        <p v-if="!surfaces.length">打开分析板块后，这里会显示实际采样结果。</p>
      </div>

      <small class="perceptual-color-debugger-hint">F8 显示或隐藏；拖动标题可移动。</small>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ANALYSIS_COUNT_TILE_GAP_MAX,
  ANALYSIS_COUNT_WALL_GAP_MAX,
  normalizeAnalysisCountSpacing,
  type AnalysisCountSpacing,
  type AnalysisCountLayout,
} from '../analysisCountSpacing'
import type { PerceptualSurfaceTuning } from '../perceptualSurface'

type TuningKey = keyof PerceptualSurfaceTuning
type SpacingKey = keyof AnalysisCountSpacing
type SurfaceSnapshot = {
  label: string
  surface: string
  colors: string[]
}

const props = defineProps<{
  tuning: PerceptualSurfaceTuning
  bypassed: boolean
  countSpacing: AnalysisCountSpacing
  countLayout: AnalysisCountLayout
}>()

const emit = defineEmits<{
  close: []
  reset: []
  'update:tuning': [value: PerceptualSurfaceTuning]
  'update:bypassed': [value: boolean]
  'update:countSpacing': [value: AnalysisCountSpacing]
  'update:countLayout': [value: AnalysisCountLayout]
}>()

const controls: Array<{
  key: TuningKey
  label: string
  min: number
  max: number
  step: number
}> = [
  { key: 'lightnessCompensation', label: '亮度补偿', min: -2, max: 2, step: 0.01 },
  { key: 'chromaticCompensation', label: '色度位移', min: -3, max: 3, step: 0.01 },
  { key: 'surfaceChromaGain', label: '表面色度增益', min: -8, max: 8, step: 0.05 },
]

const spacingControls: Array<{
  key: SpacingKey
  label: string
  min: number
  max: number
}> = [
  { key: 'tileGapPixels', label: '牌张间距', min: 0, max: ANALYSIS_COUNT_TILE_GAP_MAX },
  { key: 'wallGapPixels', label: '牌山间距', min: 0, max: ANALYSIS_COUNT_WALL_GAP_MAX },
]

const panelElement = ref<HTMLElement | null>(null)
const panelPosition = ref({ x: 8, y: 80 })
const surfaces = ref<SurfaceSnapshot[]>([])
let collectFrame = 0
let dragPointerId: number | null = null
let dragOffset = { x: 0, y: 0 }

const panelStyle = computed(() => ({
  left: `${panelPosition.value.x}px`,
  top: `${panelPosition.value.y}px`,
}))

const tuningJson = computed(() => JSON.stringify({
  lightnessCompensation: props.tuning.lightnessCompensation,
  chromaticCompensation: props.tuning.chromaticCompensation,
  surfaceChromaGain: props.tuning.surfaceChromaGain,
}))

const preferredSurfaceOrder = [
  'table-panel',
  'game-outcome-track',
  'analysis-risk-track',
  'analysis-count-panel',
]

function surfaceName(label: string) {
  return ({
    'table-panel': '牌桌',
    'game-outcome-track': '本局走向',
    'analysis-risk-track': '铳率预测',
    'analysis-count-panel': '枚数预测',
  } as Record<string, string>)[label] || label
}

function setTuningValue(key: TuningKey, value: number) {
  if (!Number.isFinite(value)) return
  const control = controls.find((item) => item.key === key)
  if (!control) return
  emit('update:tuning', {
    ...props.tuning,
    [key]: Math.max(control.min, Math.min(control.max, value)),
  })
}

function setBypassed(value: boolean) {
  emit('update:bypassed', value)
}

function setSpacingValue(key: SpacingKey, value: number) {
  emit('update:countSpacing', normalizeAnalysisCountSpacing({
    ...props.countSpacing,
    [key]: value,
  }))
}

function scheduleCollectSurfaces() {
  cancelAnimationFrame(collectFrame)
  collectFrame = requestAnimationFrame(() => {
    collectFrame = requestAnimationFrame(collectSurfaces)
  })
}

function collectSurfaces() {
  collectFrame = 0
  const snapshots = new Map<string, SurfaceSnapshot>()
  document.querySelectorAll<HTMLElement>('[data-perceptual-surface-label]').forEach((element) => {
    const label = element.dataset.perceptualSurfaceLabel || ''
    if (!preferredSurfaceOrder.includes(label) || snapshots.has(label)) return
    const style = getComputedStyle(element)
    snapshots.set(label, {
      label,
      surface: element.dataset.perceptualSurfaceColor || '',
      colors: [
        style.getPropertyValue('--ron-kamicha-color'),
        style.getPropertyValue('--ron-toimen-color'),
        style.getPropertyValue('--ron-shimocha-color'),
        style.getPropertyValue('--analysis-self-deal-in-color'),
      ],
    })
  })
  surfaces.value = preferredSurfaceOrder.flatMap((label) => {
    const snapshot = snapshots.get(label)
    return snapshot ? [snapshot] : []
  })
}

function clampPanelPosition() {
  const panel = panelElement.value
  if (!panel) return
  panelPosition.value = {
    x: Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, panelPosition.value.x)),
    y: Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, panelPosition.value.y)),
  }
}

function startDragging(event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
  event.preventDefault()
  dragPointerId = event.pointerId
  dragOffset = {
    x: event.clientX - panelPosition.value.x,
    y: event.clientY - panelPosition.value.y,
  }
  window.addEventListener('pointermove', continueDragging)
  window.addEventListener('pointerup', stopDragging)
  window.addEventListener('pointercancel', stopDragging)
}

function continueDragging(event: PointerEvent) {
  if (event.pointerId !== dragPointerId) return
  panelPosition.value = {
    x: event.clientX - dragOffset.x,
    y: event.clientY - dragOffset.y,
  }
  clampPanelPosition()
}

function stopDragging(event: PointerEvent) {
  if (event.pointerId !== dragPointerId) return
  dragPointerId = null
  window.removeEventListener('pointermove', continueDragging)
  window.removeEventListener('pointerup', stopDragging)
  window.removeEventListener('pointercancel', stopDragging)
}

function handleSurfaceChange() {
  scheduleCollectSurfaces()
}

watch(
  () => [props.tuning.lightnessCompensation, props.tuning.chromaticCompensation, props.tuning.surfaceChromaGain, props.bypassed],
  async () => {
    await nextTick()
    scheduleCollectSurfaces()
  },
)

onMounted(() => {
  document.addEventListener('perceptual-surface-change', handleSurfaceChange, true)
  window.addEventListener('resize', clampPanelPosition)
  scheduleCollectSurfaces()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(collectFrame)
  document.removeEventListener('perceptual-surface-change', handleSurfaceChange, true)
  window.removeEventListener('resize', clampPanelPosition)
  window.removeEventListener('pointermove', continueDragging)
  window.removeEventListener('pointerup', stopDragging)
  window.removeEventListener('pointercancel', stopDragging)
})
</script>

<style scoped>
.perceptual-color-debugger {
  position: fixed;
  z-index: 1200;
  width: min(21rem, calc(100vw - 1rem));
  color: #d7e5e8;
  background: #073e48;
  border: 1px solid #2b6975;
}

.perceptual-color-debugger-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 2rem;
  padding-left: 0.65rem;
  background: #094855;
  border-bottom: 1px solid #2b6975;
  cursor: move;
  user-select: none;
}

.perceptual-color-debugger-header strong {
  font-size: var(--ui-text-heading);
  line-height: 1.2;
}

.perceptual-color-debugger-header button {
  width: 2rem;
  height: 2rem;
  padding: 0;
  color: #b9d0d5;
  background: transparent;
  border: 0;
  font: inherit;
  font-size: var(--floating-icon-close-size);
}

.perceptual-color-debugger-header button:hover {
  color: #fff;
  background: #0d5361;
}

.perceptual-color-debugger-body {
  display: grid;
  gap: 0.55rem;
  padding: 0.7rem;
}

.perceptual-color-debugger-section {
  display: grid;
  gap: 0.45rem;
  padding-top: 0.55rem;
  border-top: 1px solid #2b6975;
}

.perceptual-color-debugger-section > strong {
  font-size: var(--ui-text-body);
}

.perceptual-color-debugger-section > small {
  color: #a9c3c8;
  font-size: var(--ui-text-caption);
}

.perceptual-color-debugger-choice {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  padding: 1px;
  background: #2b6975;
}

.perceptual-color-debugger-choice button {
  padding: 0.3rem 0.45rem;
  color: #c5d9dd;
  background: #053942;
  border: 0;
  font: inherit;
}

.perceptual-color-debugger-choice button:hover {
  background: #0b5260;
}

.perceptual-color-debugger-choice button.active {
  color: #fff;
  background: #137a3d;
}

.perceptual-color-debugger-toggle {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}

.perceptual-color-debugger-control {
  display: grid;
  grid-template-columns: 5.75rem minmax(0, 1fr) 3.75rem;
  align-items: center;
  gap: 0.45rem;
}

.perceptual-color-debugger-control > span,
.perceptual-color-debugger-toggle,
.perceptual-color-debugger-surfaces,
.perceptual-color-debugger-hint {
  font-size: var(--ui-text-body);
}

.perceptual-color-debugger-control input[type='range'] {
  min-width: 0;
  accent-color: #4caf50;
}

.perceptual-color-debugger-control input[type='number'] {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 0.2rem 0.3rem;
  color: #e5f0f2;
  background: #053942;
  border: 1px solid #2b6975;
  font: inherit;
  font-variant-numeric: tabular-nums;
}

.perceptual-color-debugger-parameters {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}

.perceptual-color-debugger-parameters code {
  flex: 1;
  min-width: 0;
  color: #c8dcdf;
  font-size: var(--ui-text-caption);
  overflow-wrap: anywhere;
}

.perceptual-color-debugger-parameters button {
  padding: 0.28rem 0.5rem;
  color: #d7e5e8;
  background: #0b5260;
  border: 1px solid #2b6975;
  font: inherit;
}

.perceptual-color-debugger-parameters button:hover {
  background: #106171;
}

.perceptual-color-debugger-surfaces {
  display: grid;
  gap: 1px;
  background: #174f59;
  border: 1px solid #2b6975;
}

.perceptual-color-debugger-surface-heading,
.perceptual-color-debugger-surface {
  display: grid;
  grid-template-columns: minmax(5.5rem, 1fr) 6.5rem repeat(4, 1rem);
  align-items: center;
  gap: 0.28rem;
  min-height: 1.55rem;
  padding: 0 0.4rem;
  background: #073e48;
}

.perceptual-color-debugger-surface-heading {
  background: #094855;
}

.perceptual-color-debugger-surface-heading small {
  grid-column: 2 / -1;
  color: #9ebbc1;
  text-align: right;
}

.perceptual-color-debugger-surface code {
  color: #9ebbc1;
  font-size: var(--ui-text-caption);
}

.perceptual-color-debugger-surface i {
  width: 1rem;
  height: 1rem;
  border: 1px solid rgb(255 255 255 / 18%);
}

.perceptual-color-debugger-surfaces p {
  margin: 0;
  padding: 0.45rem;
  background: #073e48;
  color: #9ebbc1;
}

.perceptual-color-debugger-hint {
  color: #9ebbc1;
}
</style>
