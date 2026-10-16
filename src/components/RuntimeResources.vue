<template>
  <div class="footer-memory-status" :aria-label="detail" aria-describedby="runtime-memory-detail" tabindex="0">
    <span v-if="cache" class="resource-item">
      <span>{{ t('status.cacheUsage', { used: formatSize(cache.residentBytes), budget: formatSize(cache.budgetBytes) }) }}</span>
      <span class="resource-track" aria-hidden="true"><span :style="fill(cache.residentBytes, cache.budgetBytes)" /></span>
      <span v-if="cache.error" class="resource-error" :aria-label="t('status.recoveryError')">!</span>
    </span>
    <span class="resource-item">
      <span>{{ t('status.applicationMemory', { value: formatSize(metrics?.applicationBytes) }) }}</span>
    </span>
    <span class="resource-item">
      <span>{{ t('status.systemAvailable', { value: formatSize(metrics?.systemAvailableBytes) }) }}</span>
    </span>
    <div id="runtime-memory-detail" class="ui-hover-tooltip footer-memory-tooltip" role="tooltip">
      <div v-for="row in rows" :key="row.label" class="ui-hover-tooltip-row"><span>{{ row.label }}</span><span>{{ row.value }}</span></div>
      <span v-if="cache">{{ t('status.resourceScale') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../i18n'
import type { RuntimeMetrics } from '../contracts/runtime'

const props = defineProps<{ metrics: RuntimeMetrics | null; rows: Array<{ label: string; value: string }>;
  formatSize: (value: number | null | undefined) => string }>()
const { t } = useI18n()
const cache = computed(() => props.metrics?.recordCache)
const detail = computed(() => props.rows.map(row => `${row.label}: ${row.value}`).join('\n'))
function fill(value: number | null | undefined, total: number | undefined) {
  const ratio = value != null && Number.isFinite(value) && total && total > 0 ? value / total : 0
  return { transform: `scaleX(${Math.max(0, Math.min(1, ratio))})` }
}
</script>

<style scoped>
.footer-memory-status {
  position: relative; display: flex; align-items: center; flex: 0 1 auto; min-width: 0;
  margin-left: auto; gap: calc(0.75rem * var(--chrome-scale)); color: var(--text-muted);
  font-variant-numeric: tabular-nums; line-height: 1; white-space: nowrap; cursor: default; outline: none;
}
.footer-memory-status:focus-visible { color: var(--text-main); }
.resource-item { display: inline-flex; align-items: center; min-width: 0; gap: calc(0.35rem * var(--chrome-scale)); }
.resource-item > span:first-child { overflow: hidden; text-overflow: ellipsis; }
.resource-track { flex-shrink: 0; width: calc(2.75rem * var(--chrome-scale)); height: calc(0.25rem * var(--chrome-scale)); background: var(--border-subtle); overflow: hidden; }
.resource-track > span { display: block; width: 100%; height: 100%; background: var(--text-muted); transform-origin: left center; }
.resource-error { color: var(--status-loading); }
.footer-memory-tooltip { right: 0; bottom: calc(100% + 0.55rem * var(--chrome-scale)); min-width: calc(19rem * var(--chrome-scale)); opacity: 0; visibility: hidden; white-space: normal; }
.footer-memory-tooltip .ui-hover-tooltip-row > :last-child { max-width: calc(28rem * var(--chrome-scale)); overflow-wrap: anywhere; }
.footer-memory-status:hover .footer-memory-tooltip, .footer-memory-status:focus-visible .footer-memory-tooltip { opacity: 1; visibility: visible; }
@media (max-width: 1250px) { .resource-track { width: calc(1.5rem * var(--chrome-scale)); } }
</style>
