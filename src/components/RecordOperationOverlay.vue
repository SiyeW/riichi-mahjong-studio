<template>
  <div class="record-operation-overlay" role="status" aria-live="polite" aria-atomic="true">
    <div class="record-operation-card">
      <strong>{{ title }}</strong>
      <div class="record-operation-progress" aria-hidden="true"><span></span></div>
      <span>{{ detail }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ title: string; detail: string }>()
</script>

<style scoped>
.record-operation-overlay {
  position: fixed;
  z-index: 200;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 24, 30, 0.72);
}

.record-operation-card {
  box-sizing: border-box;
  display: grid;
  width: min(calc(22rem * var(--chrome-scale)), calc(100vw - 2rem));
  gap: calc(0.6rem * var(--chrome-scale));
  padding: calc(0.85rem * var(--chrome-scale)) calc(1rem * var(--chrome-scale));
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  background: var(--surface-overlay);
  font-size: var(--ui-text-body);
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.record-operation-card > strong {
  color: var(--text-main);
  font-size: var(--ui-text-heading);
  font-weight: 600;
}

.record-operation-progress {
  overflow: hidden;
  height: 3px;
  background: var(--border-strong);
}

.record-operation-progress > span {
  display: block;
  height: 100%;
  width: 40%;
  background: var(--text-dim);
  animation: record-operation-pending 1.2s linear infinite;
}

@keyframes record-operation-pending {
  from { transform: translateX(-100%); }
  to { transform: translateX(250%); }
}

@media (prefers-reduced-motion: reduce) {
  .record-operation-progress > span { animation: none; width: 100%; opacity: 0.5; }
}
</style>
