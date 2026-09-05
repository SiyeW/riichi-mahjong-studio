const { createSessionCheckpoint } = require('./session-checkpoint')

function createBackendSession(backend, checkpointOptions = {}) {
  const pending = new Set()
  let restarting = null
  let recovery = null
  let stopped = false
  let generation = 0
  const checkpoint = createSessionCheckpoint({
    ...checkpointOptions,
    exportRecord: () => backend.sendRequest('export_game_record', { checkpoint: true }),
    isRunning: () => !stopped && !restarting && backend.isRunning(),
  })

  function handleEvent(event) {
    if (event.type === 'service_stopped') {
      stopped = true
      generation += 1
      checkpoint.stop()
    } else if (event.type === 'record_changed' && !restarting && !stopped) {
      checkpoint.changed()
    }
  }

  function sendRequest(...args) {
    if (restarting || recovery || stopped) return Promise.reject(new Error('Backend recovery is not complete.'))
    const startedGeneration = generation
    const request = backend.sendRequest(...args).then(response => {
      if (generation !== startedGeneration) throw new Error('Backend stopped before the response was applied.')
      if (['create_game', 'close_game', 'import_game_record', 'import_mortal_report', 'import_custom_tenhou'].includes(args[0])) {
        checkpoint.reset()
      }
      // Status/metrics have independent Python executors and can arrive after
      // a newer game command. They must not invalidate a current checkpoint.
      if (!/^(get_|export_|describe_|reload_|unload_)/.test(args[0])) {
        checkpoint.observe(response)
        checkpoint.changed()
      }
      return response
    })
    pending.add(request)
    request.then(() => pending.delete(request), () => pending.delete(request))
    return request
  }

  function restart() {
    if (restarting) return restarting
    checkpoint.stop()
    restarting = (async () => {
      await Promise.allSettled([...pending])
      if (!recovery) {
        // Never start an empty replacement just to export from it.
        if (stopped || !backend.isRunning()) {
          recovery = checkpoint.get()
          if (!recovery) recovery = { record: null }
        } else {
          const { state } = await backend.sendRequest('get_status')
          const record = state.gameLoaded
            ? (await backend.sendRequest('export_game_record')).record
            : null
          if (state.gameLoaded && !record) throw new Error('Backend did not export the current game.')
          recovery = { record, visibility: state.analysisVisibility }
        }
      }
      backend.restart()
      let response = recovery.record
        ? await backend.sendRequest('import_game_record', { record: recovery.record })
        : await backend.sendRequest('get_game_view')
      if (recovery.visibility) {
        await backend.sendRequest('set_analysis_visibility', recovery.visibility)
        response = await backend.sendRequest('get_game_view')
      }
      if (!response.state || !response.view || Boolean(response.state.gameLoaded) !== Boolean(recovery.record)) {
        throw new Error('Backend did not confirm the restored game state.')
      }
      checkpoint.observe(response)
      checkpoint.remember(recovery)
      recovery = null
      stopped = false
      return { ...response, ok: true }
    })().finally(() => { restarting = null })
    return restarting
  }

  return { sendRequest, restart, handleEvent, needsRecovery: () => stopped || Boolean(recovery),
    hasCheckpoint: () => Boolean(recovery?.record || checkpoint.get()?.record) }
}

module.exports = { createBackendSession }
