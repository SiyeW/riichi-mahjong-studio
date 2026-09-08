import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { sameViewRequestContext } from './analysisPosition'
import { createNodeCommentQueue, nodeCommentKey } from './nodeCommentQueue'

type GameViewTransitionDirection = 'forward' | 'backward'

export function useBranchNavigation(options: {
  gameView: TrainerGameView
  status: TrainerStatusSnapshot
  isReadOnlyRecord: Readonly<Ref<boolean>>
  nodeMapById: Readonly<Ref<Map<string, TrainerTreeNode>>>
  activeRoundRootId: Readonly<Ref<string | null>>
  roundRootById: Readonly<Ref<Map<string, TrainerRoundSummary>>>
  confirmationTimeoutMs: number
  getGameplayResponseGeneration: () => number
  markRecordDirty: () => void
  applyStatus: (status: TrainerStatusSnapshot) => void
  applyGameView: (view: TrainerGameView, direction?: GameViewTransitionDirection) => void
}) {
  const {
    gameView,
    status,
    isReadOnlyRecord,
    nodeMapById,
    activeRoundRootId,
    roundRootById,
    confirmationTimeoutMs,
    getGameplayResponseGeneration,
    markRecordDirty,
    applyStatus,
    applyGameView,
  } = options

const branchReturnMap = ref<Record<string, string>>({})
const deleteNodeConfirmationId = ref<string | null>(null)
let deleteNodeConfirmationTimer: number | null = null
const nodeMutationRequestInFlight = ref(false)
const nodeCommentEl = ref<HTMLTextAreaElement | null>(null)
const nodeCommentDraft = ref('')
const nodeComments = createNodeCommentQueue(
  async (update) => {
    if (!window.trainerAPI?.setNodeComment) throw new Error('Node comment service unavailable')
    return window.trainerAPI.setNodeComment(update.nodeId, update.comment)
  },
  (update, comment) => {
    if (
      nodeCommentKey(gameView.gameId, gameView.currentNodeId) === update.key
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

function cancelPendingWheelNavigation() {
  wheelNavigationQueuedNodeId = null
  wheelNavigationQueuedDirection = null
  wheelNavigationGeneration = 0
}

function resizeNodeComment() {
  void nextTick(() => {
    const element = nodeCommentEl.value
    if (!element) return
    element.style.height = 'auto'
    const style = getComputedStyle(element)
    const maximum = Number.parseFloat(style.maxHeight)
    const borderHeight = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
    const naturalHeight = element.scrollHeight + borderHeight
    const height = Number.isFinite(maximum)
      ? Math.min(naturalHeight, maximum)
      : naturalHeight
    element.style.height = `${height}px`
    element.style.overflowY = Number.isFinite(maximum) && naturalHeight > maximum + 1
      ? 'auto'
      : 'hidden'
  })
}

function syncNodeCommentFromView(view: TrainerGameView) {
  const key = nodeCommentKey(view.gameId, view.currentNodeId)
  nodeCommentDraft.value = nodeComments.get(key) ?? String(view.nodeComment || '')
  resizeNodeComment()
}

function onNodeCommentInput() {
  const nodeId = gameView.currentNodeId
  const key = nodeCommentKey(gameView.gameId, nodeId)
  if (!nodeId || !key) return
  const comment = nodeCommentDraft.value
  nodeComments.set(key, nodeId, comment)
  markRecordDirty()
  resizeNodeComment()
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
  const key = nodeCommentKey(gameView.gameId, nodeId)
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
  if (!window.trainerAPI || !gameView.currentNodeId || !canSetCurrentNodeAsMainBranch.value || nodeMutationRequestInFlight.value) return
  deleteNodeConfirmationId.value = null
  nodeMutationRequestInFlight.value = true
  try {
    const response = await window.trainerAPI.setMainBranch(gameView.currentNodeId)
    applyStatus(response.state)
    applyGameView(response.view)
  } finally {
    nodeMutationRequestInFlight.value = false
  }
}

async function deleteCurrentNode() {
  const nodeId = gameView.currentNodeId
  if (!window.trainerAPI || !nodeId || !canDeleteCurrentNode.value || nodeMutationRequestInFlight.value) return
  if (deleteNodeConfirmationId.value !== nodeId) {
    deleteNodeConfirmationId.value = nodeId
    return
  }

  nodeMutationRequestInFlight.value = true
  try {
    discardNodeCommentDraft(nodeId)
    const response = await window.trainerAPI.deleteNode(nodeId)
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
    generation: getGameplayResponseGeneration(), intent: latestNavigationIntentId,
  }
}

async function jumpToNode(nodeId: string, navigationIntentId?: number) {
  if (!window.trainerAPI) return
  cancelPendingWheelNavigation()
  const intentId = navigationIntentId ?? ++latestNavigationIntentId
  latestNavigationIntentId = Math.max(latestNavigationIntentId, intentId)
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
  const response = await window.trainerAPI.jumpToNode(nodeId, gameView.tree?.revision)
  if (intentId !== latestNavigationIntentId || !sameViewRequestContext(requestContext, currentViewRequestContext())) return
  applyStatus(response.state)
  applyGameView(response.view, transitionDirection)
  wheelNavigationCursorNodeId = response.view.currentNodeId
}

async function dispatchQueuedWheelNavigation() {
  if (!window.trainerAPI || wheelNavigationRequestInFlight || !wheelNavigationQueuedNodeId) return
  const nodeId = wheelNavigationQueuedNodeId
  const transitionDirection = wheelNavigationQueuedDirection ?? resolveNodeTransitionDirection(nodeId)
  const generation = wheelNavigationGeneration
  const requestContext = currentViewRequestContext()
  wheelNavigationQueuedNodeId = null
  wheelNavigationQueuedDirection = null
  wheelNavigationRequestInFlight = true

  try {
    const response = await window.trainerAPI.jumpToNode(nodeId, gameView.tree?.revision)
    if (generation !== wheelNavigationGeneration || generation !== latestNavigationIntentId
      || !sameViewRequestContext(requestContext, currentViewRequestContext())) return
    applyStatus(response.state)
    applyGameView(response.view, transitionDirection)
  } finally {
    wheelNavigationRequestInFlight = false
    if (generation === wheelNavigationGeneration && !wheelNavigationQueuedNodeId) {
      wheelNavigationGeneration = 0
      wheelNavigationCursorNodeId = gameView.currentNodeId
    }
    if (wheelNavigationQueuedNodeId) {
      void dispatchQueuedWheelNavigation()
    }
  }
}


function navigateTreeByOffset(offset: number) {
  const cursorNodeId = wheelNavigationCursorNodeId || gameView.currentNodeId
  if (!cursorNodeId) return
  // Rendering filters links outside the active round, but wheel navigation must
  // retain those links to reach the adjacent round on the same branch.
  const node = nodeMapById.value.get(cursorNodeId)
  if (!node) return
  let targetNodeId: string | null = null
  let transitionDirection: GameViewTransitionDirection
  if (offset < 0) {
    if (!node.parentId) return
    if (!nodeMapById.value.has(node.parentId)) {
      const activeRound = activeRoundRootId.value
        ? roundRootById.value.get(activeRoundRootId.value)
        : null
      if (cursorNodeId !== activeRoundRootId.value || !activeRound?.parentRoundId) return
    }
    branchReturnMap.value = {
      ...branchReturnMap.value,
      [node.parentId]: node.id,
    }
    targetNodeId = node.parentId
    transitionDirection = 'backward'
  } else {
    const children = (node.children || []).filter(
      (childId) => nodeMapById.value.has(childId) || roundRootById.value.has(childId),
    )
    if (!children.length) return
    const rememberedChild = branchReturnMap.value[node.id]
    targetNodeId = children.includes(rememberedChild) ? rememberedChild : null
    if (!targetNodeId) {
      targetNodeId = node.mainChildId && children.includes(node.mainChildId)
        ? node.mainChildId
        : children[0]
    }
    if (!targetNodeId) return
    if (rememberedChild && targetNodeId === rememberedChild) {
      const nextMap = { ...branchReturnMap.value }
      delete nextMap[node.id]
      branchReturnMap.value = nextMap
    }
    transitionDirection = 'forward'
  }

  wheelNavigationCursorNodeId = targetNodeId
  if (wheelNavigationGeneration === 0) {
    wheelNavigationGeneration = ++latestNavigationIntentId
  }
  wheelNavigationQueuedNodeId = targetNodeId
  wheelNavigationQueuedDirection = transitionDirection
  void dispatchQueuedWheelNavigation()
}



  function acceptsCurrentViewRequestContext(context: ReturnType<typeof currentViewRequestContext>) {
    return sameViewRequestContext(context, currentViewRequestContext())
  }

  function invalidateNavigation() {
    latestNavigationIntentId += 1
    cancelPendingWheelNavigation()
  }

  function resetForNewGame() {
    invalidateNavigation()
    nodeComments.clear()
  }

  function syncFromGameView(view: TrainerGameView) {
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
    nodeCommentEl,
    nodeMutationRequestInFlight,
    onNodeCommentInput,
    resizeNodeComment,
    resetForNewGame,
    setCurrentNodeAsMainBranch,
    syncFromGameView,
  }
}
