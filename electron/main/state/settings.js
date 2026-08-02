const fs = require('node:fs')
const path = require('node:path')
const {
  getSelectedOpponentAnalysisProfile,
  normalizeEngineSettings,
} = require('./engine-registry')
const {
  discoverEnginePackages,
  publicEngineCatalog,
} = require('./engine-package-registry')

const DEFAULT_WINDOW_SETTINGS = Object.freeze({ width: 1440, height: 920 })
const DEFAULT_TRAINING_SETTINGS = Object.freeze({
  mode: 'threshold_review',
  mistakeThreshold: 0.25,
  thinkingTimeMinS: 0.25,
  thinkingTimeMaxS: 1,
})
const DEFAULT_MODE_SETTINGS = Object.freeze({ autoAdvanceDelayMs: 250 })
const DEFAULT_DISPLAY_SETTINGS = Object.freeze({
  colorScheme: 'default',
  reduceMotion: false,
  uiScale: 1,
  showTsumogiriInPlay: true,
})
const DEFAULT_RECORD_SETTINGS = Object.freeze({ saveRecoveryOnExit: true })
const DEFAULT_AUDIO_SETTINGS = Object.freeze({ volume: 50, voice: 'female' })

function normalizeTrainingMode(mode) {
  return {
    no_review: 'no_review',
    free_play: 'preview_before_click',
    guided: 'threshold_review',
    strict: 'always_review',
  }[String(mode || '')] || String(mode || 'threshold_review')
}

function normalizeModeDefaults(modeDefaults = {}) {
  const normalized = { ...modeDefaults }
  for (const key of (
    'analysisEnabledInResearch showAllAnalysis highlightMistakes autoAdvance autosaveEnabled'
  ).split(' ')) {
    delete normalized[key]
  }
  return normalized
}

function normalizeTrainingSettings(training = {}) {
  const normalized = { ...training }
  delete normalized.discardPaceMs
  return normalized
}

function normalizeDisplaySettings(display = {}) {
  return {
    ...display,
    colorScheme: display.colorScheme === 'killerducky' ? 'killerducky' : 'default',
  }
}

function getDefaultSettings(options = {}, engineCatalog = discoverEnginePackages(options)) {
  const engines = normalizeEngineSettings(null, null, engineCatalog)
  return {
    window: {
      ...DEFAULT_WINDOW_SETTINGS,
    },
    training: {
      ...DEFAULT_TRAINING_SETTINGS,
    },
    modeDefaults: {
      ...DEFAULT_MODE_SETTINGS,
    },
    display: {
      ...DEFAULT_DISPLAY_SETTINGS,
    },
    records: {
      ...DEFAULT_RECORD_SETTINGS,
    },
    audio: {
      ...DEFAULT_AUDIO_SETTINGS,
    },
    engines,
  }
}

function buildPortableDefaultSettings() {
  const emptyCatalog = {
    schemaVersion: 1,
    engines: [],
    models: [],
    diagnostics: [],
  }
  const defaults = getDefaultSettings({}, emptyCatalog)
  const portableProfile = (profile, kind) => ({
    id: profile.id,
    name: profile.name,
    enginePath: profile.enginePath,
    engineId: profile.engineId,
    modelPath: profile.modelPath,
    modelId: profile.modelId,
    ...(kind === 'decision'
      ? { options: { ...profile.options, temperature: profile.options?.temperature ?? 1 } }
      : { inputModes: [...(profile.inputModes || ['public'])], options: { ...profile.options } }),
  })
  return {
    ...defaults,
    engines: {
      schemaVersion: defaults.engines.schemaVersion,
      selectedDecisionProfileId: defaults.engines.selectedDecisionProfileId,
      selectedOpponentAnalysisProfileId: defaults.engines.selectedOpponentAnalysisProfileId,
      decisionProfiles: defaults.engines.decisionProfiles.map(
        (profile) => portableProfile(profile, 'decision'),
      ),
      opponentAnalysisProfiles: defaults.engines.opponentAnalysisProfiles.map(
        (profile) => portableProfile(profile, 'opponent-analysis'),
      ),
    },
  }
}

