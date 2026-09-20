const { createSessionCheckpoint } = require('./session-checkpoint')

const CHECKPOINT_STATE_ONLY_COMMANDS = new Set([
  'jump_to_node',
  'set_analysis_visibility',
  'start_auto_analysis',
  'cancel_auto_analysis',
])
const DERIVED_RECORD_CHANGES = new Set([
  'decision_analysis_cache',
  'opponent_analysis_cache',
])

function createBackendSession(backend, checkpointOptions = {}) {
  const pending = new Set()
  let restarting = null
  let recovery = null
  let stopped = false
  let generation = 0
  let derivedRecordDirty = false
  const checkpoint = createSessionCheckpoint({
    ...checkpointOptions,
    exportRecord: () => backend.sendRequest('export_recovery_checkpoint'),
    isRunning: () => !stopped && !restarting && backend.isRunning(),
  })

  function handleEvent(event) {
    if (event.type === 'service_stopped') {
      stopped = true
      generation += 1
      checkpoint.stop()
    } else if (event.type === 'record_changed' && !restarting && !stopped) {
      if (DERIVED_RECORD_CHANGES.has(event.change)) derivedRecordDirty = true
      else checkpoint.changed()
    }
  }

  function sendRequest(...args) {
    if (restarting || recovery || stopped) return Promise.reject(new Error('Backend recovery is not complete.'))
    const startedGeneration = generation
    const request = backend.sendRequest(...args).then(response => {
      if (generation !== startedGeneration) throw new Error('Backend stopped before the response was applied.')
      const command = args[0]
      if (['create_game', 'close_game', 'import_game_record', 'import_mortal_report', 'import_custom_tenhou'].includes(command)) {
        checkpoint.reset()
        derivedRecordDirty = false
      }
      // Status/metrics have independent Python executors and can arrive after
      // a newer game command. They must not invalidate a current checkpoint.
      if (command === 'jump_to_node') {
        checkpoint.observe(response)
        checkpoint.moveCursor(response.view?.currentNodeId)
      } else if (command === 'set_analysis_visibility') {
        checkpoint.updateVisibility(response.state?.analysisVisibility)
      } else if (!CHECKPOINT_STATE_ONLY_COMMANDS.has(command)
        && !/^(get_|export_|describe_|reload_|unload_)/.test(command)) {
        checkpoint.observe(response)
        checkpoint.changed()
      }
      return response
    })
    pending.add(request)
    request.then(() => pending.delete(request), () => pending.delete(request))
    return request
  }

  async function exportGameRecord({ reuseCheckpoint = false } = {}) {
    const saved = reuseCheckpoint && !derivedRecordDirty ? checkpoint.getFresh() : null
    if (saved?.record) {
      return {
        record: saved.record,
        state: { gameLoaded: true, analysisVisibility: saved.visibility },
        view: {
          gameId: saved.record.game?.gameId,
          currentNodeId: saved.record.game?.currentNodeId,
        },
        reusedCheckpoint: true,
      }
    }

    const response = await sendRequest('export_game_record')
    checkpoint.rememberFresh({
      record: response.record,
      visibility: response.state?.analysisVisibility,
    })
    derivedRecordDirty = false
    return { ...response, reusedCheckpoint: false }
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
      const recoveryGeneration = generation
      const requestRecovery = async (...args) => {
        const result = await backend.sendRequest(...args)
        if (generation !== recoveryGeneration || !backend.isRunning()) {
          throw new Error('Backend stopped during recovery.')
        }
        return result
      }
      let response = recovery.record
        ? await requestRecovery('import_game_record', { record: recovery.record })
        : await requestRecovery('get_game_view')
      if (recovery.visibility) {
        await requestRecovery('set_analysis_visibility', recovery.visibility)
        response = await requestRecovery('get_game_view')
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

  return { sendRequest, exportGameRecord, restart, handleEvent, needsRecovery: () => stopped || Boolean(recovery),
    hasCheckpoint: () => Boolean(recovery?.record || checkpoint.get()?.record) }
}

module.exports = { createBackendSession }
