<template>
  <div class="settings-modal-backdrop">
    <form class="settings-modal record-import-modal" @submit.prevent="submitImport">
      <div class="settings-modal-header">
        <h2>导入牌谱</h2>
        <div class="settings-modal-actions">
          <button class="settings-btn-secondary" type="button" :disabled="importing" @click="emit('close')">关闭</button>
          <button class="settings-btn-primary" type="submit" :disabled="importing || !input.trim()">
            {{ importing ? '正在导入...' : '导入' }}
          </button>
        </div>
      </div>
      <p class="record-import-copy">粘贴 <a href="https://mjai.ekyu.moe/zh-cn.html" @click.prevent="emit('open-external', 'https://mjai.ekyu.moe/zh-cn.html')">Mortal 分析</a>的 killerducky 报告地址，或<a href="https://tenhou.net/6/" @click.prevent="emit('open-external', 'https://tenhou.net/6/')">天凤自定义牌谱</a>（支持 Mortal、Naga 式多局牌谱）。</p>
      <label>
        <span>报告地址或自定义牌谱</span>
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
          <span class="settings-checkbox-label">重建牌山</span>
          <span class="settings-checkbox-description">按牌谱中的已知牌张还原牌山，并随机补全未出现的剩余牌山。未重建牌山的对局可在牌山面板中重建，重建前仅能只读分析，无法进入对局模式。</span>
        </span>
      </label>
      <label v-if="reconstructWalls">
        <span>对局牌山种子（可选）</span>
        <input
          v-model.trim="seed"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          placeholder="留空则随机生成"
        />
      </label>
      <p v-if="errorMessage" class="record-import-error">{{ errorMessage }}</p>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

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
    errorMessage.value = error instanceof Error ? error.message : '导入失败。'
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
