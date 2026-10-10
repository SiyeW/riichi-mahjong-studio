<template>
  <span class="player-name-editor">
    <input v-if="editing" ref="input" class="player-name-input" :value="draft ?? name" maxlength="200"
      :aria-label="t('table.playerName')" :aria-invalid="Boolean(error)" :disabled="saving" v-ui-tooltip="error || false"
      @input="emit('draft', ($event.target as HTMLInputElement).value)" @blur="commit"
      @keydown.enter.prevent="commit" @keydown.esc.prevent="cancel" @keydown.stop />
    <button v-else class="player-name-button" :aria-label="t('table.editPlayerName')"
      v-ui-tooltip="error || { text: name, revealTarget: '.player-name-text' }" @click.stop="edit">
      <span class="player-name-text" :class="{ 'is-empty': !name }">{{ name || t('table.playerName') }}</span>
    </button>
  </span>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useI18n } from '../i18n'

const props = defineProps<{ name: string; draft?: string; error: string; save: () => Promise<void> }>()
const emit = defineEmits<{ draft: [name: string]; cancel: [] }>()
const { t } = useI18n()
const input = ref<HTMLInputElement | null>(null)
const editing = ref(false)
const saving = ref(false)
async function edit() {
  editing.value = true
  await nextTick()
  input.value?.focus()
  input.value?.select()
}

async function commit() {
  if (!editing.value || saving.value) return
  saving.value = true
  try {
    await props.save()
    editing.value = false
  } catch {
    // Keep the draft and the shared write error available for retry.
  } finally {
    saving.value = false
  }
}

function cancel() {
  editing.value = false
  emit('cancel')
}
</script>

<style scoped>
.player-name-editor {
  display: block;
  width: 100%;
  min-width: 0;
}
.player-name-button, .player-name-input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: calc(1.35em + 2px);
  padding: 0 .25em;
  border: 1px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  line-height: 1.35;
  text-align: center;
}
.player-name-button { cursor: text; }
.player-name-text {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.player-name-text.is-empty { color: var(--text-muted); }
.player-name-input, .player-name-button:focus-visible {
  border-color: var(--text-dim);
  outline: none;
  background: var(--bg-panel);
}
</style>
