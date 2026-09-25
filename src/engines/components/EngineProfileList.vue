<template>
  <div class="engine-profile-column">
    <div class="engine-output-filters" :aria-label="t('engine.filterByOutput')">
      <button
        v-for="output in outputs"
        :key="output.id"
        class="engine-output-filter"
        :class="{ selected: output.selected }"
        :data-status="output.status || undefined"
        :aria-label="output.status ? `${output.label} · ${statusLabel(output.status)}` : output.label"
        :aria-pressed="output.selected"
        v-perceptual-surface="statusSurface"
        v-ui-tooltip="{ text: output.label, revealTarget: '.engine-output-label' }"
        @click="emit('toggle-output', output.id)"
      >
        <span class="engine-output-label">{{ output.label }}</span>
      </button>
    </div>
    <div class="engine-profile-list">
      <button
        v-for="profile in profiles"
        :key="profile.id"
        type="button"
        class="engine-profile-item"
        :class="{ selected: profile.selected }"
        :data-status="profile.status"
        :aria-label="`${profile.name || t('common.unnamedEngine')} · ${statusLabel(profile.status)}`"
        :aria-pressed="profile.selected"
        v-perceptual-surface="statusSurface"
        v-ui-tooltip="{ text: profile.name || t('common.unnamedEngine'), revealTarget: '.engine-profile-name' }"
        @click="emit('select', profile.id)"
      >
        <span class="engine-profile-name">{{ profile.name || t('common.unnamedEngine') }}</span>
        <small v-if="profile.subtitle">{{ profile.subtitle }}</small>
      </button>
    </div>
    <div class="engine-list-actions">
      <button :disabled="!canMoveUp" @click="emit('move', -1)">{{ t('engine.moveUp') }}</button>
      <button :disabled="!canMoveDown" @click="emit('move', 1)">{{ t('engine.moveDown') }}</button>
      <button :disabled="!canDuplicate" @click="emit('duplicate')">{{ t('engine.duplicate') }}</button>
      <button :class="{ danger: deleteConfirmation }" :disabled="!canDelete" @click="emit('delete')">
        {{ deleteConfirmation ? t('common.confirmDelete') : t('common.delete') }}
      </button>
    </div>
    <button class="engine-add-button" @click="emit('add')">{{ t('engine.add') }}</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type {
  EngineOutputFilterItem,
  EngineProfileListItem,
  EngineLoadStatus,
} from '../presentation.ts'
import type { SupportedEngineOutputId } from '../useEngineCatalog.ts'
import { useI18n } from '../../i18n.ts'
import { vPerceptualSurface, type PerceptualSurfaceBinding } from '../../perceptualSurface.ts'

const props = defineProps<{
  canDelete: boolean
  canDuplicate: boolean
  canMoveDown: boolean
  canMoveUp: boolean
  deleteConfirmation: boolean
  outputs: EngineOutputFilterItem[]
  profiles: EngineProfileListItem[]
  perceptualSurface: PerceptualSurfaceBinding
}>()

const statusSurface = computed<PerceptualSurfaceBinding>(() => ({
  palette: props.perceptualSurface.palette,
  tuning: props.perceptualSurface.tuning,
  statusOnly: true,
}))

const emit = defineEmits<{
  add: []
  delete: []
  duplicate: []
  move: [offset: number]
  select: [profileId: string]
  'toggle-output': [outputId: SupportedEngineOutputId]
}>()
const { t } = useI18n()
const statusTranslationKeys: Record<EngineLoadStatus, string> = {
  loaded: 'engine.status.loaded',
  loading: 'engine.status.loading',
  unloading: 'engine.status.unloading',
  error: 'engine.status.failed',
  unloaded: 'engine.status.notLoaded',
}
function statusLabel(status: EngineLoadStatus): string {
  return t(statusTranslationKeys[status])
}
</script>

<style scoped>
.engine-profile-column {
  display: flex;
  flex-direction: column;
  gap: calc(0.38rem * var(--floating-panel-scale));
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.engine-profile-list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: calc(0.38rem * var(--floating-panel-scale));
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.engine-output-filters {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(calc(4rem * var(--floating-panel-scale)), 30%), 1fr));
  gap: calc(0.24rem * var(--floating-panel-scale));
  padding-bottom: calc(0.38rem * var(--floating-panel-scale));
  border-bottom: 1px solid var(--border-subtle);
}

