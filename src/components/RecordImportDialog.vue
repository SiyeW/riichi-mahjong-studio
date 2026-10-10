<template>
  <div class="settings-modal-backdrop">
    <form class="settings-modal record-import-modal" @submit.prevent="submitImport">
      <div class="settings-modal-header">
        <h2>{{ t('import.title') }}</h2>
        <div class="settings-modal-actions">
          <button class="settings-btn-secondary" type="button" :disabled="importing" @click="emit('close')">{{ t('common.close') }}</button>
          <button class="settings-btn-primary" type="submit" :disabled="importing || selecting || (!input.trim() && !filePath)">
            {{ importing ? t('import.importing') : t('common.import') }}
          </button>
        </div>
      </div>
      <div class="record-import-file">
        <button class="settings-btn-secondary" type="button" :disabled="importing || selecting" @click="chooseFile">{{ t('import.chooseFile') }}</button>
        <span v-if="filePath" class="record-import-file-name">{{ filePath }}</span>
        <button v-if="filePath" class="settings-btn-secondary" type="button" :disabled="importing" @click="filePath = ''">{{ t('import.clearFile') }}</button>
      </div>
      <p class="record-import-copy">{{ t('import.fileTypes') }}</p>
      <p class="record-import-copy">{{ t('import.description.beforeMortal') }}<a href="https://mjai.ekyu.moe/zh-cn.html" @click.prevent="emit('open-external', 'https://mjai.ekyu.moe/zh-cn.html')">{{ t('import.description.mortal') }}</a>{{ t('import.description.between') }}<a href="https://tenhou.net/6/" @click.prevent="emit('open-external', 'https://tenhou.net/6/')">{{ t('import.description.tenhou') }}</a>{{ t('import.description.afterTenhou') }}</p>
      <label>
        <span>{{ t('import.source') }}</span>
        <textarea
          v-model="input"
          :disabled="importing || Boolean(filePath)"
          autocomplete="off"
          spellcheck="false"
          rows="8"
          placeholder="https://mjai.ekyu.moe/killerducky/?data=/report/....json&#10;https://tenhou.net/6/#json=...&#10;{&quot;title&quot;:...,&quot;name&quot;:...,&quot;rule&quot;:...,&quot;log&quot;:...}"
          autofocus
        ></textarea>
      </label>
      <label class="settings-checkbox settings-checkbox-with-description record-import-wall-option">
        <input v-model="reconstructWalls" type="checkbox" :disabled="importing" />
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
          :disabled="importing"
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
import type { RecordImportResult } from '../contracts/runtime'

const { t } = useI18n()

const props = defineProps<{
  beforeImport: () => Promise<void>
}>()

const emit = defineEmits<{
  close: []
  imported: [result: RecordImportResult]
  'busy-change': [busy: boolean]
  'open-external': [url: string]
}>()

const input = ref('')
const filePath = ref('')
const selecting = ref(false)
const importing = ref(false)
const reconstructWalls = ref(false)
const seed = ref('')
const errorMessage = ref('')

function isMortalReportInput(value: string): boolean {
  return /^https?:\/\/mjai\.ekyu\.moe\/(?:killerducky\/|progress\?|report\/)/i.test(value.trim())
}

async function submitImport() {
  if (!window.studioAPI || importing.value || selecting.value || (!input.value.trim() && !filePath.value)) return
  importing.value = true
  emit('busy-change', true)
  errorMessage.value = ''
  try {
    await props.beforeImport()
    const payload = {
      input: input.value,
      reconstructWalls: reconstructWalls.value,
      seed: seed.value,
    }
    const result = filePath.value
      ? await window.studioAPI.importReplayFile({ path: filePath.value, reconstructWalls: reconstructWalls.value, seed: seed.value })
      : isMortalReportInput(input.value)
      ? await window.studioAPI.importMortalReport(payload)
      : await window.studioAPI.importCustomTenhou(payload)
    emit('imported', result)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : t('import.failed')
  } finally {
    importing.value = false
    emit('busy-change', false)
  }
}

async function chooseFile() {
  if (!window.studioAPI || selecting.value) return
  selecting.value = true
  errorMessage.value = ''
  try {
    const selected = await window.studioAPI.selectRecordImportFile()
    if (selected) filePath.value = selected
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : t('import.failed')
  } finally {
    selecting.value = false
  }
}
</script>

<style scoped>
.record-import-file { display: flex; align-items: center; gap: .5em; min-width: 0; }
.record-import-file-name { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--text-dim); font-size: var(--ui-text-caption); }
.record-import-modal {
  width: min(calc(41.25rem * var(--ui-scale)), 92vw);
}

.record-import-copy {
  margin-bottom: calc(0.75rem * var(--chrome-scale));
  color: var(--text-dim);
  font-size: var(--ui-text-body);
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
  font-size: var(--ui-text-body);
  line-height: 1.45;
}

.record-import-wall-option {
  margin-top: calc(0.3rem * var(--chrome-scale));
}
</style>
