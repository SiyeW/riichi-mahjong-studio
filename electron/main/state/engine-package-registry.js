const fs = require('node:fs')
const path = require('node:path')

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/
const ENGINE_PROTOCOL_NAME = 'riichi-engine-protocol'
const ENGINE_PROTOCOL_MAJOR = 2

function currentPlatformKey() {
  return process.platform === 'win32'
    ? 'windows-x64'
    : `${process.platform}-${process.arch}`
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSafePackagePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\')) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  const segments = value.split('/')
  return segments.every((segment) => segment && segment !== '.' && segment !== '..')
}

function addError(errors, condition, message) {
  if (!condition) errors.push(message)
}

function validateEngineManifest(manifest) {
  const errors = []
  addError(errors, isObject(manifest), 'manifest must be an object')
  if (!isObject(manifest)) return errors
  addError(errors, manifest.schemaVersion === 2, 'schemaVersion must be 2')
  addError(errors, ID_PATTERN.test(manifest.id || ''), 'id is invalid')
  addError(errors, typeof manifest.name === 'string' && manifest.name.length > 0, 'name is required')
  addError(errors, SEMVER_PATTERN.test(manifest.version || ''), 'version must be semantic version')
  if (manifest.sourceUrl !== undefined) {
    let sourceUrlValid = false
    try {
      const sourceUrl = new URL(manifest.sourceUrl)
      sourceUrlValid = sourceUrl.protocol === 'https:' || sourceUrl.protocol === 'http:'
    } catch {
      sourceUrlValid = false
    }
    addError(errors, sourceUrlValid, 'sourceUrl must be an HTTP or HTTPS URL')
  }
  addError(
    errors,
    isObject(manifest.protocol)
      && manifest.protocol.name === ENGINE_PROTOCOL_NAME
      && manifest.protocol.major === ENGINE_PROTOCOL_MAJOR
      && Number.isInteger(manifest.protocol.minor)
      && manifest.protocol.minor >= 0,
    'protocol must declare a supported riichi-engine-protocol major version',
  )

  const entrypoints = manifest.entrypoints
  addError(errors, isObject(entrypoints) && Object.keys(entrypoints).length > 0, 'entrypoints is required')
  if (isObject(entrypoints)) {
    for (const [platform, entrypoint] of Object.entries(entrypoints)) {
      addError(errors, /^[a-z0-9]+-[a-z0-9]+$/.test(platform), `entrypoint platform ${platform} is invalid`)
      addError(errors, isObject(entrypoint), `entrypoint ${platform} must be an object`)
      if (!isObject(entrypoint)) continue
      addError(
        errors,
        isSafePackagePath(entrypoint.executable),
        `entrypoint ${platform} executable must be a safe relative path`,
      )
      addError(
        errors,
        Array.isArray(entrypoint.arguments)
          && entrypoint.arguments.every((argument) => typeof argument === 'string'),
        `entrypoint ${platform} arguments must be strings`,
      )
    }
  }

  for (const field of ['licenses', 'notices']) {
    const documents = manifest[field]
    if (field === 'licenses') {
      addError(errors, Array.isArray(documents) && documents.length > 0, 'licenses must be a non-empty array')
    } else if (documents === undefined) {
      continue
    }
    addError(errors, Array.isArray(documents), `${field} must be an array`)
    if (!Array.isArray(documents)) continue
    for (const document of documents) {
      addError(errors, isObject(document), `${field} entries must be objects`)
      if (!isObject(document)) continue
      addError(
        errors,
        typeof document.name === 'string' && document.name.length > 0,
        `${field} entry name is required`,
      )
      addError(
        errors,
        isSafePackagePath(document.path),
        `${field} entry path must be a safe relative path`,
      )
    }
  }
  return errors
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function findManifestFiles(rootPath, fileName, maxDepth = 4) {
  if (!rootPath || !fs.existsSync(rootPath)) return []
  const results = []

  function visit(currentPath, depth) {
    const directManifest = path.join(currentPath, fileName)
    if (fs.existsSync(directManifest) && fs.statSync(directManifest).isFile()) {
      results.push(directManifest)
    }
    if (depth >= maxDepth) return
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      visit(path.join(currentPath, entry.name), depth + 1)
    }
  }

  visit(path.resolve(rootPath), 0)
  return results
}

function createDiagnostic(severity, code, filePath, message) {
  return {
    severity,
    code,
    path: filePath,
    message,
  }
}