function getSettingsPath(options = {}) {
  const portableRoot = options.portableDir || options.appDir || process.cwd()
  const projectPath = path.join(portableRoot, 'config.json')
  const envPath = options.env?.MJAI_TRAINER_CONFIG
  return envPath || projectPath
}

function loadSettings(options = {}) {
  const filePath = getSettingsPath(options)
  const engineCatalog = discoverEnginePackages(options)
  const defaults = getDefaultSettings(options, engineCatalog)

  if (!fs.existsSync(filePath)) {
    return defaults
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const engines = normalizeEngineSettings(parsed.engines, parsed.models, engineCatalog)
    const {
      models: _legacyModels,
      python: _legacyPython,
      ...supportedSettings
    } = parsed
    return {
      ...defaults,
      ...supportedSettings,
      window: {
        ...defaults.window,
        ...(parsed.window || {}),
      },
      training: {
        ...defaults.training,
        ...normalizeTrainingSettings(parsed.training),
        mode: normalizeTrainingMode(parsed.training?.mode || defaults.training.mode),
      },
      modeDefaults: {
        ...defaults.modeDefaults,
        ...normalizeModeDefaults(parsed.modeDefaults),
      },
      display: {
        ...defaults.display,
        ...normalizeDisplaySettings(parsed.display),
      },
      records: {
        ...defaults.records,
        ...(parsed.records || {}),
      },
      audio: {
        ...defaults.audio,
        ...(parsed.audio || {}),
      },
      engines,
    }
  } catch (error) {
    console.warn(`Failed to load settings from ${filePath}: ${error.message}`)
    return defaults
  }
}

function migrateSettings(options = {}) {
  const filePath = getSettingsPath(options)
  if (!fs.existsSync(filePath)) return loadSettings(options)

  try {
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const normalized = loadSettings(options)
    if (JSON.stringify(stored) !== JSON.stringify(normalized)) {
      saveSettings(normalized, options)
    }
    return normalized
  } catch {
    // Keep a malformed file intact so the user can recover it manually.
    return loadSettings(options)
  }
}

function saveSettings(settings, options = {}) {
  const legacyModels = settings?.models
  if (settings && typeof settings === 'object') {
    delete settings.configPath
    delete settings.runtime
    delete settings.python
    delete settings.models
  }
  if (settings?.training) {
    settings.training = normalizeTrainingSettings(settings.training)
    settings.training.mode = normalizeTrainingMode(settings.training.mode)
  }
  if (settings?.modeDefaults) {
    settings.modeDefaults = normalizeModeDefaults(settings.modeDefaults)
  }
  if (settings?.display) {
    settings.display = normalizeDisplaySettings(settings.display)
  }
  const engineCatalog = discoverEnginePackages(options)
  settings.engines = normalizeEngineSettings(settings.engines, legacyModels, engineCatalog)
  const filePath = getSettingsPath(options)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8')
  return filePath
}

function buildSettings(settings, options = {}) {
  const engineCatalog = discoverEnginePackages(options)
  const opponentAnalysisProfile = getSelectedOpponentAnalysisProfile(settings.engines)
  return {
    ...settings,
    configPath: getSettingsPath(options),
    runtime: {
      releaseMode: Boolean(options.isPackaged),
      builtInRuntimeLabel: '',
      builtInModelLabel: '',
      opponentAnalysisInputModes: opponentAnalysisProfile?.inputModes || ['public'],
      engineCatalog: publicEngineCatalog(engineCatalog),
    },
  }
}

module.exports = {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_DISPLAY_SETTINGS,
  DEFAULT_MODE_SETTINGS,
  DEFAULT_RECORD_SETTINGS,
  DEFAULT_TRAINING_SETTINGS,
  DEFAULT_WINDOW_SETTINGS,
  buildPortableDefaultSettings,
  buildSettings,
  getDefaultSettings,
  loadSettings,
  migrateSettings,
  saveSettings,
}
