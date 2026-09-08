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

const props = defineProps<{
  mode: TrainerStatusSnapshot['mode']
  gameLoaded: boolean
  controlledSeat: number
  seatSwitchInFlight: boolean
  pendingSeatSwitchLabel: string
  currentTrainingMode: TrainerSettings['training']['mode']
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
  'training-mode-change': [mode: TrainerSettings['training']['mode']]
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