function defaultRoots(options = {}) {
  const appDir = path.resolve(options.appDir || path.join(__dirname, '..', '..', '..'))
  const portableDir = path.resolve(options.portableDir || appDir)
  const resourceDir = path.resolve(options.resourceDir || appDir)
  const builtInEngineRoot = options.isPackaged
    ? path.join(resourceDir, 'engines')
    : path.join(appDir, 'engines')
  const userEngineRoot = path.join(portableDir, 'engines')

  const roots = [{ path: builtInEngineRoot, builtIn: true }]
  if (path.resolve(userEngineRoot) !== path.resolve(builtInEngineRoot)) {
    roots.push({ path: userEngineRoot, builtIn: false })
  }
  const configuredRoots = String(options.env?.MJAI_ENGINE_ROOTS || '')
    .split(path.delimiter)
    .map((rootPath) => rootPath.trim())
    .filter(Boolean)
  for (const configuredRoot of configuredRoots) {
    const resolvedRoot = path.resolve(configuredRoot)
    if (roots.some((root) => path.resolve(root.path) === resolvedRoot)) continue
    roots.push({ path: resolvedRoot, builtIn: false })
  }
  return { engineRoots: roots }
}

function discoverEnginePackages(options = {}) {
  const roots = defaultRoots(options)
  const diagnostics = []
  const engineById = new Map()

  for (const root of roots.engineRoots) {
    for (const manifestPath of findManifestFiles(root.path, 'engine.json')) {
      let manifest
      try {
        manifest = readJson(manifestPath)
      } catch (error) {
        diagnostics.push(createDiagnostic('error', 'engine-json-invalid', manifestPath, error.message))
        continue
      }
      const errors = validateEngineManifest(manifest)
      if (errors.length > 0) {
        diagnostics.push(createDiagnostic('error', 'engine-manifest-invalid', manifestPath, errors.join('; ')))
        continue
      }
      if (engineById.has(manifest.id)) {
        diagnostics.push(createDiagnostic(
          'warning',
          'engine-id-duplicate',
          manifestPath,
          `${manifest.id} is already registered; the first package wins`,
        ))
        continue
      }
      const entrypoint = manifest.entrypoints[currentPlatformKey()]
      let launchAvailable = false
      if (!entrypoint) {
        diagnostics.push(createDiagnostic(
          'error',
          'engine-platform-unsupported',
          manifestPath,
          `${manifest.id} has no entrypoint for ${currentPlatformKey()}`,
        ))
      } else {
        const executablePath = path.resolve(
          path.dirname(manifestPath),
          entrypoint.executable,
        )
        launchAvailable = fs.existsSync(executablePath)
          && fs.statSync(executablePath).isFile()
        if (!launchAvailable) {
          diagnostics.push(createDiagnostic(
            'error',
            'engine-executable-missing',
            executablePath,
            `engine executable is missing for ${manifest.id}`,
          ))
        }
      }
      const legalDocuments = (field) => (manifest[field] || []).map((document) => {
        const resolvedPath = path.resolve(path.dirname(manifestPath), document.path)
        const available = fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()
        if (!available) {
          diagnostics.push(createDiagnostic(
            'error',
            `engine-${field.slice(0, -1)}-missing`,
            resolvedPath,
            `${field.slice(0, -1)} document is missing for ${manifest.id}`,
          ))
        }
        return {
          name: document.name,
          relativePath: document.path,
          resolvedPath,
          available,
        }
      })
      engineById.set(manifest.id, {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        builtIn: root.builtIn,
        packageRoot: path.dirname(manifestPath),
        manifestPath,
        manifest,
        executablePath: entrypoint
          ? path.resolve(path.dirname(manifestPath), entrypoint.executable)
          : '',
        launchAvailable,
        licenses: legalDocuments('licenses'),
        notices: legalDocuments('notices'),
      })
    }
  }

  return {
    schemaVersion: 2,
    engines: [...engineById.values()],
    diagnostics,
  }
}

function publicEngineCatalog(catalog) {
  const platformKey = currentPlatformKey()
  return {
    schemaVersion: 2,
    engines: catalog.engines.map((engine) => {
      const entrypoint = engine.manifest.entrypoints[platformKey]
      return {
        id: engine.id,
        name: engine.name,
        version: engine.version,
        builtIn: engine.builtIn,
        protocol: { ...engine.manifest.protocol },
        licenses: engine.licenses.map(({ name, available }) => ({ name, available })),
        notices: engine.notices.map(({ name, available }) => ({ name, available })),
        sourceUrl: engine.manifest.sourceUrl || '',
        enginePath: engine.executablePath,
        launch: engine.launchAvailable && entrypoint
          ? {
            executable: path.resolve(engine.packageRoot, entrypoint.executable),
            arguments: [...(entrypoint.arguments || [])],
            cwd: engine.packageRoot,
          }
          : null,
      }
    }),
    diagnostics: catalog.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  }
}

module.exports = {
  discoverEnginePackages,
  publicEngineCatalog,
  validateEngineManifest,
}
