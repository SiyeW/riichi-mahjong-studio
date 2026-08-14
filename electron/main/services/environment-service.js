const fs = require('node:fs')
const path = require('node:path')
const { createBackendProcess } = require('./backend-process')
const { migrateSettings } = require('../state/settings')

function resolveDevelopmentPython(resourceRoot, env = process.env) {
  const explicit = String(env.MJAI_BACKEND_PYTHON || '').trim()
  if (explicit) return explicit

  const localPython = process.platform === 'win32'
    ? path.join(resourceRoot, '.conda-backend', 'python.exe')
    : path.join(resourceRoot, '.conda-backend', 'bin', 'python')
  if (fs.existsSync(localPython)) return localPython

  return 'python'
}

function resolveBundledBackend(resourceDir) {
  const exeName = process.platform === 'win32' ? 'environment-service.exe' : 'environment-service'
  const exePath = path.join(resourceDir, 'backend', 'environment-service', exeName)
  return exePath
}

function createEnvironmentService(options = {}) {
  // Persist schema migrations before Python reads config.json for prewarming.
  const settings = migrateSettings(options)
  const resourceRoot = options.resourceDir || options.appDir || process.cwd()
  const bundledBackend = resolveBundledBackend(resourceRoot)
  const useBundledBackend = Boolean(options.isPackaged)

  const environmentService = createBackendProcess({
    name: 'environment',
    pythonExecutable: useBundledBackend
      ? bundledBackend
      : resolveDevelopmentPython(resourceRoot, options.env),
    scriptPath: useBundledBackend ? null : path.join(resourceRoot, 'python', 'environment', 'service.py'),
    cwd: useBundledBackend ? path.dirname(bundledBackend) : path.join(resourceRoot, 'python', 'environment'),
    env: {
      MJAI_TRAINER_PORTABLE_DIR: options.portableDir || process.cwd(),
    },
  })

  return {
    backendProcess: environmentService,
    environmentGateway: {
      getStatus() {
        return environmentService.sendRequest('get_status', {}, 30_000)
      },
      getRuntimeMetrics() {
        return environmentService.sendRequest('get_runtime_metrics', {}, 5_000)
      },
      getGameView() {
        return environmentService.sendRequest('get_game_view')
      },
      exportGameRecord() {
        return environmentService.sendRequest('export_game_record')
      },
      describeEngine(profile) {
        return environmentService.sendRequest('describe_engine', profile, 30_000)
      },
      reloadEngine(profileId) {
        return environmentService.sendRequest('reload_engines', { profileId }, 180_000)
      },
      unloadEngine(kind, profileId) {
        return environmentService.sendRequest('unload_engine', { kind, profileId }, 30_000)
      },
      importGameRecord(record) {
        return environmentService.sendRequest('import_game_record', { record })
      },
      importMortalReport(report, sourceUrl, options = {}) {
        return environmentService.sendRequest('import_mortal_report', {
          report,
          sourceUrl,
          sourceImportUrl: options.sourceImportUrl,
          reconstructWalls: Boolean(options.reconstructWalls),
          seed: options.seed,
        }, 120_000)
      },
      importCustomTenhou(input, options = {}) {
        return environmentService.sendRequest('import_custom_tenhou', {
          input,
          reconstructWalls: Boolean(options.reconstructWalls),
          seed: options.seed,
        }, 120_000)
      },
      exportCustomTenhou() {
        return environmentService.sendRequest('export_custom_tenhou')
      },
      createGame() {
        return environmentService.sendRequest('create_game')
      },
      closeGame() {
        return environmentService.sendRequest('close_game')
      },
      advanceGame() {
        return environmentService.sendRequest('advance_game')
      },
      confirmPendingReview() {
        return environmentService.sendRequest('confirm_pending_review')
      },
      setMode(mode) {
        return environmentService.sendRequest('set_mode', { mode })
      },
      requestSeatSwitch(seat) {
        return environmentService.sendRequest('request_seat_switch', { seat })
      },
      toggleVisibleHands() {
        return environmentService.sendRequest('toggle_visible_hands')
      },
      setAnalysisVisibility(visibility) {
        return environmentService.sendRequest('set_analysis_visibility', visibility)
      },
      submitUserAction(action) {
        return environmentService.sendRequest('submit_user_action', action)
      },
      jumpToNode(nodeId, treeRevision) {
        return environmentService.sendRequest('jump_to_node', { nodeId, treeRevision })
      },
      setMainBranch(nodeId) {
        return environmentService.sendRequest('set_main_branch', { nodeId })
      },
      setNodeComment(nodeId, comment) {
        return environmentService.sendRequest('set_node_comment', { nodeId, comment })
      },
      deleteNode(nodeId) {
        return environmentService.sendRequest('delete_node', { nodeId })
      },
      restartBackend() {
        environmentService.restart()
        return { ok: true }
      },
      getWallView() {
        return environmentService.sendRequest('get_wall_view')
      },
      reconstructWalls(seed) {
        return environmentService.sendRequest('reconstruct_walls', { seed }, 120_000)
      },
      importWall(tiles) {
        return environmentService.sendRequest('import_wall', { tiles })
      },
      getLatestMjaiDebug() {
        return environmentService.sendRequest('get_latest_mjai_debug')
      },
      getShanten() {
        return environmentService.sendRequest('get_shanten')
      },
      getShantenMjai() {
        return environmentService.sendRequest('get_shanten_mjai')
      },
      clearAnalysisCaches() {
        return environmentService.sendRequest('clear_analysis_caches')
      },
      startAutoAnalysis() {
        return environmentService.sendRequest('start_auto_analysis')
      },
      cancelAutoAnalysis() {
        return environmentService.sendRequest('cancel_auto_analysis')
      },
    },
    startAll() {
      environmentService.start()
    },
    stopAll() {
      environmentService.stop()
    },
  }
}

module.exports = { createEnvironmentService, resolveDevelopmentPython }
