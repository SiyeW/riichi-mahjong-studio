<template>
  <div
    v-if="node.type === 'split'"
    class="dock-layout-split"
    :class="`is-${node.direction}`"
    :data-dock-path="node.sourcePath.join('.')"
  >
    <template v-for="(child, index) in node.children" :key="dockNodeKey(child)">
      <div
        class="dock-layout-child"
        :style="{ flexGrow: node.weights[index] || 1 }"
      >
        <DockLayoutNode
          :node="child"
          @resize-start="emit('resize-start', $event)"
        >
          <template #default="slotProps">
            <slot v-bind="slotProps" />
          </template>
        </DockLayoutNode>
      </div>
      <div
        v-if="index < node.children.length - 1"
        class="dock-layout-resizer"
        :class="`is-${node.direction}`"
        role="separator"
        :aria-orientation="node.direction === 'horizontal' ? 'vertical' : 'horizontal'"
        @pointerdown="startResize($event, index)"
      />
    </template>
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
import type {
  DockResizeRequest,
  WorkspaceDockViewNode,
  WorkspaceItemId,
} from '../workspaceLayout'

const props = defineProps<{ node: WorkspaceDockViewNode }>()
const emit = defineEmits<{ 'resize-start': [request: DockResizeRequest] }>()

function dockNodeKey(node: WorkspaceDockViewNode): string {
  if (node.type === 'item') return node.id
  return `${node.direction}:${node.children.map(dockNodeKey).join('|')}`
}

function dockNodeItems(node: WorkspaceDockViewNode): WorkspaceItemId[] {
  return node.type === 'item' ? [node.id] : node.children.flatMap(dockNodeItems)
}

function startResize(event: PointerEvent, index: number) {
  if (event.button !== 0 || props.node.type !== 'split') return
  const handle = event.currentTarget as HTMLElement | null
  const beforeElement = handle?.previousElementSibling as HTMLElement | null
  const afterElement = handle?.nextElementSibling as HTMLElement | null
  const beforeChild = props.node.children[index]
  const afterChild = props.node.children[index + 1]
  if (!beforeElement || !afterElement || !beforeChild || !afterChild) return
  const beforeBounds = beforeElement.getBoundingClientRect()
  const afterBounds = afterElement.getBoundingClientRect()
  event.preventDefault()
  event.stopPropagation()
  emit('resize-start', {
    direction: props.node.direction,
    sourcePath: [...props.node.sourcePath],
    beforeIndex: props.node.sourceChildIndexes[index],
    afterIndex: props.node.sourceChildIndexes[index + 1],
    beforeItems: dockNodeItems(beforeChild),
    afterItems: dockNodeItems(afterChild),
    beforeSize: props.node.direction === 'horizontal' ? beforeBounds.width : beforeBounds.height,
    afterSize: props.node.direction === 'horizontal' ? afterBounds.width : afterBounds.height,
    event,
  })
}
</script>
