const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('trainerAPI', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  describeEngine: (profile) => ipcRenderer.invoke('engine:describe', profile),
  chooseEngineFile: () => ipcRenderer.invoke('engine:choose-file'),
  chooseEngineWeight: () => ipcRenderer.invoke('engine:choose-weight'),
  activateEngine: (payload) => ipcRenderer.invoke('engine:activate', payload),
  unloadEngine: (payload) => ipcRenderer.invoke('engine:unload', payload),
  getStatus: () => ipcRenderer.invoke('status:get'),
  getRecordDirty: () => ipcRenderer.invoke('record:dirty-get'),
  getGameView: () => ipcRenderer.invoke('game:view'),
  createGame: () => ipcRenderer.invoke('game:create'),
  closeGame: () => ipcRenderer.invoke('game:close'),
  advanceGame: () => ipcRenderer.invoke('game:advance'),
  confirmPendingReview: () => ipcRenderer.invoke('game:confirm-review'),
  submitUserAction: (action) => ipcRenderer.invoke('game:submit-action', action),
  jumpToNode: (nodeId, treeRevision) => ipcRenderer.invoke('game:jump-to-node', nodeId, treeRevision),
  setMainBranch: (nodeId) => ipcRenderer.invoke('game:set-main-branch', nodeId),
  setNodeComment: (nodeId, comment) => ipcRenderer.invoke('game:set-node-comment', nodeId, comment),
  deleteNode: (nodeId) => ipcRenderer.invoke('game:delete-node', nodeId),
  saveGame: () => ipcRenderer.invoke('game:save'),
  saveGameAs: () => ipcRenderer.invoke('game:save-as'),
  openGame: () => ipcRenderer.invoke('game:open'),
  showRecordInFolder: () => ipcRenderer.invoke('record:show-in-folder'),
  restoreStartupRecovery: () => ipcRenderer.invoke('game:restore-startup-recovery'),
  importMortalReport: (payload) => ipcRenderer.invoke('game:import-mortal-report', payload),
  importCustomTenhou: (payload) => ipcRenderer.invoke('game:import-custom-tenhou', payload),
  exportCustomTenhou: () => ipcRenderer.invoke('game:export-custom-tenhou'),
  setMode: (mode) => ipcRenderer.invoke('mode:set', mode),
  requestSeatSwitch: (seat) => ipcRenderer.invoke('seatSwitch:request', seat),
  toggleVisibleHands: () => ipcRenderer.invoke('visibleHands:toggle'),
  setAnalysisVisibility: (visibility) => ipcRenderer.invoke('analysis:visibility', visibility),
  restartBackend: () => ipcRenderer.invoke('backend:restart'),
  getWallView: () => ipcRenderer.invoke('game:wall-view'),
  reconstructWalls: (seed) => ipcRenderer.invoke('game:reconstruct-walls', seed),
  importWall: (tiles) => ipcRenderer.invoke('game:import-wall', tiles),
  getLatestMjaiDebug: () => ipcRenderer.invoke('debug:latest-mjai'),
  getShanten: () => ipcRenderer.invoke('game:shanten'),
  getShantenMjai: () => ipcRenderer.invoke('debug:shanten-mjai'),
  clearAnalysisCaches: () => ipcRenderer.invoke('debug:clear-analysis-caches'),
  startAutoAnalysis: () => ipcRenderer.invoke('analysis:auto-start'),
  cancelAutoAnalysis: () => ipcRenderer.invoke('analysis:auto-cancel'),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
  openAppLegalDocument: (documentId) => ipcRenderer.invoke('legal:open-app-document', documentId),
  openEngineLegalDocument: (payload) => ipcRenderer.invoke('legal:open-engine-document', payload),
  onUiZoomShortcut: (callback) => {
    const handler = (_event, direction) => callback(direction)
    ipcRenderer.on('ui:zoom-shortcut', handler)
    return () => ipcRenderer.removeListener('ui:zoom-shortcut', handler)
  },
  onPythonEvent: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('python:event', handler)
    return () => ipcRenderer.removeListener('python:event', handler)
  },
  onRecordDirtyChanged: (callback) => {
    const handler = (_event, dirty) => callback(Boolean(dirty))
    ipcRenderer.on('record:dirty-changed', handler)
    return () => ipcRenderer.removeListener('record:dirty-changed', handler)
  },
  onBeforeClose: (callback) => {
    const handler = async (_event, token) => {
      let errorMessage = ''
      try {
        await callback()
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error)
      }
      ipcRenderer.send('record:close-ready', token, errorMessage)
    }
    ipcRenderer.on('record:before-close', handler)
    return () => ipcRenderer.removeListener('record:before-close', handler)
  },
})
