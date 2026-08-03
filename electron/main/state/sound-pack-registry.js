const fs = require('node:fs')
const path = require('node:path')

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/
const SOUND_EVENTS = new Set([
  'action.confirmed',
  'action.required',
  'call.chi',
  'call.kan',
  'call.pon',
  'call.riichi',
  'review.required',
  'round.result',
  'tile.discard',
  'win.ron',
  'win.tsumo',
])
const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.ogg', '.wav'])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSafePackagePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\')) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return !value.split('/').includes('..')
}

function validateSoundPackManifest(manifest) {
  const errors = []
  if (!isObject(manifest)) return ['manifest must be an object']
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (!ID_PATTERN.test(manifest.id || '')) errors.push('id is invalid')
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) errors.push('name is required')
  if (!SEMVER_PATTERN.test(manifest.version || '')) errors.push('version must be semantic version')
  if (!isObject(manifest.sounds) || Object.keys(manifest.sounds).length === 0) {
    errors.push('sounds must be a non-empty object')
  } else {
    for (const [event, relativePath] of Object.entries(manifest.sounds)) {
      if (!SOUND_EVENTS.has(event)) errors.push(`unsupported sound event: ${event}`)
      if (!isSafePackagePath(relativePath)) {
        errors.push(`sound path for ${event} must be a safe relative path`)
      } else if (!AUDIO_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
        errors.push(`sound path for ${event} uses an unsupported file type`)
      }
    }
  }
  return errors
}

function findManifestFiles(rootPath, maxDepth = 4) {
  if (!rootPath || !fs.existsSync(rootPath)) return []
  const results = []

  function visit(currentPath, depth) {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const entryPath = path.join(currentPath, entry.name)
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.soundpack.json')) {
        results.push(entryPath)
      } else if (entry.isDirectory() && depth < maxDepth) {
        visit(entryPath, depth + 1)
      }
    }
  }

  visit(path.resolve(rootPath), 0)
  return results.sort((left, right) => left.localeCompare(right))
}

function defaultSoundPackRoots(options = {}) {
  const appDir = path.resolve(options.appDir || path.join(__dirname, '..', '..', '..'))
  const portableDir = path.resolve(options.portableDir || appDir)
  const resourceDir = path.resolve(options.resourceDir || appDir)
  const bundledRoot = options.isPackaged
    ? path.join(resourceDir, 'sound-packs')
    : path.join(appDir, 'resources', 'sound-packs')
  const localRoot = options.isPackaged
    ? path.join(portableDir, 'sound-packs')
    : path.join(portableDir, '.mjai-runtime', 'sound-packs')
  const roots = [{ path: bundledRoot, builtIn: true }]
  if (path.resolve(localRoot) !== path.resolve(bundledRoot)) {
    roots.push({ path: localRoot, builtIn: false })
  }
  const configuredRoots = String(options.env?.RMS_SOUND_PACK_ROOTS || '')
    .split(path.delimiter)
    .map((rootPath) => rootPath.trim())
    .filter(Boolean)
  for (const configuredRoot of configuredRoots) {
    const resolvedRoot = path.resolve(configuredRoot)
    if (roots.some((root) => path.resolve(root.path) === resolvedRoot)) continue
    roots.push({ path: resolvedRoot, builtIn: false })
  }
  return roots
}

function discoverSoundPacks(options = {}) {
  const packs = []
  const diagnostics = []
  const ids = new Set()

  for (const root of defaultSoundPackRoots(options)) {
    for (const manifestPath of findManifestFiles(root.path)) {
      let manifest
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          code: 'sound-pack-json-invalid',
          path: manifestPath,
          message: error.message,
        })
        continue
      }
      const errors = validateSoundPackManifest(manifest)
      if (errors.length > 0) {
        diagnostics.push({
          severity: 'error',
          code: 'sound-pack-manifest-invalid',
          path: manifestPath,
          message: errors.join('; '),
        })
        continue
      }
      if (ids.has(manifest.id)) {
        diagnostics.push({
          severity: 'warning',
          code: 'sound-pack-id-duplicate',
          path: manifestPath,
          message: `${manifest.id} is already registered; the first manifest wins`,
        })
        continue
      }
      const packageRoot = path.dirname(manifestPath)
      const sounds = {}
      let missingFile = false
      for (const [event, relativePath] of Object.entries(manifest.sounds)) {
        const filePath = path.resolve(packageRoot, relativePath)
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          diagnostics.push({
            severity: 'error',
            code: 'sound-pack-file-missing',
            path: filePath,
            message: `sound file is missing for ${manifest.id}:${event}`,
          })
          missingFile = true
        }
        sounds[event] = filePath
      }
      if (missingFile) continue
      ids.add(manifest.id)
      packs.push({
        id: manifest.id,
        name: manifest.name.trim(),
        version: manifest.version,
        builtIn: root.builtIn,
        manifestPath,
        packageRoot,
        sounds,
      })
    }
  }

  return { schemaVersion: 1, packs, diagnostics }
}

function soundSourceUrl(packId, event) {
  return `rms-sound://audio/${encodeURIComponent(packId)}/${encodeURIComponent(event)}`
}

function publicSoundPackCatalog(catalog) {
  return {
    schemaVersion: 1,
    packs: catalog.packs.map((pack) => ({
      id: pack.id,
      name: pack.name,
      version: pack.version,
      builtIn: pack.builtIn,
      sounds: Object.fromEntries(
        Object.keys(pack.sounds).map((event) => [event, soundSourceUrl(pack.id, event)]),
      ),
    })),
    diagnostics: catalog.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  }
}

function resolveSoundPackFile(catalog, packId, event) {
  const pack = catalog.packs.find((item) => item.id === String(packId || ''))
  return pack?.sounds?.[String(event || '')] || ''
}

module.exports = {
  SOUND_EVENTS,
  defaultSoundPackRoots,
  discoverSoundPacks,
  publicSoundPackCatalog,
  resolveSoundPackFile,
  soundSourceUrl,
  validateSoundPackManifest,
}
