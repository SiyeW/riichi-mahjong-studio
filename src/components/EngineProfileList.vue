<template>
  <div class="engine-profile-column">
    <div class="engine-output-filters" :aria-label="t('engine.filterByOutput')">
      <button
        v-for="output in outputs"
        :key="output.id"
        class="engine-output-filter"
        :class="{
          assigned: output.assigned,
          loaded: output.loaded,
          loading: output.loading,
          error: output.error,
          selected: output.selected,
        }"
        :aria-pressed="output.selected"
        @click="emit('toggle-output', output.id)"
      >
        {{ output.label }}
      </button>
    </div>
    <div
      v-for="profile in profiles"
      :key="profile.id"
      class="engine-profile-item"
      :class="profile.classes"
      @click="emit('select', profile.id)"
    >
      <span>{{ profile.name || t('common.unnamedEngine') }}</span>
      <small>{{ profile.subtitle }}</small>
      <button
        v-if="profile.showAction"
        class="engine-load-button"
        :class="{ unload: profile.loaded }"
        :disabled="busy"
        @click.stop="emit('action', profile.id)"
      >
        {{ profile.loaded ? t('engine.unload') : t('engine.load') }}
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
import type {
  EngineOutputFilterItem,
  EngineProfileListItem,
  SupportedEngineOutputId,
} from '../useEngineProfiles'
import { useI18n } from '../i18n'

defineProps<{
  busy: boolean
  canDelete: boolean
  canDuplicate: boolean
  canMoveDown: boolean
  canMoveUp: boolean
  deleteConfirmation: boolean
  outputs: EngineOutputFilterItem[]
  profiles: EngineProfileListItem[]
}>()

const emit = defineEmits<{
  action: [profileId: string]
  add: []
  delete: []
  duplicate: []
  move: [offset: number]
  select: [profileId: string]
  'toggle-output': [outputId: SupportedEngineOutputId]
}>()
const { t } = useI18n()
</script>

<style scoped>
.engine-profile-column {
  display: flex;
  flex-direction: column;
  gap: calc(0.38rem * var(--floating-panel-scale));
  min-width: 0;
}

.engine-output-filters {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: calc(0.24rem * var(--floating-panel-scale));
  padding-bottom: calc(0.38rem * var(--floating-panel-scale));
  border-bottom: 1px solid rgba(140, 195, 188, 0.12);
}

.engine-output-filter {
  position: relative;
  min-width: 0;
  padding: calc(0.32rem * var(--floating-panel-scale)) calc(0.42rem * var(--floating-panel-scale));
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

.engine-output-filter.assigned {
  color: var(--text-dim);
  background: var(--engine-state-unloaded-bg);
}

.engine-output-filter.loaded {
  color: var(--text-main);
  background: var(--engine-state-loaded-bg);
}

.engine-output-filter.loading {
  color: var(--text-dim);
  background: var(--engine-state-loading-bg);
}

.engine-output-filter.error {
  color: var(--text-main);
  background: var(--engine-state-error-bg);
}

.engine-output-filter.selected {
  color: var(--text-main);
  background: var(--engine-state-idle-selected-bg);
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

.engine-output-filter.assigned.selected {
  background: var(--engine-state-unloaded-selected-bg);
}

.engine-output-filter.loaded.selected {
  background: var(--engine-state-loaded-selected-bg);
}

.engine-output-filter.loading.selected {
  background: var(--engine-state-loading-selected-bg);
}

.engine-output-filter.error.selected {
  background: var(--engine-state-error-selected-bg);
}

.engine-output-filter:hover {
  color: var(--text-main);
  filter: brightness(1.08);
}

.engine-profile-item {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: calc(0.12rem * var(--floating-panel-scale));
  width: 100%;
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
  font-size: var(--ui-text-body);
}

.engine-profile-item small {
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--ui-text-caption);
  text-overflow: ellipsis;
}

.engine-profile-item.loaded {
  color: var(--text-main);
  background: var(--engine-state-loaded-bg);
}

.engine-profile-item.loading {
  background: var(--engine-state-loading-bg);
}

.engine-profile-item.error {
  background: var(--engine-state-error-bg);
}

.engine-profile-item.unloaded {
  color: var(--text-dim);
  background: var(--engine-state-unloaded-bg);
}

.engine-profile-item.selected {
  color: var(--text-main);
  background: var(--engine-state-idle-selected-bg);
}

.engine-profile-item.selected::before {
  background: var(--text-main);
}

.engine-profile-item.selected.unloaded {
  background: var(--engine-state-unloaded-selected-bg);
}

.engine-profile-item.selected.loaded {
  background: var(--engine-state-loaded-selected-bg);
}

.engine-profile-item.selected.loading {
  background: var(--engine-state-loading-selected-bg);
}

.engine-profile-item.selected.error {
  background: var(--engine-state-error-selected-bg);
}

.engine-output-filter.assigned,
.engine-output-filter.loaded,
.engine-output-filter.loading,
.engine-output-filter.error,
.engine-output-filter.selected,
.engine-profile-item.loaded,
.engine-profile-item.loading,
.engine-profile-item.error,
.engine-profile-item.unloaded,
.engine-profile-item.selected {
  border-color: var(--engine-state-border);
}

.engine-load-button {
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
  padding: calc(0.24rem * var(--floating-panel-scale)) calc(0.48rem * var(--floating-panel-scale));
  border: 1px solid rgba(226, 244, 239, 0.32);
  border-radius: calc(2px * var(--floating-panel-scale));
  color: var(--text-main);
  background: rgba(30, 116, 78, 0.92);
  font-size: var(--ui-text-caption);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--ui-motion-duration) var(--ui-motion-easing);
}

.engine-load-button.unload {
  background: rgba(88, 105, 105, 0.92);
}

.engine-profile-item:hover .engine-load-button,
.engine-load-button:focus-visible {
  opacity: 1;
}

.engine-list-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) minmax(calc(4.8rem * var(--floating-panel-scale)), auto);
  gap: calc(0.25rem * var(--floating-panel-scale));
  margin-top: auto;
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
