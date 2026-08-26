<template>
  <div
    v-if="node.type === 'split'"
    class="dock-layout-split"
    :class="`is-${node.direction}`"
  >
    <DockLayoutNode
      v-for="(child, index) in node.children"
      :key="dockNodeKey(child)"
      :node="child"
      :style="{ flexGrow: node.weights[index] || 1 }"
    >
      <template #default="slotProps">
        <slot v-bind="slotProps" />
      </template>
    </DockLayoutNode>
  </div>
  <div
    v-else
    class="dock-layout-leaf"
    :data-dock-target="node.id"
  >
    <slot :id="node.id" />
  </div>
</template>

<script setup lang="ts">
import type { WorkspaceDockNode } from '../workspaceLayout'

defineProps<{ node: WorkspaceDockNode }>()

function dockNodeKey(node: WorkspaceDockNode): string {
  if (node.type === 'item') return node.id
  return `${node.direction}:${node.children.map(dockNodeKey).join('|')}`
}
</script>
