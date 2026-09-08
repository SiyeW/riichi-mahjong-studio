<template>
  <div ref="panelElement" class="settings-preview settings-preview-tree" :class="{ collapsed }">
    <button class="panel-section-toggle" @click="toggleCollapsed">
      <h3>{{ t('tree.title') }}</h3>
      <span>{{ collapsed ? t('console.expand') : t('console.collapse') }}</span>
    </button>
    <template v-if="!collapsed">
      <div v-adaptive-button-grid="{ columns: [3, 2, 1], spanLastWhenIncomplete: true }" class="tree-actions">
        <button :disabled="!canSetMain || nodeMutationInFlight" @click="emit('set-main')">{{ t('tree.setMain') }}</button>
        <button
          class="tree-delete-button"
          :class="{ 'confirm-delete': deleteConfirmationPending }"
          :disabled="!canDelete || nodeMutationInFlight"
          @click="emit('delete-node')"
        >
          {{ deleteConfirmationPending ? t('common.confirmDelete') : t('tree.deleteNode') }}
        </button>
        <button :disabled="!currentNodeId" @click="emit('export')">{{ t('common.export') }}</button>
      </div>
      <div
        v-if="treeDots.length"
        :ref="captureTreeScrollElement"
        class="tree-scroll tree-scroll-svg"
        @pointerenter="emit('suspend-auto-follow')"
        @pointerleave="emit('resume-auto-follow')"
        @scroll="handleTreeScroll"
      >
        <div class="tree-canvas" :style="treeCanvasStyle">
          <div class="tree-axis" :style="{ height: `${treeSvgH}px` }">
            <span class="tree-axis-sizer" aria-hidden="true">
              <span v-for="label in treeRowActionLabels" :key="label">{{ label }}</span>
            </span>
            <button
              v-for="row in visibleTreeRows"
              :key="row.depth"
              type="button"
              class="tree-axis-label"
              :class="{ 'is-controlled': row.isControlledAction }"
              :style="{ top: `${row.y}px` }"
              v-ui-tooltip="row.label"
              @click="emit('jump-to-node', row.nodeId)"
            >
              {{ row.label }}
            </button>
          </div>
          <svg class="tree-svg" :width="treeSvgW" :height="treeSvgH">
            <line
              :x1="treeBaseX"
              y1="0"
              :x2="treeBaseX"
              :y2="treeSvgH"
              stroke="rgba(159,213,200,0.22)"
              stroke-width="1"
            />
            <path
              v-for="edge in visibleTreeEdges"
              :key="`${edge.from}-${edge.to}`"
              :d="edge.d"
              fill="none"
              :stroke="treeEdgeStroke(edge)"
              :stroke-width="treeEdgeWidth(edge)"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <rect
              v-for="region in visibleTreeHitRegions"
              :key="`tree-hit-${region.dot.id}`"
              :x="region.x"
              :y="region.y"
              :width="region.width"
              :height="region.height"
              class="tree-hit-region"
              @mouseenter="emit('update:hovered-node-id', region.dot.id)"
              @mouseleave="emit('update:hovered-node-id', null)"
              @click="emit('jump-to-node', region.dot.id)"
            />
            <template v-for="dot in visibleTreeDots" :key="dot.id">
              <rect
                v-if="dot.shape === 'square'"
                :x="dot.x - treeSquareRadius(dot)"
                :y="dot.y - treeSquareRadius(dot)"
                :width="treeSquareRadius(dot) * 2"
                :height="treeSquareRadius(dot) * 2"
                :rx="treeSquareCornerRadius"
                :ry="treeSquareCornerRadius"
                :class="['tree-dot', 'is-square', isCurrentTreeDot(dot) ? 'is-current' : '', dot.isMainline ? 'is-mainline' : '', hoveredNodeId === dot.id ? 'is-hovered' : '']"
                :fill="dot.fill"
                :stroke="isCurrentTreeDot(dot) ? 'white' : (dot.isMainline ? 'rgba(220,244,240,0.45)' : 'none')"
                :stroke-width="treeDotStrokeWidth(dot)"
              />
              <circle
                v-else
                :cx="dot.x"
                :cy="dot.y"
                :r="treeDotRadius(dot)"
                :class="['tree-dot', isCurrentTreeDot(dot) ? 'is-current' : '', dot.isMainline ? 'is-mainline' : '', hoveredNodeId === dot.id ? 'is-hovered' : '']"
                :fill="dot.fill"
                :stroke="isCurrentTreeDot(dot) ? 'white' : (dot.isMainline ? 'rgba(220,244,240,0.45)' : 'none')"
                :stroke-width="treeDotStrokeWidth(dot)"
              />
            </template>
          </svg>
        </div>
      </div>
      <p v-else class="empty-copy">—</p>
      <textarea
        v-if="currentNodeId"
        ref="nodeCommentElement"
        :value="nodeComment"
        class="node-comment"
        rows="1"
        maxlength="20000"
        :placeholder="t('tree.commentPlaceholder')"
        :aria-label="t('tree.currentComment')"
        @input="handleNodeCommentInput"
        @blur="emit('comment-blur')"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import { vAdaptiveButtonGrid } from '../adaptiveButtonGrid'
