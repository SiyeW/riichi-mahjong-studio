// Throttle complete exports; never overlap them or retain another game's record.
function createSessionCheckpoint({ exportRecord, isRunning, delayMs = 750,
  schedule = setTimeout, cancel = clearTimeout, onError = console.error }) {
  let gameId = null
  let generation = 0
  let checkpoint = null
  let timer = null
  let exporting = false
  let dirty = false

  function stop() {
    generation += 1
    if (timer !== null) cancel(timer)
    timer = null
    dirty = false
  }

  function observe(response) {
    if (response.state?.gameLoaded === false) {
      stop()
      gameId = null
      checkpoint = null
      return
    }
    const nextId = response.view?.gameId
    if (nextId && nextId !== gameId) {
      stop()
      gameId = nextId
      checkpoint = null
    }
  }

  function reset() {
    stop()
    gameId = null
    checkpoint = null
  }

  function changed() {
    if (!gameId || !isRunning()) return
    dirty = true
    arm()
  }

  function arm() {
    if (!dirty || timer !== null || exporting || !isRunning()) return
    timer = schedule(() => { timer = null; void capture() }, delayMs)
    timer?.unref?.()
  }

  async function capture() {
    if (!dirty || !isRunning()) return
    const startedGeneration = generation
    exporting = true
    dirty = false
    try {
      const response = await exportRecord()
      if (generation === startedGeneration && response.record?.game?.gameId === gameId) {
        checkpoint = { record: response.record, visibility: response.state?.analysisVisibility }
      }
    } catch (error) {
      // Keep the last complete record. Retry only after another change.
      if (generation === startedGeneration) onError('[recovery] checkpoint export failed:', error)
    } finally {
      exporting = false
      arm()
    }
  }

  function remember(value) {
    if (value.record?.game?.gameId === gameId) checkpoint = value
  }

  return { observe, changed, stop, reset, remember, get: () => checkpoint }
}

module.exports = { createSessionCheckpoint }
