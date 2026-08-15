const fs = require('node:fs')
const path = require('node:path')
const { dialog } = require('electron')

const { buildSettings, loadSettings, saveSettings } = require('../state/settings')

function createEngineIpcController({
  ipcMain,
  appOptions,
  projectRoot,
  environmentGateway,
  getMainWindow,
}) {
  function saveLoadedProfileState(profileId, loaded) {
    const settings = loadSettings(appOptions)
    const loadedProfileIds = new Set(settings.engines.loadedProfileIds || [])
    if (loaded) loadedProfileIds.add(profileId)
    else loadedProfileIds.delete(profileId)
    settings.engines.loadedProfileIds = [...loadedProfileIds]
    saveSettings(settings, appOptions)
    return settings
  }

  async function restoreLoadedProfiles() {
    const settings = loadSettings(appOptions)
    for (const profileId of settings.engines.loadedProfileIds || []) {
      try {
        await environmentGateway.reloadEngine(profileId)
      } catch (error) {
        console.error(`[engine] failed to restore ${profileId}:`, error)
      }
    }
  }

  function register() {
    ipcMain.handle('engine:describe', async (event, profile) => {
      const enginePath = String(profile?.enginePath || '')
      const request = {
        ...(profile || {}),
        engineCommand: Array.isArray(profile?.engineCommand) && profile.engineCommand.length
          ? profile.engineCommand.map(String)
          : (enginePath ? [enginePath] : []),
        engineCwd: String(profile?.engineCwd || '') || (enginePath ? path.dirname(enginePath) : ''),
      }
      const response = await environmentGateway.describeEngine(request)
      return response.description
    })

    ipcMain.handle('engine:choose-file', async () => {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: '选择引擎文件',
        properties: ['openFile'],
        filters: [
          { name: '引擎', extensions: ['exe', 'py'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      return result.canceled ? '' : String(result.filePaths[0] || '')
    })

    ipcMain.handle('engine:choose-weight', async () => {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: '选择权重文件',
        properties: ['openFile'],
        filters: [
          { name: '模型权重', extensions: ['pth', 'pt', 'onnx', 'bin'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      return result.canceled ? '' : String(result.filePaths[0] || '')
    })

    ipcMain.handle('engine:activate', async (event, payload) => {
      const profileId = String(payload?.profileId || '')
      if (!profileId) throw new Error('没有选择要加载的引擎')
      const previous = loadSettings(appOptions)
      const engines = JSON.parse(JSON.stringify(payload?.engines || previous.engines))
      const profiles = engines.profiles
      const profile = Array.isArray(profiles)
        ? profiles.find((item) => item?.id === profileId)
        : null
      if (!profile) throw new Error('找不到要加载的引擎配置')
      const enginePath = path.isAbsolute(profile.enginePath || '')
        ? profile.enginePath
        : path.resolve(projectRoot, profile.enginePath || '')
      if (!enginePath || !fs.existsSync(enginePath)) {
        throw new Error('引擎文件不存在')
      }
      for (const weight of profile.weights || []) {
        const weightPath = path.isAbsolute(weight.path || '')
          ? weight.path
          : path.resolve(projectRoot, weight.path || '')
        if (!weightPath || !fs.existsSync(weightPath)) {
          throw new Error(`权重文件不存在：${weight.slotId || '未命名槽位'}`)
        }
      }
      const assignedOutputs = Object.entries(engines.outputAssignments || {})
        .filter(([, assignedProfileId]) => assignedProfileId === profileId)
        .map(([outputId]) => outputId)
      if (!assignedOutputs.length) throw new Error('尚未给这个引擎分配输出')
      saveSettings({ ...previous, engines }, appOptions)
      const response = await environmentGateway.reloadEngine(profileId)
      if (assignedOutputs.includes('action-recommendation')) {
        if (response?.reload?.errors?.decision) {
          throw new Error(String(response.reload.errors.decision))
        }
        if (!response?.reload?.warmed?.teachingAnalysis) {
          throw new Error('动作推荐未能完成加载')
        }
      }
      if (assignedOutputs.some((outputId) => outputId !== 'action-recommendation')) {
        if (response?.reload?.errors?.['opponent-analysis']) {
          throw new Error(String(response.reload.errors['opponent-analysis']))
        }
        if (!response?.reload?.warmed?.opponentAnalysis) {
          throw new Error('对手预测未能完成加载')
        }
      }
      return buildSettings(saveLoadedProfileState(profileId, true), appOptions)
    })

    ipcMain.handle('engine:unload', async (event, payload) => {
      const profileId = String(payload?.profileId || '')
      const engines = loadSettings(appOptions).engines
      const assignedOutputs = Object.entries(engines.outputAssignments || {})
        .filter(([, assignedProfileId]) => assignedProfileId === profileId)
        .map(([outputId]) => outputId)
      let state = null
      if (assignedOutputs.includes('action-recommendation')) {
        state = (await environmentGateway.unloadEngine('decision', profileId)).state
      }
      if (assignedOutputs.some((outputId) => outputId !== 'action-recommendation')) {
        state = (await environmentGateway.unloadEngine('opponent-analysis', profileId)).state
      }
      const settings = saveLoadedProfileState(profileId, false)
      return {
        state,
        settings: buildSettings(settings, appOptions),
      }
    })
  }

  return { register, restoreLoadedProfiles }
}

module.exports = { createEngineIpcController }
