<template>
  <section
    class="analysis-float-panel custom-tenhou-export-window"
    :style="{ '--floating-panel-scale': scale, zIndex }"
    @mousedown="emit('focus')"
    @focusin="emit('focus')"
  >
    <div class="floating-panel-header" @mousedown="emit('start-drag', $event)">
      <span>{{ t('export.title') }}</span>
      <div class="floating-panel-header-actions">
        <button class="floating-panel-close" :aria-label="t('export.close')" @click="emit('close')">&times;</button>
      </div>
    </div>
    <p v-if="loading" class="custom-tenhou-export-state">{{ t('export.generating') }}</p>
    <p v-else-if="errorMessage" class="custom-tenhou-export-state is-error">{{ errorMessage }}</p>
    <div v-else class="custom-tenhou-export-fields">
      <label v-for="field in fields" :key="field.key">
        <span class="custom-tenhou-export-label">
          <strong>{{ field.label }}</strong>
          <button class="floating-panel-action" @click="copyField(field.key)">
            {{ copiedKey === field.key ? t('common.copied') : t('common.copy') }}
          </button>
        </span>
        <textarea :value="field.value" readonly spellcheck="false"></textarea>
      </label>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from '../i18n'

const { t } = useI18n()

type ExportFieldKey = 'tenhou' | 'mortal' | 'naga'

const props = defineProps<{
  scale: number
  zIndex: number
  refreshKey: number
}>()

const emit = defineEmits<{
  close: []
  focus: []
  'start-drag': [event: MouseEvent]
}>()

const loading = ref(false)
const errorMessage = ref('')
const values = reactive<Record<ExportFieldKey, string>>({ tenhou: '', mortal: '', naga: '' })
const copiedKey = ref<ExportFieldKey | ''>('')
let requestGeneration = 0
let copiedTimer: number | null = null
let refreshTimer: number | null = null

const fields = computed(() => [
  { key: 'tenhou' as const, label: t('export.tenhou'), value: values.tenhou },
  { key: 'mortal' as const, label: t('export.mortal'), value: values.mortal },
  { key: 'naga' as const, label: t('export.naga'), value: values.naga },
])

async function refresh(showLoading = false) {
  if (!window.trainerAPI?.exportCustomTenhou) return
  const generation = ++requestGeneration
  if (showLoading) loading.value = true
  errorMessage.value = ''
  try {
    const result = await window.trainerAPI.exportCustomTenhou()
    if (generation !== requestGeneration) return
    values.tenhou = result.tenhou || ''
    values.mortal = result.mortal || ''
    values.naga = result.naga || ''
  } catch (error) {
    if (generation !== requestGeneration) return
    errorMessage.value = error instanceof Error ? error.message : t('export.failed')
  } finally {
    if (generation === requestGeneration) loading.value = false
  }
}

function scheduleRefresh() {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    void refresh()
  }, 120)
}

async function copyField(key: ExportFieldKey) {
  const value = values[key]
  if (!value || !window.trainerAPI?.writeClipboardText) return
  await window.trainerAPI.writeClipboardText(value)
  copiedKey.value = key
  if (copiedTimer !== null) window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copiedKey.value = ''
    copiedTimer = null
  }, 3000)
}

watch(() => props.refreshKey, scheduleRefresh)

onMounted(() => {
  void refresh(true)
})

onBeforeUnmount(() => {
  requestGeneration += 1
  if (copiedTimer !== null) window.clearTimeout(copiedTimer)
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
})
</script>

<style scoped>
.custom-tenhou-export-window {
  top: calc(4rem * var(--floating-panel-scale));
  right: calc(1.25rem * var(--floating-panel-scale));
  width: min(calc(48rem * var(--floating-panel-scale)), 94vw);
  max-height: calc(100vh - var(--footer-min-h) - 5rem * var(--floating-panel-scale));
  overflow: auto;
}

.custom-tenhou-export-state {
  margin: 0;
  padding: calc(2rem * var(--floating-panel-scale));
  color: var(--text-dim);
  font-size: var(--ui-text-body);
  text-align: center;
}

.custom-tenhou-export-state.is-error {
  color: var(--accent-red);
}

.custom-tenhou-export-fields {
  display: grid;
  gap: calc(0.7rem * var(--floating-panel-scale));
  padding-top: calc(0.65rem * var(--floating-panel-scale));
}

.custom-tenhou-export-fields label {
  display: grid;
  gap: calc(0.25rem * var(--floating-panel-scale));
}

.custom-tenhou-export-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(0.6rem * var(--floating-panel-scale));
  color: var(--text-dim);
  font-size: var(--ui-text-body);
}

.custom-tenhou-export-fields textarea {
  width: 100%;
  min-height: calc(6rem * var(--floating-panel-scale));
  resize: vertical;
  padding: calc(0.45rem * var(--floating-panel-scale));
  border: 1px solid rgba(140, 195, 188, 0.16);
  border-radius: calc(3px * var(--floating-panel-scale));
  background: rgba(0, 29, 35, 0.5);
  color: rgba(224, 240, 236, 0.86);
  font-family: ui-monospace, monospace;
  font-size: var(--ui-text-caption);
  line-height: 1.45;
}
</style>
