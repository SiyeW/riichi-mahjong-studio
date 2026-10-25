const { randomUUID } = require('node:crypto')
const { createRecordWorkspaces } = require('./record-workspaces')

const REPLACEMENTS = new Set(['create_game', 'import_game_record', 'import_mortal_report',
  'import_custom_tenhou', 'import_replay_file'])
const READ_ONLY = /^(get_|export_|describe_|reload_|unload_|record_)/

/** Main owns logical record identity; Python owns incremental data/backing. */
function createBackendSession(backend, options = {}) {
  const workspaces = options.workspaces || createRecordWorkspaces(options.workspaceRoot, { retain: options.retain })
  const pending = new Set()
  const pendingEdits = new Set()
  let runtime = null
  let generation = 0
  let stopped = false
  let restarting = null
  let changingRecord = false
  let close = null
  let pathIntent = 0
  const unconfirmedCandidates = new Set()

  function observe(response) {
    if (Object.hasOwn(response, 'recordRuntime')) {
      const value = response.recordRuntime
      if (value && value.workspaceId !== workspaces.getActive()) return response
      if (value && runtime?.session === value.session) {
        const saved = value.pathIntent >= runtime.pathIntent ? value : runtime
        runtime = { ...value, contentRevision: Math.max(value.contentRevision, runtime.contentRevision),
          cursorSequence: Math.max(value.cursorSequence, runtime.cursorSequence),
          pathIntent: saved.pathIntent, savedPath: saved.savedPath,
          recoveryWarning: saved.recoveryWarning,
          savedContentRevision: saved.savedContentRevision, savedCursorSequence: saved.savedCursorSequence }
      } else runtime = value
      pathIntent = Math.max(pathIntent, value?.saveIntentSequence || 0, runtime?.pathIntent || 0)
      options.onRuntime?.(runtime)
    }
    return response
  }

  function raw(command, payload = {}, timeout = null) {
    const started = generation
    return backend.sendRequest(command, payload, timeout).then(response => {
      if (started !== generation) throw new Error('Backend stopped before the response was applied.')
      return response
    })
  }

  function track(request, edit = false) {
    pending.add(request)
    if (edit) pendingEdits.add(request)
    const finished = () => { pending.delete(request); pendingEdits.delete(request) }
    request.then(finished, finished)
    return request
  }

  async function replace(command, payload, timeout, existing = false) {
    const identity = existing ? payload.workspaceId : await workspaces.allocate()
    const previous = workspaces.getActive()
    let activated = false
    try {
      const response = await raw(command, { ...payload, workspaceId: identity }, timeout)
      activated = true
      await workspaces.activate(identity, { previous, saved: response.recordRuntime })
      await raw('record_confirm_activation', { workspaceId: identity, previous: previous === identity ? null : previous })
      return observe(response)
    } catch (error) {
      if (activated) {
        // Do not label an already activated backend record as discarded or
        // allow the old renderer to keep issuing edits into it. Retain both
        // claims; restart reconciles the last main-confirmed logical owner.
        unconfirmedCandidates.add(identity)
        stopped = true
        generation++
        options.onFault?.(error)
        throw error
      }
      if (!stopped && backend.isRunning()) {
        try {
          const released = await raw('record_abandon', { workspaceId: identity })
          await workspaces.released(released.result)
        } catch (failure) { console.warn('[record] candidate release remains owned:', failure.message) }
      }
      await workspaces.abandon(identity, { existing }).catch(failure => {
        console.error('[record] failed to release preparation:', failure)
      })
      throw error
    }
  }

  function sendRequest(command, payload = {}, timeout = 15_000) {
    if (restarting || stopped) return Promise.reject(new Error('Backend recovery is not complete.'))
    if (REPLACEMENTS.has(command)) {
      if (changingRecord || close) return Promise.reject(new Error('A record replacement or close is pending.'))
      changingRecord = true
      const baseline = payload.savedBaseline || { clean: command === 'import_game_record' && Boolean(payload.path), target: payload.path || '' }
      return track(replace(command, { ...payload, savedBaseline: baseline }, null)
        .finally(() => { changingRecord = false }), true)
    }
    const mutates = !READ_ONLY.test(command) && command !== 'start_auto_analysis' && command !== 'cancel_auto_analysis'
    if (mutates && (changingRecord || close)) return Promise.reject(new Error('Record changes are frozen for replacement or close.'))
    const scoped = runtime && mutates ? { ...payload, recordScope: runtime.session } : payload
    return track(raw(command, scoped, mutates ? null : timeout).then(async response => {
      if (command === 'close_game') await workspaces.discardActive()
      return observe(response)
    }), mutates)
  }

  async function captureSave(target, appVersion = '') {
    if (stopped || restarting || changingRecord || close || !runtime) throw new Error('No current record is ready to save.')
    const workspaceId = runtime.workspaceId
    await Promise.allSettled([...pendingEdits])
    if (runtime?.workspaceId !== workspaceId) throw new Error('The record changed before save capture.')
    const saveId = randomUUID()
    const response = await raw('record_save_capture', { workspaceId, saveId, target,
      pathIntent: ++pathIntent, appVersion })
    return response.result
  }

  const writeSave = (token, staging) => track(raw('record_save_write', { saveId: token.saveId, path: staging }))
  const acknowledgeSave = token => track(raw('record_save_committed', token).then(observe))
  const abortSave = token => raw('record_save_abort', { saveId: token.saveId })
  const releaseSave = token => raw('record_save_release', { saveId: token.saveId })

  async function prepareClose(retain, onStage = () => {}) {
    if (close) return close.promise
    const operation = { closeId: randomUUID(), workspaceId: null, cancelled: false, prepared: null }
    close = operation
    operation.promise = (async () => {
      await Promise.allSettled([...pendingEdits])
      if (operation.cancelled) return null
      if (!runtime) { if (close === operation) close = null; return null }
      operation.workspaceId = runtime.workspaceId
      onStage('preparing')
      await raw('record_close_capture', { closeId: operation.closeId, workspaceId: operation.workspaceId, retain })
      if (operation.cancelled) { await raw('record_close_cancel', { closeId: operation.closeId }); return null }
      onStage('recovery')
      const response = await raw('record_close_prepare', { closeId: operation.closeId })
      if (operation.cancelled) return null
      operation.prepared = response.result
      return operation.prepared
    })()
    return operation.promise
  }

  async function cancelClose() {
    const operation = close
    if (!operation) return
    operation.cancelled = true
    await raw('record_close_cancel', { closeId: operation.closeId })
    await workspaces.cancelClose(operation.workspaceId)
    if (close === operation) close = null
  }

  async function confirmClose() {
    const operation = close
    if (!operation && !runtime) return
    if (!operation || !operation.prepared || operation.cancelled) throw new Error('Close has no prepared recovery.')
    await workspaces.retainClose(operation.workspaceId, operation.prepared.recovery)
    if (operation.cancelled || close !== operation) throw new Error('Close was cancelled.')
    await raw('record_close_confirm', { closeId: operation.closeId })
    await raw('record_wait_released', { workspaceId: operation.workspaceId })
    runtime = null
    close = null
  }

  function handleEvent(event) {
    if (event.type === 'service_stopped') { stopped = true; generation++ }
    if (event.type === 'workspace_released') void workspaces.released(event).catch(error => console.error('[record] retirement:', error))
    if (Object.hasOwn(event, 'recordRuntime')) observe(event)
  }

  function restart() {
    if (restarting) return restarting
    restarting = (async () => {
      await Promise.allSettled([...pending])
      const identity = workspaces.getActive()
      if (!stopped && backend.isRunning() && identity) {
        const closeId = randomUUID()
        await raw('record_close_capture', { workspaceId: identity, closeId, retain: true })
        try { await raw('record_close_prepare', { closeId }) } catch (error) {
          await raw('record_close_cancel', { closeId })
          throw error
        }
      }
      await backend.restart({ graceful: true })
      for (const candidate of unconfirmedCandidates) {
        if (candidate !== identity) {
          await workspaces.released({ workspaceId: candidate })
          await workspaces.abandon(candidate)
        }
      }
      unconfirmedCandidates.clear()
      const response = identity ? await raw('record_restore', { workspaceId: identity }) : await raw('get_game_view')
      if (identity) await raw('record_confirm_activation', { workspaceId: identity })
      if (!backend.isRunning() || Boolean(response.state?.gameLoaded) !== Boolean(identity)) {
        throw new Error('Backend did not confirm the restored game state.')
      }
      stopped = false
      return { ...observe(response), ok: true }
    })().finally(() => { restarting = null })
    return restarting
  }

  async function restoreStartup() {
    if (runtime || workspaces.getActive()) return null
    for (const manifest of await workspaces.recoverable()) {
      try { await workspaces.claimRecovery(manifest) } catch (error) {
        if (error.code === 'EADDRINUSE') continue
        throw error
      }
      const recovery = manifest.recovery
      if (recovery.kind === 'workspace') {
        const response = await replace('record_restore', { workspaceId: manifest.workspaceId }, null, true)
        return { ...response, recoveryUnclean: manifest.status === 'active' }
      }
      if (recovery.kind === 'source') {
        try {
          const response = await replace('import_game_record', { path: recovery.path,
            expectedSource: recovery.fileIdentity, bookmark: recovery.bookmark,
            savedBaseline: { clean: true, target: recovery.path } }, null)
          await workspaces.consumeRecovery(manifest.workspaceId)
          return response
        } catch (error) { await workspaces.abandon(manifest.workspaceId, { existing: true }); throw error }
      }
      await workspaces.abandon(manifest.workspaceId, { existing: true })
    }
    return null
  }

  async function shutdown() { await backend.stop(undefined, { graceful: true }); await workspaces.shutdown() }
  return { sendRequest, captureSave, writeSave, acknowledgeSave, abortSave, releaseSave, prepareClose, cancelClose,
    confirmClose, restoreStartup, restart, shutdown, handleEvent,
    getRuntime: () => runtime, updateRetention: workspaces.updateRetention,
    needsRecovery: () => stopped, hasRecovery: () => Boolean(workspaces.getActive()) }
}

module.exports = { createBackendSession }
