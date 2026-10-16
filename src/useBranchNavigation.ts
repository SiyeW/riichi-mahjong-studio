import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { sameViewRequestContext, sameViewRequestScope } from './analysisPosition'
import { createNodeCommentQueue, nodeCommentKey } from './nodeCommentQueue'
import { recordCommandScope } from './recordCommandScope.ts'
import type { GameTreeNode, GameView, GameViewTransitionDirection, RoundSummary } from './contracts/game'
import type { StudioStatus } from './contracts/runtime'

export function useBranchNavigation(options: {
  gameView: GameView
  status: StudioStatus
  isReadOnlyRecord: Readonly<Ref<boolean>>
  nodeMapById: Readonly<Ref<Map<string, GameTreeNode>>>
  roundRootById: Readonly<Ref<Map<string, RoundSummary>>>
  confirmationTimeoutMs: number
  getGameplayResponseGeneration: () => number
  markRecordDirty: () => void
  applyStatus: (status: StudioStatus) => void
  applyGameView: (view: GameView, direction?: GameViewTransitionDirection) => void
  expectAnalysisVisit: (intent: number, nodeId: string) => void
  invalidateAnalysisVisit: () => void
  settleAnalysisVisit: () => void
}) {
  const {
    gameView,
    status,
    isReadOnlyRecord,
    nodeMapById,
    roundRootById,
    confirmationTimeoutMs,
    getGameplayResponseGeneration,
    markRecordDirty,
    applyStatus,
    applyGameView,
    expectAnalysisVisit,
    invalidateAnalysisVisit,
    settleAnalysisVisit,
  } = options

const branchReturnMap = ref<Record<string, string>>({})
const deleteNodeConfirmationId = ref<string | null>(null)
let deleteNodeConfirmationTimer: number | null = null
const nodeMutationRequestInFlight = ref(false)
const nodeCommentDraft = ref('')
const nodeComments = createNodeCommentQueue(
  async (update) => {
    if (!window.studioAPI?.setNodeComment) throw new Error('Node comment service unavailable')
    return window.studioAPI.setNodeComment(update.nodeId, update.comment, update.scope)
  },
  (update, comment) => {
    if (
      commentKey(gameView) === update.key
      && nodeCommentDraft.value === update.comment
    ) nodeCommentDraft.value = comment
  },
)
const NODE_COMMENT_SAVE_DELAY_MS = 400
let nodeCommentSaveTimer: number | null = null
let wheelNavigationCursorNodeId: string | null = null
let wheelNavigationQueuedNodeId: string | null = null
let wheelNavigationQueuedDirection: GameViewTransitionDirection | null = null
let wheelNavigationRequestInFlight = false
let wheelNavigationGeneration = 0
let latestNavigationIntentId = 0
let wheelNavigationEpoch = 0
let wheelNavigationBurst = 0
let wheelNavigationDirection: GameViewTransitionDirection | null = null
const deferredWheelRuns: Array<{ offset: -1 | 1; count: number }> = []
const wheelTraversalNodes = new Map<string, GameTreeNode>()
const MAX_DEFERRED_WHEEL_RUNS = 256

function cancelPendingWheelNavigation() {
  wheelNavigationBurst += 1
  wheelNavigationEpoch += 1
  wheelNavigationDirection = null
  wheelNavigationQueuedNodeId = null
  wheelNavigationQueuedDirection = null
  wheelNavigationGeneration = 0
  deferredWheelRuns.length = 0
  wheelTraversalNodes.clear()
}

function commentKey(view: GameView, nodeId = view.currentNodeId) {
  return nodeCommentKey(view.viewToken?.sessionId || view.gameId, nodeId)
}

function syncNodeCommentFromView(view: GameView) {
  const key = commentKey(view)
  nodeCommentDraft.value = nodeComments.get(key) ?? String(view.nodeComment || '')
}

function onNodeCommentInput() {
  const nodeId = gameView.currentNodeId
  const key = commentKey(gameView, nodeId)
  if (!nodeId || !key) return
  const comment = nodeCommentDraft.value
  nodeComments.set(key, nodeId, comment, recordCommandScope(gameView))
  markRecordDirty()
  if (nodeCommentSaveTimer !== null) window.clearTimeout(nodeCommentSaveTimer)
  nodeCommentSaveTimer = window.setTimeout(() => {
    nodeCommentSaveTimer = null
    flushNodeCommentInBackground()
  }, NODE_COMMENT_SAVE_DELAY_MS)
}

function flushNodeComment(): Promise<void> {
  if (nodeCommentSaveTimer !== null) {
    window.clearTimeout(nodeCommentSaveTimer)
    nodeCommentSaveTimer = null
  }
  return nodeComments.flush()
}

function flushNodeCommentInBackground() {
  void flushNodeComment().catch((error) => {
    console.error('Failed to save node comment:', error)
  })
}

function discardNodeCommentDraft(nodeId: string) {
  const key = commentKey(gameView, nodeId)
  if (!key) return
  nodeComments.discard(key)
}

const canSetCurrentNodeAsMainBranch = computed(() => {
  if (isReadOnlyRecord.value) return false
  const nodeId = gameView.currentNodeId
  if (!nodeId) return false
  const node = nodeMapById.value.get(nodeId)
  return !!node && !!node.parentId
})

const canDeleteCurrentNode = computed(() => {
  if (isReadOnlyRecord.value) return false
  const nodeId = gameView.currentNodeId
  if (!nodeId) return false
  const node = nodeMapById.value.get(nodeId)
  return !!node?.parentId
})

const deleteNodeConfirmationPending = computed(() => {
  const nodeId = gameView.currentNodeId
  return Boolean(nodeId) && deleteNodeConfirmationId.value === nodeId
})

watch(() => gameView.currentNodeId, () => {
  deleteNodeConfirmationId.value = null
})

watch(deleteNodeConfirmationId, (nodeId) => {
  if (deleteNodeConfirmationTimer !== null) {
    window.clearTimeout(deleteNodeConfirmationTimer)
    deleteNodeConfirmationTimer = null
  }
  if (!nodeId) return
  deleteNodeConfirmationTimer = window.setTimeout(() => {
    if (deleteNodeConfirmationId.value === nodeId) {
      deleteNodeConfirmationId.value = null
    }
  }, confirmationTimeoutMs)
})

async function setCurrentNodeAsMainBranch() {
  if (!window.studioAPI || !gameView.currentNodeId || !canSetCurrentNodeAsMainBranch.value || nodeMutationRequestInFlight.value) return
  deleteNodeConfirmationId.value = null
  cancelPendingWheelNavigation()
  nodeMutationRequestInFlight.value = true
  try {
    const response = await window.studioAPI.setMainBranch(gameView.currentNodeId, recordCommandScope(gameView))
    cancelPendingWheelNavigation()
    applyStatus(response.state)
    applyGameView(response.view)
  } finally {
    nodeMutationRequestInFlight.value = false
  }
}

async function deleteCurrentNode() {
  const nodeId = gameView.currentNodeId
  if (!window.studioAPI || !nodeId || !canDeleteCurrentNode.value || nodeMutationRequestInFlight.value) return
  if (deleteNodeConfirmationId.value !== nodeId) {
    deleteNodeConfirmationId.value = nodeId
    return
  }

  nodeMutationRequestInFlight.value = true
  try {
    cancelPendingWheelNavigation()
    discardNodeCommentDraft(nodeId)
    const response = await window.studioAPI.deleteNode(nodeId, recordCommandScope(gameView))
    cancelPendingWheelNavigation()
    branchReturnMap.value = {}
    applyStatus(response.state)
    applyGameView(response.view, 'backward')
  } finally {
    deleteNodeConfirmationId.value = null
    nodeMutationRequestInFlight.value = false
  }
}


function resolveNodeTransitionDirection(nodeId: string): GameViewTransitionDirection {
  const targetNode = nodeMapById.value.get(nodeId)
  const currentNode = gameView.currentNodeId ? nodeMapById.value.get(gameView.currentNodeId) : null
  return targetNode && currentNode && targetNode.depth < currentNode.depth ? 'backward' : 'forward'
}

function currentViewRequestContext() {
  return {
    gameId: gameView.gameId, seat: status.controlledSeat, mode: status.mode,
    sessionId: gameView.viewToken?.sessionId,
    generation: getGameplayResponseGeneration(), intent: latestNavigationIntentId,
  }
}

async function jumpToNode(nodeId: string, navigationIntentId?: number) {
  if (!window.studioAPI) return
  cancelPendingWheelNavigation()
  const intentId = navigationIntentId ?? ++latestNavigationIntentId
  latestNavigationIntentId = Math.max(latestNavigationIntentId, intentId)
  expectAnalysisVisit(intentId, nodeId)
  const requestContext = currentViewRequestContext()
  wheelNavigationCursorNodeId = nodeId
  const targetNode = nodeMapById.value.get(nodeId)
  const transitionDirection = resolveNodeTransitionDirection(nodeId)
  if (targetNode?.parentId) {
    branchReturnMap.value = {
      ...branchReturnMap.value,
      [targetNode.parentId]: nodeId,
    }
  }
  let response
  try {
    response = await window.studioAPI.jumpToNode(nodeId, gameView.tree?.revision, intentId)
  } catch (error) {
    if (intentId === latestNavigationIntentId) {
      wheelNavigationCursorNodeId = gameView.currentNodeId
      settleAnalysisVisit()
    }
    throw error
  }
  if (intentId !== latestNavigationIntentId || !sameViewRequestContext(requestContext, currentViewRequestContext())) return
  applyStatus(response.state)
  applyGameView(response.view, transitionDirection)
  wheelNavigationCursorNodeId = response.view.currentNodeId
}

async function dispatchQueuedWheelNavigation() {
  if (!window.studioAPI || wheelNavigationRequestInFlight || !wheelNavigationQueuedNodeId) return
  const nodeId = wheelNavigationQueuedNodeId
  const transitionDirection = wheelNavigationQueuedDirection ?? resolveNodeTransitionDirection(nodeId)
  const generation = wheelNavigationGeneration
  const epoch = wheelNavigationEpoch
  const burst = wheelNavigationBurst
  const requestContext = currentViewRequestContext()
  wheelNavigationQueuedNodeId = null
  wheelNavigationQueuedDirection = null
  wheelNavigationRequestInFlight = true

  try {
    const response = await window.studioAPI.jumpToNode(nodeId, gameView.tree?.revision, generation)
    const sameScope = sameViewRequestScope(requestContext, currentViewRequestContext())
    // Structural facts can unblock a reversal without displaying the old table.
    // They are temporary to this burst and never cross record/seat/mode/edit scope.
    const tree = response.view.tree
    if (sameScope && burst === wheelNavigationBurst && wheelNavigationGeneration !== 0 && tree && !tree.compact
      && (epoch === wheelNavigationEpoch || deferredWheelRuns.length > 0)
      && (tree.revision ?? 0) >= (gameView.tree?.revision ?? 0)) {
      wheelTraversalNodes.clear()
      const nodes = Array.isArray(tree.nodes) ? tree.nodes : Object.values(tree.nodes || {})
      nodes.forEach(node => wheelTraversalNodes.set(node.id, node))
    }
    // Keep making visible progress during a same-direction wheel burst, even
    // when another wheel target queued before this reply. Reversal, explicit
    // jumps and record/seat/mode changes still invalidate the old burst.
    if (epoch !== wheelNavigationEpoch
      || !sameScope) return
    applyStatus(response.state)
    applyGameView(response.view, transitionDirection)
  } catch (error) {
    if (burst === wheelNavigationBurst && sameViewRequestScope(requestContext, currentViewRequestContext())) {
      deferredWheelRuns.length = 0
      wheelTraversalNodes.clear()
      if (generation === latestNavigationIntentId) settleAnalysisVisit()
    }
    console.error('Failed to navigate record:', error)
  } finally {
    drainDeferredWheelSteps()
    wheelNavigationRequestInFlight = false
    if (generation === wheelNavigationGeneration && !wheelNavigationQueuedNodeId && !deferredWheelRuns.length) {
      wheelNavigationGeneration = 0
      wheelNavigationDirection = null
      wheelNavigationCursorNodeId = gameView.currentNodeId
      wheelTraversalNodes.clear()
    }
    if (wheelNavigationQueuedNodeId) {
      void dispatchQueuedWheelNavigation()
    }
  }
}


function resolveWheelStep(offset: number): 'moved' | 'boundary' | 'waiting' {
  const cursorNodeId = wheelNavigationCursorNodeId || gameView.currentNodeId
  if (!cursorNodeId) return 'boundary'
  // Rendering filters links outside the active round, but wheel navigation must
  // retain those links to reach the adjacent round on the same branch.
  const lookup = (id: string) => wheelTraversalNodes.get(id) || nodeMapById.value.get(id)
  const node = lookup(cursorNodeId)
  if (!node) return 'waiting'
  let targetNodeId: string | null = null
  let transitionDirection: GameViewTransitionDirection
  if (offset < 0) {
    if (!node.parentId) return 'boundary'
    if (!lookup(node.parentId)) {
      const round = roundRootById.value.get(cursorNodeId)
      if (!round?.parentRoundId) return 'boundary'
    }
    branchReturnMap.value = {
      ...branchReturnMap.value,
      [node.parentId]: node.id,
    }
    targetNodeId = node.parentId
    transitionDirection = 'backward'
  } else {
    const children = (node.children || []).filter(
      (childId) => Boolean(lookup(childId)) || roundRootById.value.has(childId),
    )
    if (!children.length) return 'boundary'
    const rememberedChild = branchReturnMap.value[node.id]
    targetNodeId = children.includes(rememberedChild) ? rememberedChild : null
    if (!targetNodeId) {
      targetNodeId = node.mainChildId && children.includes(node.mainChildId)
        ? node.mainChildId
        : children[0]
    }
    if (!targetNodeId) return 'boundary'
    if (rememberedChild && targetNodeId === rememberedChild) {
      const nextMap = { ...branchReturnMap.value }
      delete nextMap[node.id]
      branchReturnMap.value = nextMap
    }
    transitionDirection = 'forward'
  }

  if (wheelNavigationDirection && wheelNavigationDirection !== transitionDirection) wheelNavigationEpoch += 1
  wheelNavigationDirection = transitionDirection
  wheelNavigationCursorNodeId = targetNodeId
  wheelNavigationGeneration = ++latestNavigationIntentId
  expectAnalysisVisit(wheelNavigationGeneration, targetNodeId)
  wheelNavigationQueuedNodeId = targetNodeId
  wheelNavigationQueuedDirection = transitionDirection
  void dispatchQueuedWheelNavigation()
  return 'moved'
}

function drainDeferredWheelSteps() {
  while (deferredWheelRuns.length) {
    const run = deferredWheelRuns[0]
    const result = resolveWheelStep(run.offset)
    if (result === 'waiting') return
    if (result === 'boundary' || --run.count === 0) deferredWheelRuns.shift()
  }
}

function navigateTreeByOffset(offset: number) {
  if (!offset) return
  const step = offset < 0 ? -1 : 1
  const direction = step < 0 ? 'backward' : 'forward'
  if (wheelNavigationDirection && wheelNavigationDirection !== direction) wheelNavigationEpoch++
  wheelNavigationDirection = direction
  const previous = deferredWheelRuns.at(-1)
  if (previous?.offset === step) previous.count++
  else deferredWheelRuns.push({ offset: step, count: 1 })
  if (deferredWheelRuns.length > MAX_DEFERRED_WHEEL_RUNS) {
    cancelPendingWheelNavigation()
    wheelNavigationCursorNodeId = gameView.currentNodeId
    settleAnalysisVisit()
    console.warn('Canceled an overloaded wheel navigation burst')
    return
  }
  drainDeferredWheelSteps()
}



  function acceptsCurrentViewRequestContext(context: ReturnType<typeof currentViewRequestContext>) {
    return sameViewRequestContext(context, currentViewRequestContext())
  }

  function invalidateNavigation() {
    invalidateAnalysisVisit()
    latestNavigationIntentId += 1
    cancelPendingWheelNavigation()
  }

  function resetForNewGame() {
    invalidateNavigation()
    nodeComments.clear()
  }

  function syncFromGameView(view: GameView) {
    syncNodeCommentFromView(view)
    if (wheelNavigationGeneration === 0) {
      wheelNavigationCursorNodeId = view.currentNodeId
    }
  }

  function hasNodeCommentDrafts() {
    return nodeComments.hasDrafts()
  }

  onBeforeUnmount(() => {
    flushNodeCommentInBackground()
    if (deleteNodeConfirmationTimer !== null) {
      window.clearTimeout(deleteNodeConfirmationTimer)
      deleteNodeConfirmationTimer = null
    }
    cancelPendingWheelNavigation()
  })

  return {
    acceptsCurrentViewRequestContext,
    canDeleteCurrentNode,
    canSetCurrentNodeAsMainBranch,
    cancelPendingWheelNavigation,
    currentViewRequestContext,
    deleteCurrentNode,
    deleteNodeConfirmationPending,
    flushNodeComment,
    flushNodeCommentInBackground,
    hasNodeCommentDrafts,
    invalidateNavigation,
    jumpToNode,
    navigateTreeByOffset,
    nodeCommentDraft,
    nodeMutationRequestInFlight,
    onNodeCommentInput,
    resetForNewGame,
    setCurrentNodeAsMainBranch,
    syncFromGameView,
  }
}
