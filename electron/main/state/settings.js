const fs = require('node:fs')
const path = require('node:path')
const { normalizeEngineSettings } = require('./engine-registry')
const {
  discoverEnginePackages,
  publicEngineCatalog,
} = require('./engine-package-registry')
const {
  discoverSoundPacks,
  publicSoundPackCatalog,
} = require('./sound-pack-registry')

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
const DEFAULT_AUDIO_SETTINGS = Object.freeze({ volume: 50, soundPackId: '' })

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

function normalizeAudioSettings(audio = {}, soundPackCatalog = { packs: [] }) {
  const numericVolume = Number(audio.volume)
  const requestedPackId = String(audio.soundPackId || '')
  return {
    volume: Number.isFinite(numericVolume)
      ? Math.max(0, Math.min(100, numericVolume))
      : DEFAULT_AUDIO_SETTINGS.volume,
    soundPackId: soundPackCatalog.packs.some((pack) => pack.id === requestedPackId)
      ? requestedPackId
      : '',
  }
}

function getDefaultSettings(
  options = {},
  engineCatalog = discoverEnginePackages(options),
  soundPackCatalog = discoverSoundPacks(options),
) {
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
    audio: normalizeAudioSettings(DEFAULT_AUDIO_SETTINGS, soundPackCatalog),
    engines,
  }
}

function buildPortableDefaultSettings() {
  const emptyCatalog = {
    schemaVersion: 2,
    engines: [],
    diagnostics: [],
  }
  const emptySoundPackCatalog = { schemaVersion: 1, packs: [], diagnostics: [] }
  const defaults = getDefaultSettings({}, emptyCatalog, emptySoundPackCatalog)
  const portableProfile = (profile) => ({
    id: profile.id,
    name: profile.name,
    builtIn: Boolean(profile.builtIn),
    autoName: profile.autoName !== false,
    enginePath: profile.enginePath,
    engineId: profile.engineId,
    engineVersion: profile.engineVersion,
    weights: (profile.weights || []).map((weight) => ({ ...weight })),
    device: profile.device || '',
    options: { ...profile.options },
  })
  return {
    ...defaults,
    engines: {
      schemaVersion: defaults.engines.schemaVersion,
      profiles: defaults.engines.profiles.map(portableProfile),
      outputAssignments: { ...defaults.engines.outputAssignments },
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
  const soundPackCatalog = discoverSoundPacks(options)
  const defaults = getDefaultSettings(options, engineCatalog, soundPackCatalog)

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
      audio: normalizeAudioSettings(parsed.audio, soundPackCatalog),
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
  const soundPackCatalog = discoverSoundPacks(options)
  settings.engines = normalizeEngineSettings(settings.engines, legacyModels, engineCatalog)
  settings.audio = normalizeAudioSettings(settings.audio, soundPackCatalog)
  const filePath = getSettingsPath(options)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8')
  return filePath
}

function buildSettings(settings, options = {}) {
  const engineCatalog = discoverEnginePackages(options)
  const soundPackCatalog = discoverSoundPacks(options)
  return {
    ...settings,
    configPath: getSettingsPath(options),
    runtime: {
      releaseMode: Boolean(options.isPackaged),
      builtInRuntimeLabel: '',
      builtInModelLabel: '',
      opponentAnalysisInputModes: ['public'],
      engineCatalog: publicEngineCatalog(engineCatalog),
      soundPackCatalog: publicSoundPackCatalog(soundPackCatalog),
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
  normalizeAudioSettings,
  saveSettings,
}
