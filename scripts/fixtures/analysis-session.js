import { createApp, h, nextTick, reactive, ref } from 'vue'
import { useAnalysisSession } from '/src/useAnalysisSession.ts'

export async function checkAnalysisPresentationOwnership(seed) {
  const frames = new Map(), timers = new Map()
  let sequence = 0
  const originals = { raf: window.requestAnimationFrame, cancel: window.cancelAnimationFrame,
    timeout: window.setTimeout, clear: window.clearTimeout }
  window.requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); return id }
  window.cancelAnimationFrame = id => frames.delete(id)
  window.setTimeout = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id }
  window.clearTimeout = id => timers.delete(id)
  const host = document.createElement('div'); document.body.append(host)
  const gameView = reactive(seed.gameView), status = reactive(seed.status), settings = reactive(seed.settings)
  const tableMotionActive = ref(false)
  let session, mounted = false
  const app = createApp({ setup() {
    session = useAnalysisSession({ gameView, status, settings, showAnalysisDock: ref(true), tableMotionActive, t: key => key,
      applyStatus: () => {}, applyGameView: () => {}, scheduleTableZoomRecalc: () => {}, clearDecisionPresentation: () => {} })
    return () => h('div')
  } })
  const result = nodeId => ({ status: 'ready', context: { gameId: gameView.gameId, nodeId, seat: status.controlledSeat, cacheEpoch: 0 },
    outputs: { 'wall-tile-count': { tiles: { '1m': { expectedValue: 1 } } } } })
  const stage = (nodeId, options) => { gameView.currentNodeId = nodeId; session.stageOpponentAnalysisForView(result(nodeId), options) }
  const tick = async () => { await nextTick(); await nextTick() }
  const runFrame = () => {
    const [id, callback] = frames.entries().next().value
    frames.delete(id)
    callback(performance.now() - 1)
  }
  try {
    app.mount(host); mounted = true
    stage('queued-old')
    stage('queued-current')
    await tick()
    const queuedAfterReplacement = frames.size
    runFrame(); runFrame()
    const ordinaryPresented = session.displayedOpponentAnalysis.value?.context?.nodeId
    tableMotionActive.value = true
    stage('flight')
    await tick(); runFrame(); runFrame()
    const flightHeld = session.displayedOpponentAnalysis.value?.context?.nodeId !== 'flight'
    const guessedDeadlineTimers = [...timers.values()].filter(timer => timer.delay < 200).length
    // No guessed 110ms timeout: even if preparation/landing takes longer, the
    // result is retained until the actual owner retires.
    tableMotionActive.value = false
    await tick()
    const presentedOnRetirement = session.displayedOpponentAnalysis.value?.context?.nodeId === 'flight'
    stage('retired-before-next-tick')
    app.unmount(); mounted = false
    await tick()
    const framesAfterUnmount = frames.size
    stage('late-after-unmount')
    await tick()
    return { queuedAfterReplacement, ordinaryPresented, flightHeld, guessedDeadlineTimers, presentedOnRetirement,
      framesAfterUnmount, framesAfterLateCall: frames.size }
  } finally {
    if (mounted) app.unmount()
    window.requestAnimationFrame = originals.raf; window.cancelAnimationFrame = originals.cancel
    window.setTimeout = originals.timeout; window.clearTimeout = originals.clear
    host.remove()
  }
}

export async function checkSavedPredictionMotion(vm, makeResult) {
  const originalView = JSON.parse(JSON.stringify(vm.gameView)), originalStatus = JSON.parse(JSON.stringify(vm.status))
  const originalJump = window.studioAPI.jumpToNode
  const originalRead = window.studioAPI.getAnalysis
  const target = 'saved-prediction-without-provider'
  const nextView = { ...originalView, currentNodeId: target, opponentAnalysis: makeResult(target) }
  const samples = []
  let active = true, frame = 0
  const sample = () => {
    samples.push(document.querySelector('.analysis-dora-distribution canvas')?.rmsDistributionRenderSignature)
    if (active) frame = requestAnimationFrame(sample)
  }
  try {
    vm.status.modelRuntime.opponentAnalysis.unloaded = true
    const nextStatus = JSON.parse(JSON.stringify(vm.status))
    window.studioAPI.jumpToNode = async nodeId => ({ state: nodeId === target ? nextStatus : originalStatus,
      view: nodeId === target ? nextView : originalView })
    window.studioAPI.getAnalysis = async () => vm.gameView.currentNodeId === target
      ? nextView.opponentAnalysis : originalView.opponentAnalysis
    frame = requestAnimationFrame(sample)
    await vm.jumpToNode(target)
    await new Promise(resolve => setTimeout(resolve, 300))
    return { states: new Set(samples.filter(Boolean)).size, unloaded: vm.status.modelRuntime.opponentAnalysis.unloaded,
      canvasPresent: Boolean(document.querySelector('.analysis-dora-distribution canvas')), node: vm.gameView.currentNodeId }
  } finally {
    active = false; cancelAnimationFrame(frame)
    await vm.jumpToNode(originalView.currentNodeId)
    await new Promise(resolve => setTimeout(resolve, 170))
    window.studioAPI.jumpToNode = originalJump
    window.studioAPI.getAnalysis = originalRead
  }
}
