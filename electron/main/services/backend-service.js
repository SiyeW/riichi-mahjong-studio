const fs = require('node:fs')
const path = require('node:path')
const { createBackendProcess } = require('./backend-process')
const { createBackendSession } = require('./backend-session')
const { migrateSettings } = require('../state/settings')

function resolveDevelopmentPython(resourceRoot, env = process.env) {
  const explicit = String(env.RMS_BACKEND_PYTHON || env.MJAI_BACKEND_PYTHON || '').trim()
  if (explicit) return explicit

  const localPython = process.platform === 'win32'
    ? path.join(resourceRoot, '.conda-backend', 'python.exe')
    : path.join(resourceRoot, '.conda-backend', 'bin', 'python')
  if (fs.existsSync(localPython)) return localPython

  return 'python'
}

function resolveAppVersion(options = {}) {
  return String(options.appVersion || '').trim() || '0.0.0-dev'
}

function resolveBundledBackend(resourceDir) {
  const exeName = process.platform === 'win32' ? 'rms-backend.exe' : 'rms-backend'
  const exePath = path.join(resourceDir, 'backend', 'rms-backend', exeName)
  return exePath
}

function createBackendService(options = {}) {
  // Persist schema migrations before Python reads config.json for prewarming.
  const settings = migrateSettings(options)
  const resourceRoot = options.resourceDir || options.appDir || process.cwd()
  const bundledBackend = resolveBundledBackend(resourceRoot)
  const useBundledBackend = Boolean(options.isPackaged)

  const backendProcess = createBackendProcess({
    name: 'backend',
    pythonExecutable: useBundledBackend
      ? bundledBackend
      : resolveDevelopmentPython(resourceRoot, options.env),
    scriptPath: null,
    args: useBundledBackend ? [] : ['-m', 'rms_backend'],
    cwd: useBundledBackend ? path.dirname(bundledBackend) : path.join(resourceRoot, 'python'),
    formatStartError: (name, message) => options.t
      ? options.t('native.backend.startFailed', { name, message })
      : `${name} failed to start: ${message}`,
    env: {
      RMS_PORTABLE_DIR: options.portableDir || process.cwd(),
      RMS_APP_VERSION: resolveAppVersion(options),
    },
  })

  const backendSession = createBackendSession(backendProcess)
  let onEvent = null
  backendProcess.onEvent(event => {
    backendSession.handleEvent(event)
    onEvent?.(event.type === 'service_stopped'
      ? { ...event, hasCheckpoint: backendSession.hasCheckpoint() } : event)
  })
  return {
    backendProcess: { onEvent(callback) { onEvent = callback } },
    backendGateway: {
      getStatus() {
        return backendSession.sendRequest('get_status', {}, 30_000)
      },
      getRuntimeMetrics() {
        return backendSession.sendRequest('get_runtime_metrics', {}, 5_000)
      },
      getGameView() {
        return backendSession.sendRequest('get_game_view')
      },
      exportGameRecord() {
        return backendSession.sendRequest('export_game_record')
      },
      describeEngine(profile) {
        return backendSession.sendRequest('describe_engine', profile, 30_000)
      },
      reloadEngine(profileId) {
        return backendSession.sendRequest('reload_engines', { profileId }, 180_000)
      },
      unloadEngine(kind, profileId) {
        return backendSession.sendRequest('unload_engine', { kind, profileId }, 30_000)
      },
      importGameRecord(record) {
        return backendSession.sendRequest('import_game_record', { record })
      },
      importMortalReport(report, sourceUrl, options = {}) {
        return backendSession.sendRequest('import_mortal_report', {
          report,
          sourceUrl,
          sourceImportUrl: options.sourceImportUrl,
          reconstructWalls: Boolean(options.reconstructWalls),
          seed: options.seed,
        }, 120_000)
      },
      importCustomTenhou(input, options = {}) {
        return backendSession.sendRequest('import_custom_tenhou', {
          input,
          reconstructWalls: Boolean(options.reconstructWalls),
          seed: options.seed,
        }, 120_000)
      },
      exportCustomTenhou() {
        return backendSession.sendRequest('export_custom_tenhou')
      },
      createGame() {
        return backendSession.sendRequest('create_game')
      },
      closeGame() {
        return backendSession.sendRequest('close_game')
      },
      advanceGame() {
        return backendSession.sendRequest('advance_game')
      },
      confirmPendingReview() {
        return backendSession.sendRequest('confirm_pending_review')
      },
      setMode(mode) {
        return backendSession.sendRequest('set_mode', { mode })
      },
      requestSeatSwitch(seat) {
        return backendSession.sendRequest('request_seat_switch', { seat })
      },
      toggleVisibleHands() {
        return backendSession.sendRequest('toggle_visible_hands')
      },
      setAnalysisVisibility(visibility) {
        return backendSession.sendRequest('set_analysis_visibility', visibility)
      },
      submitUserAction(action) {
        return backendSession.sendRequest('submit_user_action', action)
      },
      jumpToNode(nodeId, treeRevision) {
        return backendSession.sendRequest('jump_to_node', { nodeId, treeRevision })
      },
      setMainBranch(nodeId) {
        return backendSession.sendRequest('set_main_branch', { nodeId })
      },
      setNodeComment(nodeId, comment) {
        return backendSession.sendRequest('set_node_comment', { nodeId, comment })
      },
      deleteNode(nodeId) {
        return backendSession.sendRequest('delete_node', { nodeId })
      },
      restartBackend() {
        return backendSession.restart()
      },
      needsRecovery() {
        return backendSession.needsRecovery()
      },
      getWallView() {
        return backendSession.sendRequest('get_wall_view')
      },
      reconstructWalls(seed) {
        return backendSession.sendRequest('reconstruct_walls', { seed }, 120_000)
      },
      importWall(tiles) {
        return backendSession.sendRequest('import_wall', { tiles })
      },
      getLatestMjaiDebug() {
        return backendSession.sendRequest('get_latest_mjai_debug')
      },
      getAnalysis() {
        return backendSession.sendRequest('get_analysis')
      },
      getAnalysisDebug() {
        return backendSession.sendRequest('get_analysis_debug')
      },
      clearAnalysisCaches() {
        return backendSession.sendRequest('clear_analysis_caches')
      },
      startAutoAnalysis() {
        return backendSession.sendRequest('start_auto_analysis')
      },
      cancelAutoAnalysis() {
        return backendSession.sendRequest('cancel_auto_analysis')
      },
    },
    startAll() {
      backendProcess.start()
    },
    stopAll() {
      backendProcess.stop()
    },
  }
}

module.exports = { createBackendService, resolveAppVersion, resolveDevelopmentPython }
