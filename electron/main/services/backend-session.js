// A deliberate restart must not discard the only copy of an unsaved game.
function createBackendSession(backend) {
  const pending = new Set()
  let restarting = null
  let recovery = null

  function sendRequest(...args) {
    if (restarting || recovery) return Promise.reject(new Error('Backend recovery is not complete.'))
    const request = backend.sendRequest(...args)
    pending.add(request)
    request.then(() => pending.delete(request), () => pending.delete(request))
    return request
  }

  function restart() {
    if (restarting) return restarting
    restarting = (async () => {
      await Promise.allSettled([...pending])
      if (!recovery) {
        // Never start an empty replacement just to export from it.
        if (!backend.isRunning()) throw new Error('The stopped backend has no restart snapshot.')
        const { state } = await backend.sendRequest('get_status')
        const record = state.gameLoaded
          ? (await backend.sendRequest('export_game_record')).record
          : null
        if (state.gameLoaded && !record) throw new Error('Backend did not export the current game.')
        recovery = { record, visibility: state.analysisVisibility }
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
      recovery = null
      return { ...response, ok: true }
    })().finally(() => { restarting = null })
    return restarting
  }

  return { sendRequest, restart }
}

module.exports = { createBackendSession }
