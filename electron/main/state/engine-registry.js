const ENGINE_SETTINGS_SCHEMA_VERSION = 1

// The public application intentionally ships without engine or model profiles.
const BUILT_IN_DECISION_PROFILES = Object.freeze([])
const BUILT_IN_OPPONENT_ANALYSIS_PROFILES = Object.freeze([])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeTemperature(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 1
}

function catalogMaps(catalog = {}) {
  return {
    engines: new Map((catalog.engines || []).map((engine) => [engine.id, engine])),
    models: new Map((catalog.models || []).map((model) => [model.id, model])),
  }
}

function normalizeProfile(source, kind, catalog) {
  const profile = isObject(source) ? source : {}
  const maps = catalogMaps(catalog)
  const engine = maps.engines.get(String(profile.engineId || ''))
  const model = maps.models.get(String(profile.modelId || ''))
  const entrypoint = engine?.manifest?.entrypoints
    ? Object.values(engine.manifest.entrypoints)[0]
    : null
  const engineCommand = engine?.executablePath
    ? [engine.executablePath, ...((entrypoint?.arguments || []).map(String))]
    : (Array.isArray(profile.engineCommand) ? profile.engineCommand.map(String) : [])
  const available = Boolean(engine?.launchAvailable && model?.compatible !== false)

  return {
    id: String(profile.id || ''),
    name: String(profile.name ?? ''),
    enginePath: String(engine?.executablePath || profile.enginePath || ''),
    engineCommand,
    engineCwd: String(engine?.packageRoot || profile.engineCwd || ''),
    engineId: String(engine?.id || profile.engineId || ''),
    engineVersion: String(engine?.version || profile.engineVersion || ''),
    modelPath: String(model?.runtimePath || profile.modelPath || ''),
    modelId: String(model?.id || profile.modelId || ''),
    modelFormat: String(model?.metadata?.format || profile.modelFormat || ''),
    modelSha256: String(model?.metadata?.sha256 || profile.modelSha256 || ''),
    available,
    unavailableReason: available ? '' : '引擎或模型包未安装',
    ...(kind === 'decision'
      ? {
          options: {
            ...(isObject(profile.options) ? profile.options : {}),
            temperature: normalizeTemperature(profile.options?.temperature),
          },
        }
      : {
          inputModes: Array.isArray(profile.inputModes) && profile.inputModes.includes('public')
            ? [...new Set(profile.inputModes.map(String))]
            : ['public'],
          options: isObject(profile.options) ? { ...profile.options } : {},
        }),
  }
}

function normalizeProfiles(profiles, kind, catalog) {
  if (!Array.isArray(profiles)) return []
  const ids = new Set()
  return profiles
    .map((profile) => normalizeProfile(profile, kind, catalog))
    .filter((profile) => {
      if (!profile.id || ids.has(profile.id)) return false
      ids.add(profile.id)
      return true
    })
}

function selectedProfileId(profiles, requestedId) {
  const requested = String(requestedId || '')
  if (profiles.some((profile) => profile.id === requested)) return requested
  return profiles.find((profile) => profile.available)?.id || profiles[0]?.id || ''
}

function normalizeEngineSettings(source = {}, _legacyModels = null, catalog = {}) {
  const settings = isObject(source) ? source : {}
  const decisionProfiles = normalizeProfiles(settings.decisionProfiles, 'decision', catalog)
  const opponentAnalysisProfiles = normalizeProfiles(
    settings.opponentAnalysisProfiles,
    'opponent-analysis',
    catalog,
  )
  return {
    schemaVersion: ENGINE_SETTINGS_SCHEMA_VERSION,
    decisionProfiles,
    opponentAnalysisProfiles,
    selectedDecisionProfileId: selectedProfileId(
      decisionProfiles,
      settings.selectedDecisionProfileId,
    ),
    selectedOpponentAnalysisProfileId: selectedProfileId(
      opponentAnalysisProfiles,
      settings.selectedOpponentAnalysisProfileId,
    ),
  }
}

function resolveSelectedProfile(profiles, selectedId) {
  return profiles.find((profile) => profile.id === selectedId) || null
}

function buildLegacyModels(engineSettings) {
  const decision = resolveSelectedProfile(
    engineSettings.decisionProfiles,
    engineSettings.selectedDecisionProfileId,
  )
  const opponentAnalysis = resolveSelectedProfile(
    engineSettings.opponentAnalysisProfiles,
    engineSettings.selectedOpponentAnalysisProfileId,
  )
  const decisionModel = {
    engine: String(decision?.engineId || ''),
    profileId: String(decision?.id || ''),
    engineId: String(decision?.engineId || ''),
    engineVersion: String(decision?.engineVersion || ''),
    enginePath: String(decision?.enginePath || ''),
    engineCommand: Array.isArray(decision?.engineCommand) ? [...decision.engineCommand] : [],
    engineCwd: String(decision?.engineCwd || ''),
    engineOptions: { ...(decision?.options || {}) },
    modelPath: String(decision?.modelPath || ''),
    modelId: String(decision?.modelId || ''),
    modelFormat: String(decision?.modelFormat || ''),
    modelSha256: String(decision?.modelSha256 || ''),
    temperature: normalizeTemperature(decision?.options?.temperature),
  }
  return {
    teachingModel: { ...decisionModel },
    opponentModel: { ...decisionModel },
    opponentAnalysis: {
      profileId: String(opponentAnalysis?.id || ''),
      engineId: String(opponentAnalysis?.engineId || ''),
      engineVersion: String(opponentAnalysis?.engineVersion || ''),
      enginePath: String(opponentAnalysis?.enginePath || ''),
      engineCommand: Array.isArray(opponentAnalysis?.engineCommand)
        ? [...opponentAnalysis.engineCommand]
        : [],
      engineCwd: String(opponentAnalysis?.engineCwd || ''),
      engineOptions: { ...(opponentAnalysis?.options || {}) },
      modelPath: String(opponentAnalysis?.modelPath || ''),
      modelId: String(opponentAnalysis?.modelId || ''),
      modelFormat: String(opponentAnalysis?.modelFormat || ''),
      modelSha256: String(opponentAnalysis?.modelSha256 || ''),
      inputModes: [...(opponentAnalysis?.inputModes || ['public'])],
    },
  }
}

function getSelectedOpponentAnalysisProfile(engineSettings) {
  return resolveSelectedProfile(
    engineSettings.opponentAnalysisProfiles,
    engineSettings.selectedOpponentAnalysisProfileId,
  )
}

function buildBuiltInProfiles() {
  return { decisionProfiles: [], opponentAnalysisProfiles: [] }
}

function migrateLegacyProfiles(source, _legacyModels, catalog) {
  return normalizeEngineSettings(source, null, catalog)
}

module.exports = {
  BUILT_IN_DECISION_PROFILES,
  BUILT_IN_OPPONENT_ANALYSIS_PROFILES,
  buildBuiltInProfiles,
  buildLegacyModels,
  getSelectedOpponentAnalysisProfile,
  migrateLegacyProfiles,
  normalizeEngineSettings,
}
