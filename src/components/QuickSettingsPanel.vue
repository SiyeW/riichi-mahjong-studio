<template>
  <div class="settings-preview quick-training-panel" :class="{ collapsed }">
    <button class="panel-section-toggle" @click="collapsed = !collapsed">
      <h3>{{ t('console.options') }}</h3>
      <span>{{ collapsed ? t('console.expand') : t('console.collapse') }}</span>
    </button>
    <div v-if="!collapsed" class="quick-training-content">
      <div class="quick-audio-block quick-time-block">
        <div class="quick-time-header">
          <span>{{ t('console.volume') }}</span>
          <strong>{{ audioVolumeLabel }}</strong>
        </div>
        <div class="quick-time-slider-wrap">
          <div class="quick-time-track">
            <span class="quick-time-track-bg"></span>
            <span class="quick-time-track-fill" :style="{ width: `${audioVolumePercent}%` }"></span>
            <span class="quick-time-thumb" :style="{ left: `${audioVolumePercent}%` }"></span>
          </div>
          <input
            class="quick-time-range"
            type="range"
            min="0"
            max="100"
            step="1"
            :value="audioVolumeValue"
            @input="emit('audio-input', $event)"
            @change="emit('audio-change', $event)"
          />
        </div>
      </div>
      <div v-if="mode === 'research'" class="quick-seat-block">
        <span class="seat-switch-label">{{ t('console.switchSeat') }}</span>
        <div v-adaptive-button-grid="{ columns: [4, 2, 1] }" class="seat-buttons seat-buttons-compact">
          <button
            v-for="option in relativeSeatOptions"
            :key="option.label"
            :disabled="!gameLoaded || seatSwitchInFlight || controlledSeat === option.seat"
            :class="{
              active: controlledSeat === option.seat,
              'is-pending': seatSwitchInFlight && pendingSeatSwitchLabel === option.label,
            }"
            @click="emit('seat-switch', option.seat, option.label)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <div v-if="mode === 'play'" class="quick-subsection">
        <span class="quick-subsection-label">{{ t('console.reviewMode') }}</span>
        <div v-adaptive-button-grid="{ columns: [4, 2, 1] }" class="quick-training-mode-row">
          <button
            v-for="option in trainingModes"
            :key="option.value"
            class="quick-mode-btn"
            :class="{ active: currentTrainingMode === option.value }"
            @click="emit('training-mode-change', option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <div v-if="mode === 'play'" class="quick-time-block">
        <div class="quick-time-header">
          <span>{{ t('console.thinkingDelay') }}</span>
          <strong>{{ maxThinkingLabel }}</strong>
        </div>
        <div class="quick-time-slider-wrap">
          <div class="quick-time-track">
            <span class="quick-time-track-bg"></span>
            <span class="quick-time-track-fill" :style="{ width: `${maxThinkingPercent}%` }"></span>
            <span class="quick-time-marker quick-time-marker-min" :style="{ left: `${minThinkingPercent}%` }" v-ui-tooltip="t('console.minimumThinkingTime')"></span>
            <span class="quick-time-marker quick-time-marker-auto" :style="{ left: `${autoAdvancePercent}%` }" v-ui-tooltip="t('console.autoAdvanceUnit')"></span>
            <span class="quick-time-thumb" :style="{ left: `${maxThinkingPercent}%` }"></span>
          </div>
          <input
            class="quick-time-range"
            type="range"
            min="0"
            max="4"
            step="0.05"
            :value="thinkingMaxValue"
            @input="emit('thinking-input', $event)"
            @change="emit('thinking-change', $event)"
          />
        </div>
        <div class="quick-time-legend">
          <span>{{ t('console.minimumShort', { value: minThinkingLabel }) }}</span>
          <span>{{ t('console.advanceShort', { value: autoAdvanceLabel }) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { vAdaptiveButtonGrid } from '../adaptiveButtonGrid'
import { useI18n } from '../i18n'
import type { StudioSettings } from '../contracts/settings'

const props = defineProps<{
  mode: TrainerStatusSnapshot['mode']
  gameLoaded: boolean
  controlledSeat: number
  seatSwitchInFlight: boolean
  pendingSeatSwitchLabel: string
  currentTrainingMode: StudioSettings['training']['mode']
  audioVolumeLabel: string
  audioVolumePercent: number
  audioVolumeValue: number
  thinkingMaxValue: number
  maxThinkingPercent: number
  minThinkingPercent: number
  autoAdvancePercent: number
  maxThinkingLabel: string
  minThinkingLabel: string
  autoAdvanceLabel: string
}>()

const emit = defineEmits<{
  'audio-input': [event: Event]
  'audio-change': [event: Event]
  'seat-switch': [seat: number, label: string]
  'training-mode-change': [mode: StudioSettings['training']['mode']]
  'thinking-input': [event: Event]
  'thinking-change': [event: Event]
}>()

const { t } = useI18n()
const collapsed = ref(false)
const relativeSeatOptions = computed(() => ([
  { label: t('seat.kamicha'), seat: (props.controlledSeat + 3) % 4 },
  { label: t('seat.self'), seat: props.controlledSeat },
  { label: t('seat.shimocha'), seat: (props.controlledSeat + 1) % 4 },
  { label: t('seat.toimen'), seat: (props.controlledSeat + 2) % 4 },
]))
const trainingModes = computed(() => [
  { value: 'no_review', label: t('mode.noReview') },
  { value: 'threshold_review', label: t('mode.difference') },
  { value: 'always_review', label: t('mode.all') },
  { value: 'preview_before_click', label: t('mode.preview') },
] as const)
</script>

<style scoped>
.quick-training-panel {
  display: grid;
  gap: 0;
}

.quick-training-content {
  display: grid;
  gap: calc(0.5rem * var(--chrome-scale));
  min-width: 0;
}

.quick-audio-block {
  width: 100%;
}

.quick-seat-block .seat-buttons button,
.quick-mode-btn {
  padding-top: calc(0.34rem * var(--chrome-scale));
  padding-bottom: calc(0.34rem * var(--chrome-scale));
  line-height: 1.2;
  border-radius: calc(0.1875rem * var(--chrome-scale));
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quick-seat-block .seat-buttons button {
  padding-right: clamp(calc(0.3rem * var(--ui-scale)), 2.5cqi, calc(0.75rem * var(--ui-scale)));
  padding-left: clamp(calc(0.3rem * var(--ui-scale)), 2.5cqi, calc(0.75rem * var(--ui-scale)));
}

.quick-subsection {
  display: grid;
  gap: calc(0.22rem * var(--chrome-scale));
}

.quick-subsection-label,
.seat-switch-label {
  font-size: var(--ui-text-body);
  color: var(--text-dim);
}

.quick-seat-block {
  display: grid;
  gap: calc(0.24rem * var(--chrome-scale));
}

.quick-training-mode-row {
  display: grid;
  grid-template-columns: repeat(var(--adaptive-button-columns, 4), minmax(max-content, 1fr));
  gap: calc(0.3rem * var(--chrome-scale));
}

.quick-mode-btn {
  border: 1px solid rgba(0, 0, 0, 0.28);
  background: rgba(8, 80, 94, 0.72);
  color: var(--text-main);
  font-size: var(--ui-text-control);
  padding-left: calc(0.3rem * var(--ui-scale));
  padding-right: calc(0.3rem * var(--ui-scale));
  cursor: pointer;
  transition:
    background var(--ui-motion-duration) var(--ui-motion-easing),
    box-shadow var(--ui-motion-duration) var(--ui-motion-easing),
    transform var(--ui-motion-duration) var(--ui-motion-easing);
}

.quick-mode-btn.active {
  border-color: rgba(0, 0, 0, 0.28);
  background: rgba(23, 122, 70, 0.9);
  box-shadow: none;
}

.quick-time-block {
  display: grid;
  gap: calc(0.12rem * var(--chrome-scale));
}

.quick-time-block > .quick-time-slider-wrap {
  height: calc(1.25rem * var(--chrome-scale));
}

.quick-time-header,
.quick-time-legend {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(0.5rem * var(--chrome-scale));
  font-size: var(--ui-text-body);
  color: var(--text-dim);
  min-width: 0;
}

.quick-time-header > span,
.quick-time-legend > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quick-time-header strong {
  flex: 0 0 auto;
  color: var(--text-main);
  font-size: var(--ui-text-control);
  font-variant-numeric: tabular-nums;
}

.quick-time-slider-wrap {
  position: relative;
  height: calc(1.9rem * var(--chrome-scale));
}

.quick-time-track {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  height: calc(0.34rem * var(--chrome-scale));
  border-radius: calc(999px * var(--chrome-scale));
  overflow: visible;
}

.quick-time-track-bg,
.quick-time-track-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  border-radius: inherit;
}

.quick-time-track-bg {
  width: 100%;
  background: rgba(235, 235, 235, 0.32);
}

.quick-time-track-fill {
  background: #1a931a;
}

.quick-time-thumb,
.quick-time-marker {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  border-radius: 999px;
  pointer-events: none;
}

.quick-time-thumb {
  width: calc(1rem * var(--ui-scale));
  height: calc(1rem * var(--ui-scale));
  background: #ebf8ee;
  border: 1px solid rgba(0, 0, 0, 0.28);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.22);
}

.quick-time-marker {
  width: calc(0.6875rem * var(--ui-scale));
  height: calc(0.6875rem * var(--ui-scale));
  background: rgba(220, 244, 240, 0.42);
  border: 1px solid rgba(220, 244, 240, 0.25);
}

.quick-time-range {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.seat-buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: calc(0.18rem * var(--chrome-scale));
}

.seat-buttons-compact {
  grid-template-columns: repeat(var(--adaptive-button-columns, 4), minmax(max-content, 1fr));
}

.seat-buttons button.active {
  border-color: rgba(0, 0, 0, 0.28);
  background: rgba(23, 122, 70, 0.9);
  box-shadow: none;
}

.seat-buttons button:disabled {
  opacity: 0.42;
  cursor: default;
}

.seat-buttons button.active:disabled {
  opacity: 1;
}

.quick-seat-block .seat-buttons button.is-pending,
.quick-seat-block .seat-buttons button.is-pending:hover,
.quick-seat-block .seat-buttons button.is-pending:disabled {
  transform: none;
}
</style>
