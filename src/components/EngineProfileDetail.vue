<template>
  <div class="engine-profile-detail">
    <label>
      <span>{{ t('engine.displayName') }}</span>
      <input :value="detail.name" :placeholder="detail.suggestedName" :disabled="detail.locked" type="text" @input="emit('name', ($event.target as HTMLInputElement).value)" />
    </label>
    <div class="engine-weight-field">
      <span>{{ t('engine.executable') }}</span>
      <div>
        <input :value="detail.enginePath" :disabled="detail.locked" readonly type="text" :placeholder="t('engine.selectExecutable')" />
        <button :disabled="detail.locked" @click="emit('choose-engine')">{{ t('common.select') }}</button>
      </div>
    </div>
    <div class="engine-weight-field">
      <span>{{ t('engine.output') }}</span>
      <div class="engine-output-options">
        <label v-for="output in detail.outputs" :key="output.id" class="settings-checkbox engine-output-assignment">
          <input type="checkbox" :checked="output.assigned" :disabled="detail.locked" @change="emit('output', output.id, ($event.target as HTMLInputElement).checked)" />
          <span class="settings-checkbox-control" aria-hidden="true"></span>
          <span class="settings-checkbox-label">{{ output.label }}</span>
        </label>
        <small v-if="detail.unsupportedOutputs">{{ t('engine.unsupportedOutputs') }}</small>
      </div>
    </div>
    <div v-for="weight in detail.weights" :key="weight.id" class="engine-weight-field">
      <span>{{ weight.label }}</span>
      <div>
        <input :value="weight.path" :disabled="detail.locked" readonly type="text" :placeholder="t('engine.selectWeight')" />
        <button :disabled="!detail.enginePath || detail.locked" @click="emit('choose-weight', weight.id)">{{ t('common.select') }}</button>
      </div>
    </div>
    <label v-if="detail.devices.length">
      <span>{{ t('engine.runtimeDevice') }}</span>
      <select :value="detail.device" :disabled="detail.locked" @change="emit('device', ($event.target as HTMLSelectElement).value)">
        <option v-for="device in detail.devices" :key="device.type" :value="device.type">{{ device.label }}</option>
      </select>
    </label>
    <div v-if="detail.licenses.length || detail.notices.length" class="engine-legal-field">
      <span>{{ t('engine.licenses') }}</span>
      <div class="engine-legal-actions">
        <button v-for="(license, index) in detail.licenses" :key="`license:${index}`" :disabled="!license.available" @click="emit('legal', 'license', index)">{{ license.name }}</button>
        <button v-for="(notice, index) in detail.notices" :key="`notice:${index}`" :disabled="!notice.available" @click="emit('legal', 'notice', index)">{{ notice.name }}</button>
        <button v-if="detail.sourceUrl" @click="emit('source', detail.sourceUrl)">{{ t('engine.viewSource') }}</button>
      </div>
    </div>
    <p v-if="detail.readingOptions" class="engine-inline-status">{{ t('engine.readingOptions') }}</p>
    <label v-for="option in detail.options" :key="option.key">
      <span>{{ option.label }}</span>
      <select v-if="option.enumValues" :value="option.value" :disabled="detail.locked" @change="emitOption(option.key, $event)">
        <option value="">{{ option.defaultLabel }}</option>
        <option v-for="value in option.enumValues" :key="String(value)" :value="value">{{ value }}</option>
      </select>
      <select v-else-if="option.type === 'boolean'" :value="option.value" :disabled="detail.locked" @change="emitOption(option.key, $event)">
        <option value="">{{ option.defaultLabel }}</option>
        <option value="true">{{ t('common.yes') }}</option>
        <option value="false">{{ t('common.no') }}</option>
      </select>
      <input v-else :value="option.value" :placeholder="option.placeholder" :inputmode="option.inputMode" :disabled="detail.locked" type="text" @change="emitOption(option.key, $event)" />
    </label>
    <p v-if="detail.describeError" class="engine-diagnostic">{{ detail.describeError }}</p>
    <p v-if="detail.catalogDiagnostic" class="engine-diagnostic">{{ detail.catalogDiagnostic }}</p>
  </div>
</template>

<script setup lang="ts">
import { nextTick } from 'vue'
import type { EngineProfileDetailView, SupportedEngineOutputId } from '../useEngineProfiles'
import { useI18n } from '../i18n'