.engine-output-filter {
  position: relative;
  --engine-indicator-size: calc(0.28rem * var(--floating-panel-scale));
  --engine-indicator-offset: calc(0.22rem * var(--floating-panel-scale));
  min-width: 0;
  padding: calc(0.32rem * var(--floating-panel-scale)) calc(0.9rem * var(--floating-panel-scale)) calc(0.32rem * var(--floating-panel-scale)) calc(0.42rem * var(--floating-panel-scale));
  overflow: hidden;
  border: 1px solid var(--engine-state-idle-border);
  border-radius: calc(2px * var(--floating-panel-scale));
  color: var(--text-dim);
  background: var(--engine-state-idle-bg);
  font-size: var(--ui-text-body);
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.engine-output-label {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.engine-output-filter[data-status]::after,
.engine-profile-item[data-status]::after {
  position: absolute;
  top: var(--engine-indicator-offset);
  right: var(--engine-indicator-offset);
  width: var(--engine-indicator-size);
  height: var(--engine-indicator-size);
  border-radius: 50%;
  background: var(--engine-status-unloaded);
  content: '';
}

.engine-output-filter[data-status='loaded']::after,
.engine-profile-item[data-status='loaded']::after {
  background: var(--engine-status-loaded);
}

.engine-output-filter[data-status='loading']::after,
.engine-output-filter[data-status='unloading']::after,
.engine-profile-item[data-status='loading']::after,
.engine-profile-item[data-status='unloading']::after {
  background: var(--engine-status-loading);
}

.engine-output-filter[data-status='error']::after,
.engine-profile-item[data-status='error']::after {
  background: var(--engine-status-error);
}

.engine-output-filter.selected {
  color: var(--text-main);
  background: var(--engine-state-selected-bg);
}

.engine-output-filter.selected::before {
  position: absolute;
  right: calc(0.24rem * var(--floating-panel-scale));
  bottom: 0;
  left: calc(0.24rem * var(--floating-panel-scale));
  height: calc(3px * var(--floating-panel-scale));
  background: var(--text-main);
  content: '';
}

.engine-output-filter:hover {
  color: var(--text-main);
  border-color: var(--border-strong);
}

.engine-profile-item:hover {
  border-color: var(--border-strong);
}

.engine-profile-item {
  position: relative;
  --engine-indicator-size: calc(0.38rem * var(--floating-panel-scale));
  --engine-indicator-offset: calc(0.4rem * var(--floating-panel-scale));
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: calc(0.12rem * var(--floating-panel-scale));
  width: 100%;
  min-height: calc(3.2rem * var(--floating-panel-scale));
  padding:
    calc(0.48rem * var(--floating-panel-scale))
    calc(0.58rem * var(--floating-panel-scale))
    calc(0.48rem * var(--floating-panel-scale))
    calc(0.9rem * var(--floating-panel-scale));
  border: 1px solid var(--engine-state-idle-border);
  border-radius: calc(2px * var(--floating-panel-scale));
  color: var(--text-dim);
  background: var(--engine-state-idle-bg);
  text-align: left;
  cursor: pointer;
}

.engine-profile-item::before {
  position: absolute;
  top: calc(0.28rem * var(--floating-panel-scale));
  bottom: calc(0.28rem * var(--floating-panel-scale));
  left: calc(0.18rem * var(--floating-panel-scale));
  width: calc(0.22rem * var(--floating-panel-scale));
  background: transparent;
  content: '';
}

.engine-profile-item > span,
.engine-profile-item > small {
  grid-column: 1;
}

.engine-profile-item > span {
  min-width: 0;
  overflow: hidden;
  padding-block: 0.08em;
  font-size: var(--ui-text-body);
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.engine-profile-item small {
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--ui-text-caption);
  text-overflow: ellipsis;
}

.engine-profile-item.selected {
  color: var(--text-main);
  background: var(--engine-state-selected-bg);
}

.engine-profile-item.selected::before {
  background: var(--text-main);
}

.engine-output-filter.selected,
.engine-profile-item.selected {
  border-color: var(--engine-state-border);
}

.engine-list-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) minmax(calc(4.8rem * var(--floating-panel-scale)), auto);
  gap: calc(0.25rem * var(--floating-panel-scale));
}

.engine-list-actions button {
  padding: calc(0.28rem * var(--floating-panel-scale)) calc(0.55rem * var(--floating-panel-scale));
  border: 1px solid rgba(140, 195, 188, 0.2);
  border-radius: calc(2px * var(--floating-panel-scale));
  color: var(--text-dim);
  background: rgba(4, 45, 53, 0.7);
  font-size: var(--ui-text-caption);
  white-space: nowrap;
  cursor: pointer;
}

.engine-list-actions button:disabled {
  opacity: 0.4;
  cursor: default;
}

.engine-list-actions button.danger {
  border-color: rgba(222, 96, 84, 0.8);
  color: #fff2ef;
  background: rgba(139, 39, 34, 0.86);
}

.engine-add-button {
  align-self: stretch;
  min-width: 0;
  width: 100%;
  height: var(--engine-control-height);
  padding: calc(0.38rem * var(--floating-panel-scale)) calc(0.48rem * var(--floating-panel-scale));
  border: 1px solid rgba(140, 195, 188, 0.2);
  border-radius: calc(2px * var(--floating-panel-scale));
  color: var(--text-dim);
  background: rgba(4, 45, 53, 0.7);
  font-size: var(--ui-text-body);
  cursor: pointer;
}
</style>