import type { GraphHitRegion } from '../graphHitRegions'
import { useI18n } from '../i18n'
import type { TreeDotLayout, TreeEdgeLayout, TreeRowLayout } from '../useBranchTreePresentation'

const props = defineProps<{
  canSetMain: boolean
  canDelete: boolean
  deleteConfirmationPending: boolean
  nodeMutationInFlight: boolean
  currentNodeId: string | null
  nodeComment: string
  hoveredNodeId: string | null
  treeDots: TreeDotLayout[]
  treeCanvasStyle: Record<string, string>
  treeBaseX: number
  treeRowActionLabels: string[]
  treeSquareCornerRadius: number
  treeSvgH: number
  treeSvgW: number
  visibleTreeDots: TreeDotLayout[]
  visibleTreeEdges: TreeEdgeLayout[]
  visibleTreeHitRegions: GraphHitRegion<TreeDotLayout>[]
  visibleTreeRows: TreeRowLayout[]
  isCurrentTreeDot: (dot: Pick<TreeDotLayout, 'id'>) => boolean
  treeDotRadius: (dot: TreeDotLayout) => number
  treeDotStrokeWidth: (dot: TreeDotLayout) => number
  treeEdgeStroke: (edge: TreeEdgeLayout) => string
  treeEdgeWidth: (edge: TreeEdgeLayout) => number
  treeSquareRadius: (dot: TreeDotLayout) => number
  registerTreeScrollElement: (element: Element | null) => void
}>()

const emit = defineEmits<{
  'set-main': []
  'delete-node': []
  export: []
  'jump-to-node': [nodeId: string]
  'tree-scroll': []
  'suspend-auto-follow': []
  'resume-auto-follow': []
  'expanded': []
  'update:node-comment': [comment: string]
  'update:hovered-node-id': [nodeId: string | null]
  'comment-input': []
  'comment-blur': []
}>()

const { t } = useI18n()
const collapsed = ref(false)
const panelElement = ref<HTMLElement | null>(null)
const nodeCommentElement = ref<HTMLTextAreaElement | null>(null)
let nodeCommentResizeObserver: ResizeObserver | null = null
let observedPanelWidth = -1

function resizeNodeComment() {
  void nextTick(() => {
    const element = nodeCommentElement.value
    if (!element) return
    element.style.height = 'auto'
    const style = getComputedStyle(element)
    const maximum = Number.parseFloat(style.maxHeight)
    const borderHeight = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
    const naturalHeight = element.scrollHeight + borderHeight
    const height = Number.isFinite(maximum) ? Math.min(naturalHeight, maximum) : naturalHeight
    element.style.height = `${height}px`
    element.style.overflowY = Number.isFinite(maximum) && naturalHeight > maximum + 1 ? 'auto' : 'hidden'
  })
}

function toggleCollapsed() {
  collapsed.value = !collapsed.value
  emit('update:hovered-node-id', null)
  if (!collapsed.value) {
    void nextTick(() => {
      resizeNodeComment()
      emit('expanded')
    })
  }
}

function handleTreeScroll() {
  emit('update:hovered-node-id', null)
  emit('tree-scroll')
}

function captureTreeScrollElement(value: Element | ComponentPublicInstance | null) {
  props.registerTreeScrollElement(value instanceof Element ? value : null)
}

function handleNodeCommentInput(event: Event) {
  const target = event.target as HTMLTextAreaElement | null
  emit('update:node-comment', target?.value || '')
  emit('comment-input')
  resizeNodeComment()
}

watch(() => props.nodeComment, resizeNodeComment)

onMounted(() => {
  nodeCommentResizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? -1
    if (Math.abs(width - observedPanelWidth) < 0.5) return
    observedPanelWidth = width
    resizeNodeComment()
  })
  if (panelElement.value) nodeCommentResizeObserver.observe(panelElement.value)
  resizeNodeComment()
})

watch(panelElement, (element, previous) => {
  if (previous) nodeCommentResizeObserver?.unobserve(previous)
  if (element) nodeCommentResizeObserver?.observe(element)
  observedPanelWidth = -1
  resizeNodeComment()
})

onBeforeUnmount(() => {
  nodeCommentResizeObserver?.disconnect()
  nodeCommentResizeObserver = null
})
</script>