const props = defineProps<{ detail: EngineProfileDetailView }>()
const emit = defineEmits<{
  'choose-engine': []
  'choose-weight': [slotId: string]
  device: [value: string]
  legal: [kind: 'license' | 'notice', index: number]
  name: [value: string]
  option: [key: string, value: string]
  output: [id: SupportedEngineOutputId, checked: boolean]
  source: [url: string]
}>()
const { t } = useI18n()

async function emitOption(key: string, event: Event) {
  const target = event.target as HTMLInputElement | HTMLSelectElement
  emit('option', key, target.value)
  await nextTick()
  target.value = String(props.detail.options.find((option) => option.key === key)?.value ?? '')
}
</script>

<style scoped>
.engine-profile-detail {
  display: flex;
  flex-direction: column;
  gap: calc(0.38rem * var(--floating-panel-scale));
  min-width: 0;
  min-height: 0;
  padding: calc(0.62rem * var(--floating-panel-scale));
  overflow-y: auto;
  border: 1px solid rgba(140, 195, 188, 0.12);
  background: rgba(0, 27, 32, 0.24);
  scrollbar-gutter: stable;
}

.engine-profile-detail label {
  display: grid;
  gap: calc(0.14rem * var(--floating-panel-scale));
  color: var(--text-dim);
  font-size: var(--ui-text-caption);
}

.engine-weight-field {
  display: grid;
  gap: calc(0.14rem * var(--floating-panel-scale));
  color: var(--text-dim);
  font-size: var(--ui-text-caption);
}

.engine-weight-field > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: calc(0.3rem * var(--floating-panel-scale));
}

.engine-weight-field > .engine-output-options {
  display: flex;
  flex-wrap: wrap;
  gap: calc(0.2rem * var(--floating-panel-scale)) calc(0.45rem * var(--floating-panel-scale));
}

.engine-weight-field button,
.engine-profile-detail input:not([type="checkbox"]),
.engine-profile-detail select {
  min-width: 0;
  width: 100%;
  height: var(--engine-control-height);
  padding: calc(0.38rem * var(--floating-panel-scale)) calc(0.48rem * var(--floating-panel-scale));
  border: 1px solid rgba(0, 0, 0, 0.28);
  border-radius: calc(2px * var(--floating-panel-scale));
  color: #153237;
  background: rgba(255, 255, 255, 0.95);
  font-size: var(--ui-text-body);
}

.engine-weight-field button {
  padding-inline: calc(0.7rem * var(--floating-panel-scale));
  border-color: rgba(140, 195, 188, 0.2);
  color: var(--text-dim);
  background: rgba(4, 45, 53, 0.7);
  cursor: pointer;
}

.engine-weight-field button:disabled,
.engine-profile-detail input:not([type="checkbox"]):disabled,
.engine-profile-detail select:disabled {
  opacity: 0.55;
  cursor: default;
}

.engine-output-assignment.settings-checkbox {
  min-height: auto;
  padding: calc(0.18rem * var(--floating-panel-scale)) calc(0.24rem * var(--floating-panel-scale));
  border: none;
  background: transparent;
  gap: calc(0.34rem * var(--floating-panel-scale));
}

.engine-output-assignment:has(input:disabled) {
  cursor: default;
}

.engine-output-assignment .settings-checkbox-control {
  width: calc(0.95rem * var(--floating-panel-scale));
  height: calc(0.95rem * var(--floating-panel-scale));
}

.engine-output-assignment .settings-checkbox-label {
  color: var(--text-dim);
  font-size: var(--ui-text-caption);
}

.engine-legal-field {
  display: grid;
  gap: calc(0.26rem * var(--floating-panel-scale));
}

.engine-legal-field > span {
  color: var(--text-dim);
  font-size: var(--ui-text-caption);
}

.engine-legal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: calc(0.3rem * var(--floating-panel-scale));
}

.engine-legal-actions button {
  padding: calc(0.3rem * var(--floating-panel-scale)) calc(0.48rem * var(--floating-panel-scale));
  border: 1px solid rgba(140, 195, 188, 0.3);
  border-radius: calc(2px * var(--floating-panel-scale));
  color: rgba(220, 250, 243, 0.96);
  background: rgba(23, 83, 78, 0.58);
  font-size: var(--ui-text-caption);
  cursor: pointer;
}

.engine-legal-actions button:hover:not(:disabled) {
  border-color: rgba(159, 226, 213, 0.62);
  background: rgba(28, 105, 94, 0.72);
}

.engine-inline-status {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--ui-text-caption);
}

.engine-diagnostic {
  margin: calc(0.45rem * var(--floating-panel-scale)) 0 0;
  color: #e5c780;
  font-size: var(--ui-text-caption);
}
</style>
