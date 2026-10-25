<template>
  <div class="footer-memory-status" role="group" :aria-label="t('status.memoryInfo')"
    aria-describedby="runtime-memory-detail" tabindex="0" @keydown="scrollDetails">
    <span class="resource-item">
      <span>{{ t('status.applicationMemory', { value: formatSize(metrics?.memoryBasis === 'resident' ? metrics.applicationBytes : null) }) }}</span>
    </span>
    <span class="resource-item">
      <span>{{ t('status.systemAvailable', { value: formatSize(metrics?.systemAvailableBytes) }) }}</span>
    </span>
    <span v-if="cache?.error" class="resource-error" :aria-label="t('status.recoveryError')">!</span>
    <div id="runtime-memory-detail" ref="detailElement" class="ui-hover-tooltip footer-memory-tooltip" role="tooltip">
      <span v-if="!groups.length">{{ t('status.reading') }}</span>
      <section v-for="group in groups" :key="group.id" class="resource-section" :data-resource-group="group.id">
        <header class="ui-hover-tooltip-row resource-section-heading">
          <strong>{{ t(group.titleKey) }}</strong>
          <span>{{ t(group.referenceKey, { value: formatSize(group.referenceBytes) }) }}</span>
        </header>
        <div v-for="row in group.rows" :key="row.id" class="resource-detail-row" :data-resource-row="row.id">
          <div class="ui-hover-tooltip-row">
            <span>{{ rowLabel(row) }}</span><span>{{ formatSize(row.bytes) }}</span>
          </div>
          <div class="resource-track" :class="{ unavailable: row.fraction === null }" aria-hidden="true">
            <span :style="{ transform: `scaleX(${row.fraction ?? 0})` }" />
          </div>
        </div>
        <span v-if="group.scaleBytes !== null && group.scaleBytes !== group.referenceBytes" class="resource-note">
          {{ t('status.resourceScale', { value: formatSize(group.scaleBytes) }) }}
        </span>
        <template v-if="group.id === 'cache' && cache">
          <span class="resource-note">{{ t('status.cachePending', { pending: cache.pendingResults, queued: cache.queuedWrites }) }}</span>
          <div v-if="cache.error" class="resource-warning"><strong>{{ t('status.recoveryError') }}</strong><span>{{ cache.error }}</span></div>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '../i18n'
import type { RuntimeMetrics } from '../contracts/runtime'
import { runtimeResourceGroups, type ResourceRow } from '../runtimeResourcePresentation'

const props = defineProps<{ metrics: RuntimeMetrics | null;
  formatSize: (value: number | null | undefined) => string }>()
const { t } = useI18n()
const cache = computed(() => props.metrics?.recordCache)
const groups = computed(() => runtimeResourceGroups(props.metrics))
const detailElement = ref<HTMLElement | null>(null)
function rowLabel(row: ResourceRow) {
  const count = props.metrics?.engineProcessCount
  return t(row.labelKey, { count: row.id === 'engines' && count != null ? t('status.engineProcesses', { count }) : '' })
}
function scrollDetails(event: KeyboardEvent) {
  const element = detailElement.value
  if (!element || !event.currentTarget || !(event.currentTarget as HTMLElement).matches(':focus-visible')) return
  const distance: Record<string, number> = { ArrowDown: 40, ArrowUp: -40,
    PageDown: element.clientHeight * 0.8, PageUp: -element.clientHeight * 0.8,
    Home: -element.scrollHeight, End: element.scrollHeight }
  if (!(event.key in distance)) return
  event.preventDefault()
  event.stopPropagation()
  element.scrollTop += distance[event.key]!
}
</script>

<style scoped>
.footer-memory-status {
  --resource-detail-width: min(calc(26rem * var(--chrome-scale)), calc(100vw - 2rem * var(--chrome-scale)));
  --resource-detail-gap: calc(0.55rem * var(--chrome-scale));
  position: relative; display: flex; align-items: center; flex: 0 1 auto; min-width: 0;
  margin-left: auto; gap: calc(0.75rem * var(--chrome-scale)); color: var(--text-muted);
  font-variant-numeric: tabular-nums; line-height: 1; white-space: nowrap; cursor: default; outline: none;
}
.footer-memory-status:focus-visible { color: var(--text-main); }
.resource-item { display: inline-flex; align-items: center; min-width: 0; gap: calc(0.35rem * var(--chrome-scale)); }
.resource-item > span:first-child { overflow: hidden; text-overflow: ellipsis; }
.resource-track { width: 100%; height: calc(var(--indicator-thickness) * var(--chrome-scale)); background: var(--border-subtle); overflow: hidden; }
.resource-track > span { display: block; width: 100%; height: 100%; background: var(--indicator-neutral); transform-origin: left center; }
.resource-track.unavailable { visibility: hidden; }
.resource-error { color: var(--status-loading); }
.footer-memory-tooltip {
  right: 0; bottom: calc(100% + var(--resource-detail-gap)); box-sizing: border-box;
  width: var(--resource-detail-width); min-width: 0;
  max-height: calc(100dvh - var(--footer-min-h) - var(--resource-detail-gap) - 1rem * var(--chrome-scale));
  overflow-y: auto; overscroll-behavior: contain; pointer-events: auto;
  opacity: 0; visibility: hidden; white-space: normal;
}
.resource-section { display: grid; gap: calc(0.55rem * var(--chrome-scale)); min-width: 0; }
.resource-section + .resource-section { border-top: 1px solid var(--border-subtle); padding-top: calc(0.65rem * var(--chrome-scale)); margin-top: calc(0.25rem * var(--chrome-scale)); }
.resource-section-heading { gap: calc(0.75rem * var(--chrome-scale)); }
.resource-section-heading strong { color: var(--text-main); font-weight: 600; }
.resource-section-heading > :last-child, .resource-note { color: var(--text-muted); }
.resource-detail-row { display: grid; gap: calc(0.25rem * var(--chrome-scale)); }
.footer-memory-tooltip .ui-hover-tooltip-row { grid-template-columns: minmax(0, 1fr) auto; }
.footer-memory-tooltip .ui-hover-tooltip-row > :first-child, .resource-warning { overflow-wrap: anywhere; }
.resource-warning { display: grid; gap: calc(0.25rem * var(--chrome-scale)); color: var(--status-loading); }
.resource-warning strong { font-weight: 600; }
.footer-memory-status:hover::before, .footer-memory-status:focus-visible::before {
  content: ''; position: absolute; right: 0; bottom: 100%; width: var(--resource-detail-width); height: var(--resource-detail-gap);
}
.footer-memory-status:hover .footer-memory-tooltip, .footer-memory-status:focus-visible .footer-memory-tooltip { opacity: 1; visibility: visible; }
</style>
