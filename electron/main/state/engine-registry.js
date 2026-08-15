const ENGINE_SETTINGS_SCHEMA_VERSION = 2
const SUPPORTED_OUTPUTS = Object.freeze([
  'action-recommendation',
  'opponent-shanten',
  'opponent-deal-in-probability',
  'opponent-concealed-tile-count',
  'wall-tile-count',
  'opponent-dora-count',
  'opponent-score',
  'kyoku-outcome',
  'kyoku-score-delta',
  'match-placement',
  'match-score',
])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function catalogMaps(catalog = {}) {
  return {
    engines: new Map((catalog.engines || []).map((engine) => [engine.id, engine])),
  }
}

function normalizeWeights(value) {
  if (!Array.isArray(value)) return []
  const slotIds = new Set()
  return value
    .filter(isObject)
    .map((weight) => ({
      slotId: String(weight.slotId || ''),
      format: String(weight.format || ''),
      path: String(weight.path || ''),
    }))
    .filter((weight) => {
      if (!weight.slotId || slotIds.has(weight.slotId)) return false
      slotIds.add(weight.slotId)
      return true
    })
}

function normalizeProfile(source, catalog) {
  const profile = isObject(source) ? source : {}
  const maps = catalogMaps(catalog)
  const requestedEngineId = String(profile.engineId || '')
  const requestedEnginePath = String(profile.enginePath || '')
  const engine = maps.engines.get(requestedEngineId)
    || (catalog.engines || []).find((item) => (
      requestedEnginePath
      && String(item.enginePath || '').toLowerCase() === requestedEnginePath.toLowerCase()
    ))
  const entrypoint = engine?.manifest?.entrypoints
    ? Object.values(engine.manifest.entrypoints)[0]
    : null
  const enginePath = String(engine?.executablePath || requestedEnginePath)
  const engineCommand = engine?.executablePath
    ? [engine.executablePath, ...(entrypoint?.arguments || []).map(String)]
    : (Array.isArray(profile.engineCommand) ? profile.engineCommand.map(String) : [])
  const available = Boolean(engine?.launchAvailable || enginePath)

  return {
    id: String(profile.id || ''),
    name: String(profile.name ?? ''),
    builtIn: Boolean(engine?.builtIn || profile.builtIn),
    autoName: profile.autoName !== false,
    enginePath,
    engineCommand,
    engineCwd: String(engine?.packageRoot || profile.engineCwd || ''),
    engineId: String(engine?.id || requestedEngineId),
    engineVersion: String(engine?.version || profile.engineVersion || ''),
    weights: normalizeWeights(profile.weights),
    device: String(profile.device || ''),
    options: isObject(profile.options) ? { ...profile.options } : {},
    available,
    unavailableReason: available ? '' : '引擎包未安装',
  }
}

function normalizeProfiles(profiles, catalog) {
  if (!Array.isArray(profiles)) return []
  const ids = new Set()
  return profiles
    .map((profile) => normalizeProfile(profile, catalog))
    .filter((profile) => {
      if (!profile.id || ids.has(profile.id)) return false
      ids.add(profile.id)
      return true
    })
}

function normalizeAssignments(source, profiles) {
  const assignments = isObject(source) ? source : {}
  const profileIds = new Set(profiles.map((profile) => profile.id))
  return Object.fromEntries(SUPPORTED_OUTPUTS.map((outputId) => {
    const profileId = String(assignments[outputId] || '')
    return [outputId, profileIds.has(profileId) ? profileId : '']
  }))
}

function normalizeLoadedProfileIds(source, profiles) {
  if (!Array.isArray(source)) return []
  const profileIds = new Set(profiles.map((profile) => profile.id))
  return [...new Set(source.map(String))].filter((profileId) => profileIds.has(profileId))
}

function normalizeEngineSettings(source = {}, _legacyModels = null, catalog = {}) {
  const settings = isObject(source) ? source : {}
  const profiles = normalizeProfiles(settings.profiles, catalog)
  return {
    schemaVersion: ENGINE_SETTINGS_SCHEMA_VERSION,
    profiles,
    outputAssignments: normalizeAssignments(settings.outputAssignments, profiles),
    loadedProfileIds: normalizeLoadedProfileIds(settings.loadedProfileIds, profiles),
  }
}

function getAssignedProfile(engineSettings, outputId) {
  const profileId = String(engineSettings.outputAssignments?.[outputId] || '')
  return engineSettings.profiles.find((profile) => profile.id === profileId) || null
}

function buildBuiltInProfiles() {
  return {
    profiles: [],
    outputAssignments: Object.fromEntries(SUPPORTED_OUTPUTS.map((outputId) => [outputId, ''])),
    loadedProfileIds: [],
  }
}

function migrateLegacyProfiles(source, _legacyModels, catalog) {
  return normalizeEngineSettings(source, null, catalog)
}

module.exports = {
  SUPPORTED_OUTPUTS,
  buildBuiltInProfiles,
  getAssignedProfile,
  migrateLegacyProfiles,
  normalizeEngineSettings,
}
