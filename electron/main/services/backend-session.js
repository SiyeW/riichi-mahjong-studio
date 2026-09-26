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
  const pendingRecordCommands = new Set()
  let restarting = null
  let recovery = null
  let stopped = false
  let generation = 0
  let derivedRecordDirty = false
  let changeRevision = 0
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
      changeRevision += 1
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
    const command = args[0]
    if (!/^(get_|export_|describe_|reload_|unload_)/.test(command)
      && command !== 'start_auto_analysis' && command !== 'cancel_auto_analysis') {
      pendingRecordCommands.add(request)
    }
    const finished = () => { pending.delete(request); pendingRecordCommands.delete(request) }
    request.then(finished, finished)
    return request
  }

  async function exportGameRecord({ reuseCheckpoint = false } = {}) {
    // Exports have their own Python executor. Finish already submitted edits
    // first, so a save cannot overtake a comment still on the command lane.
    await Promise.all([...pendingRecordCommands])
    const saved = reuseCheckpoint && !derivedRecordDirty ? checkpoint.getFresh() : null
    // Crash checkpoints intentionally omit caches; they are not full saves.
    if (saved?.record && saved.includesAnalysis) {
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

    const exportedRevision = changeRevision
    const response = await sendRequest('export_game_record', {}, 120_000)
    if (changeRevision === exportedRevision) {
      checkpoint.rememberFresh({
        record: response.record,
        visibility: response.state?.analysisVisibility,
        includesAnalysis: true,
      })
      derivedRecordDirty = false
    }
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
