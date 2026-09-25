<template>
  <section
    v-perceptual-surface="perceptualSurface"
    ref="windowElement"
    class="analysis-float-panel engine-window"
    :style="{
      '--floating-panel-scale': scale,
      zIndex,
      width: windowWidth ? `${windowWidth}px` : undefined,
      height: windowHeight ? `${windowHeight}px` : undefined,
    }"
    @mousedown="emit('focus')"
    @focusin="emit('focus')"
  >
    <div class="floating-panel-header" @mousedown="emit('start-drag', $event)">
      <span>{{ t('engine.title') }}</span>
      <div class="floating-panel-header-actions">
        <button class="floating-panel-close" :aria-label="t('engine.close')" @click="emit('close')">&times;</button>
      </div>
    </div>
    <div ref="bodyElement" class="engine-manager-body" :style="{ '--engine-list-width': listWidth ? `${listWidth}px` : undefined }">
      <EngineProfileList
        :can-delete="canDelete"
        :can-duplicate="canDuplicate"
        :can-move-down="canMoveDown"
        :can-move-up="canMoveUp"
        :delete-confirmation="deleteConfirmation"
        :outputs="outputs"
        :profiles="profiles"
        :perceptual-surface="perceptualSurface"
        @add="emit('add')"
        @delete="emit('delete')"
        @duplicate="emit('duplicate')"
        @move="emit('move', $event)"
        @select="emit('select', $event)"
        @toggle-output="emit('toggle-output', $event)"
      />
      <div class="engine-column-resizer" role="separator" tabindex="0" :aria-label="t('engine.resizeColumns')" aria-orientation="vertical" @pointerdown="startColumnResize" @keydown="resizeColumnWithKeyboard" />
      <div v-if="detail" class="engine-profile-detail-column">
        <div class="engine-profile-action">
          <button
            class="ui-control-button engine-profile-action-button"
            :disabled="busy || detail.status === 'loading' || detail.status === 'unloading' || !detail.canActivate"
            @click="emit('action', detail.id)"
          >{{ actionLabel(detail) }}</button>
          <p v-if="detail.actionError" class="engine-action-message is-error" v-ui-tooltip="detail.actionError">{{ detail.actionError }}</p>
          <p v-else-if="detail.actionHint" class="engine-action-message">{{ detail.actionHint }}</p>
        </div>
        <EngineProfileDetail
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
    </div>
    <p class="engine-save-message">{{ footerMessage }}</p>
    <button class="engine-window-resizer" :aria-label="t('engine.resizeWindow')" @pointerdown.prevent="startWindowResize" />
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type {
  EngineOutputFilterItem,
  EngineProfileDetailView,
  EngineProfileListItem,
} from '../presentation.ts'
import type { SupportedEngineOutputId } from '../useEngineCatalog.ts'
import { useI18n } from '../../i18n.ts'
import { vPerceptualSurface, type PerceptualSurfaceBinding } from '../../perceptualSurface.ts'
import EngineProfileDetail from './EngineProfileDetail.vue'
import EngineProfileList from './EngineProfileList.vue'

const props = defineProps<{
  scale: number
  perceptualSurface: PerceptualSurfaceBinding
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
function actionLabel(detail: EngineProfileDetailView): string {
  if (detail.status === 'loading') return t('engine.status.loading')
  if (detail.status === 'unloading') return t('engine.status.unloading')
  return t(detail.status === 'loaded' ? 'engine.unload' : 'engine.load')
}
const layoutStorageKey = 'rms.engine-manager-layout.v1'
function restoredLayout(): { width: number; height: number; listWidth: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(layoutStorageKey) || '{}')
    return {
      width: Number.isFinite(saved.width) && saved.width > 0 ? saved.width : 0,
      height: Number.isFinite(saved.height) && saved.height > 0 ? saved.height : 0,
      listWidth: Number.isFinite(saved.listWidth) && saved.listWidth > 0 ? saved.listWidth : 0,
    }
  } catch {
    return { width: 0, height: 0, listWidth: 0 }
  }
}
const savedLayout = restoredLayout()
const windowElement = ref<HTMLElement | null>(null)
const bodyElement = ref<HTMLElement | null>(null)
const windowWidth = ref(savedLayout.width)
const windowHeight = ref(savedLayout.height)
const listWidth = ref(savedLayout.listWidth)

function saveLayout() {
  try {
    localStorage.setItem(layoutStorageKey, JSON.stringify({
      width: windowWidth.value,
      height: windowHeight.value,
      listWidth: listWidth.value,
    }))
  } catch {
    // Resizing remains usable if local storage is unavailable.
  }
}

function startColumnResize(event: PointerEvent) {
  if (event.button !== 0 || !bodyElement.value) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  const bodyWidth = bodyElement.value.clientWidth
  const startWidth = bodyElement.value.firstElementChild?.getBoundingClientRect().width || 0
  const startX = event.clientX
  const minimumLeft = Math.min(13 * parseFloat(getComputedStyle(document.documentElement).fontSize) * props.scale, bodyWidth * 0.45)
  const minimumRight = Math.min(20 * parseFloat(getComputedStyle(document.documentElement).fontSize) * props.scale, bodyWidth * 0.45)
  handle.setPointerCapture(event.pointerId)
  handle.onpointermove = (move) => {
    listWidth.value = Math.round(Math.max(minimumLeft, Math.min(bodyWidth - minimumRight - handle.offsetWidth, startWidth + move.clientX - startX)))
  }
  handle.onpointerup = handle.onpointercancel = () => {
    saveLayout()
    handle.onpointermove = null
    handle.onpointerup = null
    handle.onpointercancel = null
  }
}

