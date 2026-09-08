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
