<template>
  <div class="settings-modal-backdrop">
    <form class="settings-modal record-import-modal" @submit.prevent="submitImport">
      <div class="settings-modal-header">
        <h2>{{ t('import.title') }}</h2>
        <div class="settings-modal-actions">
          <button class="settings-btn-secondary" type="button" :disabled="importing" @click="emit('close')">{{ t('common.close') }}</button>
          <button class="settings-btn-primary" type="submit" :disabled="importing || !input.trim()">
            {{ importing ? t('import.importing') : t('common.import') }}
          </button>
        </div>
      </div>
      <p class="record-import-copy">{{ t('import.description.beforeMortal') }}<a href="https://mjai.ekyu.moe/zh-cn.html" @click.prevent="emit('open-external', 'https://mjai.ekyu.moe/zh-cn.html')">{{ t('import.description.mortal') }}</a>{{ t('import.description.between') }}<a href="https://tenhou.net/6/" @click.prevent="emit('open-external', 'https://tenhou.net/6/')">{{ t('import.description.tenhou') }}</a>{{ t('import.description.afterTenhou') }}</p>
      <label>
        <span>{{ t('import.source') }}</span>
        <textarea
          v-model="input"
          autocomplete="off"
          spellcheck="false"
          rows="8"
          placeholder="https://mjai.ekyu.moe/killerducky/?data=/report/....json&#10;https://tenhou.net/6/#json=...&#10;{&quot;title&quot;:...,&quot;name&quot;:...,&quot;rule&quot;:...,&quot;log&quot;:...}"
          autofocus
        ></textarea>
      </label>
      <label class="settings-checkbox settings-checkbox-with-description record-import-wall-option">
        <input v-model="reconstructWalls" type="checkbox" />
        <span class="settings-checkbox-control" aria-hidden="true"></span>
        <span class="settings-checkbox-copy">
          <span class="settings-checkbox-label">{{ t('import.reconstructWall') }}</span>
          <span class="settings-checkbox-description">{{ t('import.reconstructWall.description') }}</span>
        </span>
      </label>
      <label v-if="reconstructWalls">
        <span>{{ t('wall.seedOptional') }}</span>
        <input
          v-model.trim="seed"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          :placeholder="t('wall.seedPlaceholder')"
        />
      </label>
      <p v-if="errorMessage" class="record-import-error">{{ errorMessage }}</p>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '../i18n'

const { t } = useI18n()

const props = defineProps<{
  beforeImport: () => Promise<void>
}>()

const emit = defineEmits<{
  close: []
  imported: [result: TrainerRecordImportResult]
  'open-external': [url: string]
}>()

const input = ref('')
const importing = ref(false)
const reconstructWalls = ref(false)
const seed = ref('')
const errorMessage = ref('')

function isMortalReportInput(value: string): boolean {
  return /^https?:\/\/mjai\.ekyu\.moe\/(?:killerducky\/|progress\?|report\/)/i.test(value.trim())
}

async function submitImport() {
  if (!window.trainerAPI || importing.value || !input.value.trim()) return
  importing.value = true
  errorMessage.value = ''
  try {
    await props.beforeImport()
    const payload = {
      input: input.value,
      reconstructWalls: reconstructWalls.value,
      seed: seed.value,
    }
    const result = isMortalReportInput(input.value)
      ? await window.trainerAPI.importMortalReport(payload)
      : await window.trainerAPI.importCustomTenhou(payload)
    emit('imported', result)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : t('import.failed')
  } finally {
    importing.value = false
  }
}
</script>

<style scoped>
.record-import-modal {
  width: min(calc(41.25rem * var(--ui-scale)), 92vw);
}

.record-import-copy {
  margin-bottom: calc(0.75rem * var(--chrome-scale));
  color: var(--text-dim);
  font-size: var(--ui-font-md);
  line-height: 1.55;
}

.record-import-copy a {
  color: rgba(197, 243, 233, 0.95);
  text-decoration: none;
}

.record-import-copy a:hover {
  text-decoration: underline;
}

.record-import-error {
  margin-top: calc(0.65rem * var(--chrome-scale));
  padding: calc(0.5rem * var(--chrome-scale)) calc(0.6rem * var(--chrome-scale));
  border: 1px solid rgba(225, 114, 95, 0.35);
  background: rgba(116, 38, 28, 0.42);
  color: rgba(255, 225, 218, 0.94);
  font-size: var(--ui-font-md);
  line-height: 1.45;
}

.record-import-wall-option {
  margin-top: calc(0.3rem * var(--chrome-scale));
}
</style>