function resizeColumnWithKeyboard(event: KeyboardEvent) {
  if (!bodyElement.value || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  const current = bodyElement.value.firstElementChild?.getBoundingClientRect().width || 0
  const next = current + (event.key === 'ArrowRight' ? 16 : -16)
  const minimum = 13 * parseFloat(getComputedStyle(document.documentElement).fontSize) * props.scale
  const maximum = bodyElement.value.clientWidth - 20 * parseFloat(getComputedStyle(document.documentElement).fontSize) * props.scale
  listWidth.value = Math.round(Math.max(minimum, Math.min(maximum, next)))
  saveLayout()
}

function startWindowResize(event: PointerEvent) {
  const element = windowElement.value
  if (event.button !== 0 || !element) return
  const handle = event.currentTarget as HTMLElement
  const rect = element.getBoundingClientRect()
  const startX = event.clientX
  const startY = event.clientY
  const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize) * props.scale
  const maxWidth = window.innerWidth - rect.left - 8
  const maxHeight = window.innerHeight - rect.top - 8 - 1.75 * rootSize
  const minWidth = Math.min(35 * rootSize, maxWidth)
  const minHeight = Math.min(20 * rootSize, maxHeight)
  handle.setPointerCapture(event.pointerId)
  handle.onpointermove = (move) => {
    windowWidth.value = Math.round(Math.max(minWidth, Math.min(maxWidth, rect.width + move.clientX - startX)))
    windowHeight.value = Math.round(Math.max(minHeight, Math.min(maxHeight, rect.height + move.clientY - startY)))
    element.style.left = `${rect.left}px`
    element.style.top = `${rect.top}px`
    element.style.right = 'auto'
  }
  handle.onpointerup = handle.onpointercancel = () => {
    saveLayout()
    handle.onpointermove = null
    handle.onpointerup = null
    handle.onpointercancel = null
  }
}
</script>

<style scoped>
.engine-window {
  --engine-control-height: calc(2rem * var(--floating-panel-scale));
  --engine-state-idle-bg: rgba(0, 27, 32, 0.34);
  --engine-state-selected-bg: rgba(8, 80, 94, 0.94);
  --engine-state-border: var(--border-dark);
  --engine-state-idle-border: rgba(112, 136, 136, 0.22);
  display: flex;
  flex-direction: column;
  top: calc(4rem * var(--floating-panel-scale));
  right: calc(1.25rem * var(--floating-panel-scale));
  width: min(calc(48rem * var(--floating-panel-scale)), 94vw);
  min-width: min(calc(35rem * var(--floating-panel-scale)), calc(100vw - 1rem));
  max-width: calc(100vw - 1rem);
  height: min(
    calc(42rem * var(--floating-panel-scale)),
    calc(100vh - var(--footer-min-h) - 5rem * var(--floating-panel-scale))
  );
  min-height: min(calc(20rem * var(--floating-panel-scale)), calc(100vh - 1rem));
  max-height: calc(100vh - var(--footer-min-h) - 1rem);
  overflow: hidden;
}

.engine-window .floating-panel-header {
  font-size: var(--ui-text-control);
}

.engine-manager-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.engine-manager-body > :first-child {
  flex: 0 1 var(--engine-list-width, 37%);
  min-width: min(calc(13rem * var(--floating-panel-scale)), 40%);
}

.engine-column-resizer {
  flex: 0 0 calc(0.75rem * var(--floating-panel-scale));
  margin-inline: calc(0.15rem * var(--floating-panel-scale));
  border-inline: calc(1px * var(--floating-panel-scale)) solid transparent;
  cursor: col-resize;
  touch-action: none;
}

.engine-column-resizer:hover,
.engine-column-resizer:focus-visible {
  border-color: var(--border-strong);
}

.engine-profile-detail-column {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: calc(0.35rem * var(--floating-panel-scale));
  min-width: min(calc(20rem * var(--floating-panel-scale)), 50%);
  min-height: 0;
}

.engine-profile-detail-column > :last-child {
  flex: 1 1 auto;
}

.engine-profile-action {
  display: grid;
  gap: calc(0.2rem * var(--floating-panel-scale));
  flex: 0 0 auto;
}

.engine-profile-action-button {
  width: 100%;
  height: calc(2.3rem * var(--floating-panel-scale));
}

.engine-action-message {
  margin: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--ui-text-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.engine-action-message.is-error {
  color: var(--status-error);
}

.engine-window-resizer {
  position: absolute;
  right: 0;
  bottom: 0;
  width: calc(1.15rem * var(--floating-panel-scale));
  height: calc(1.15rem * var(--floating-panel-scale));
  padding: 0;
  border: 0;
  border-right: calc(3px * var(--floating-panel-scale)) solid var(--border-strong);
  border-bottom: calc(3px * var(--floating-panel-scale)) solid var(--border-strong);
  background: transparent;
  cursor: nwse-resize;
  touch-action: none;
}

.engine-save-message {
  min-height: calc(1rem * var(--floating-panel-scale));
  margin: calc(0.45rem * var(--floating-panel-scale)) 0 0;
  color: var(--text-muted);
  font-size: var(--ui-text-caption);
}
</style>
