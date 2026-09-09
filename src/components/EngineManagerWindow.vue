<template>
  <section
    class="analysis-float-panel engine-window"
    :style="{ '--floating-panel-scale': scale, zIndex }"
    @mousedown="emit('focus')"
    @focusin="emit('focus')"
  >
    <div class="floating-panel-header" @mousedown="emit('start-drag', $event)">
      <span>{{ t('engine.title') }}</span>
      <div class="floating-panel-header-actions">
        <button class="floating-panel-close" :aria-label="t('engine.close')" @click="emit('close')">&times;</button>
      </div>
    </div>
    <div class="engine-manager-body">
      <EngineProfileList
        :busy="busy"
        :can-delete="canDelete"
        :can-duplicate="canDuplicate"
        :can-move-down="canMoveDown"
        :can-move-up="canMoveUp"
        :delete-confirmation="deleteConfirmation"
        :outputs="outputs"
        :profiles="profiles"
        @action="emit('action', $event)"
        @add="emit('add')"
        @delete="emit('delete')"
        @duplicate="emit('duplicate')"
        @move="emit('move', $event)"
        @select="emit('select', $event)"
        @toggle-output="emit('toggle-output', $event)"
      />
      <EngineProfileDetail
        v-if="detail"
        :detail="detail"
        @choose-engine="emit('choose-engine')"
        @choose-weight="emit('choose-weight', $event)"
        @device="emit('device', $event)"
        @legal="(kind, index) => emit('legal', kind, index)"
        @name="emit('name', $event)"
        @option="(key, value) => emit('option', key, value)"
        @output="(id, checked) => emit('output', id, checked)"
        @source="emit('source', $event)"
      />
    </div>
    <p class="engine-save-message">{{ footerMessage }}</p>
  </section>
</template>

<script setup lang="ts">
import type {
  EngineOutputFilterItem,
  EngineProfileDetailView,
  EngineProfileListItem,
  SupportedEngineOutputId,
} from '../useEngineProfiles'
import { useI18n } from '../i18n'
import EngineProfileDetail from './EngineProfileDetail.vue'
import EngineProfileList from './EngineProfileList.vue'

defineProps<{
  scale: number
  zIndex: number
  footerMessage: string
  busy: boolean
  canDelete: boolean
  canDuplicate: boolean
  canMoveDown: boolean
  canMoveUp: boolean
  deleteConfirmation: boolean
  outputs: EngineOutputFilterItem[]
  profiles: EngineProfileListItem[]
  detail: EngineProfileDetailView | null
}>()

const emit = defineEmits<{
  close: []
  focus: []
  'start-drag': [event: MouseEvent]
  action: [profileId: string]
  add: []
  delete: []
  duplicate: []
  move: [offset: number]
  select: [profileId: string]
  'toggle-output': [outputId: SupportedEngineOutputId]
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
</script>

<style scoped>
.engine-window {
  --engine-control-height: calc(2rem * var(--floating-panel-scale));
  --engine-state-idle-bg: rgba(0, 27, 32, 0.34);
  --engine-state-unloaded-bg: rgba(57, 72, 74, 0.42);
  --engine-state-loaded-bg: rgba(23, 105, 70, 0.42);
  --engine-state-loading-bg: rgba(117, 75, 18, 0.46);
  --engine-state-error-bg: rgba(105, 26, 24, 0.48);
  --engine-state-idle-selected-bg: rgba(8, 80, 94, 0.94);
  --engine-state-unloaded-selected-bg: rgba(76, 92, 94, 0.82);
  --engine-state-loaded-selected-bg: rgba(23, 122, 70, 0.88);
  --engine-state-loading-selected-bg: rgba(117, 75, 18, 0.82);
  --engine-state-error-selected-bg: rgba(105, 26, 24, 0.82);
  --engine-state-border: rgba(0, 0, 0, 0.28);
  --engine-state-idle-border: rgba(112, 136, 136, 0.22);
  display: flex;
  flex-direction: column;
  top: calc(4rem * var(--floating-panel-scale));
  right: calc(1.25rem * var(--floating-panel-scale));
  width: min(calc(48rem * var(--floating-panel-scale)), 94vw);
  height: min(
    calc(30rem * var(--floating-panel-scale)),
    calc(100vh - var(--footer-min-h) - 5rem * var(--floating-panel-scale))
  );
  overflow: hidden;
}

.engine-window .floating-panel-header {
  font-size: var(--ui-text-control);
}

.engine-manager-body {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: minmax(calc(13rem * var(--floating-panel-scale)), 0.8fr) minmax(calc(20rem * var(--floating-panel-scale)), 1.35fr);
  gap: calc(0.7rem * var(--floating-panel-scale));
  min-height: 0;
  overflow: hidden;
}

.engine-save-message {
  min-height: calc(1rem * var(--floating-panel-scale));
  margin: calc(0.45rem * var(--floating-panel-scale)) 0 0;
  color: var(--text-muted);
  font-size: var(--ui-text-caption);
}
</style>
