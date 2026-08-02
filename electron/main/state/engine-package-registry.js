const fs = require('node:fs')
const path = require('node:path')

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/
const ENGINE_KINDS = new Set(['decision', 'opponent-analysis'])
const OPPONENT_INPUT_MODES = new Set(['public', 'full-information'])

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
  return !value.split('/').includes('..')
}

function addError(errors, condition, message) {
  if (!condition) errors.push(message)
}

function validateOpponentInputModes(value, errors, field) {
  if (value === undefined) return
  addError(errors, Array.isArray(value) && value.length > 0, `${field} must be a non-empty array`)
  if (!Array.isArray(value)) return
  addError(errors, new Set(value).size === value.length, `${field} must contain unique values`)
  addError(errors, value.includes('public'), `${field} must include public`)
  addError(
    errors,
    value.every((mode) => OPPONENT_INPUT_MODES.has(mode)),
    `${field} contains an unsupported mode`,
  )
}

function validateEngineManifest(manifest) {
  const errors = []
  addError(errors, isObject(manifest), 'manifest must be an object')
  if (!isObject(manifest)) return errors
  addError(errors, manifest.schemaVersion === 1, 'schemaVersion must be 1')
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
    manifest.protocol?.name === 'riichi-engine-protocol'
      && manifest.protocol?.major === 1
      && Number.isInteger(manifest.protocol?.minor),
    'protocol must be riichi-engine-protocol v1',
  )
  addError(
    errors,
    Array.isArray(manifest.kinds)
      && manifest.kinds.length > 0
      && new Set(manifest.kinds).size === manifest.kinds.length
      && manifest.kinds.every((kind) => ENGINE_KINDS.has(kind)),
    'kinds contains an unsupported engine kind',
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
        entrypoint.arguments === undefined
          || (Array.isArray(entrypoint.arguments)
            && entrypoint.arguments.every((argument) => typeof argument === 'string')),
        `entrypoint ${platform} arguments must be strings`,
      )
    }
  }

  addError(
    errors,
    Array.isArray(manifest.modelFormats) && manifest.modelFormats.length > 0,
    'modelFormats is required',
  )
  if (Array.isArray(manifest.modelFormats)) {
    for (const format of manifest.modelFormats) {
      addError(errors, isObject(format), 'model format must be an object')
      if (!isObject(format)) continue
      addError(errors, ID_PATTERN.test(format.id || ''), 'model format id is invalid')
      addError(
        errors,
        Array.isArray(format.extensions)
          && format.extensions.length > 0
          && format.extensions.every((extension) => /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(extension)),
        `model format ${format.id || ''} extensions are invalid`,
      )
      addError(errors, typeof format.inputSchema === 'string' && format.inputSchema.length > 0, 'inputSchema is required')
      addError(errors, typeof format.outputSchema === 'string' && format.outputSchema.length > 0, 'outputSchema is required')
    }
  }

  addError(errors, isObject(manifest.capabilities), 'capabilities is required')
  if (isObject(manifest.capabilities)) {
    for (const key of ['multipleSessions', 'incrementalHistory', 'cancellation', 'reload']) {
      addError(errors, typeof manifest.capabilities[key] === 'boolean', `capabilities.${key} must be boolean`)
    }
    validateOpponentInputModes(
      manifest.capabilities.opponentInputModes,
      errors,
      'capabilities.opponentInputModes',
    )
  }

  for (const field of ['licenses', 'notices']) {
    const documents = manifest[field]
    if (documents === undefined) continue
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

function validateModelMetadata(metadata) {
  const errors = []
  addError(errors, isObject(metadata), 'metadata must be an object')
  if (!isObject(metadata)) return errors
  addError(errors, metadata.schemaVersion === 1, 'schemaVersion must be 1')
  addError(errors, ID_PATTERN.test(metadata.id || ''), 'id is invalid')
  addError(errors, typeof metadata.name === 'string' && metadata.name.length > 0, 'name is required')
  addError(errors, ID_PATTERN.test(metadata.engineId || ''), 'engineId is invalid')
  addError(errors, ID_PATTERN.test(metadata.format || ''), 'format is invalid')
  addError(errors, isSafePackagePath(metadata.file), 'file must be a safe relative path')
  addError(errors, /^[0-9a-f]{64}$/.test(metadata.sha256 || ''), 'sha256 must use 64 lowercase hexadecimal characters')
  addError(errors, Number.isInteger(metadata.sizeBytes) && metadata.sizeBytes > 0, 'sizeBytes must be a positive integer')
  addError(errors, typeof metadata.inputSchema === 'string' && metadata.inputSchema.length > 0, 'inputSchema is required')
  addError(errors, typeof metadata.outputSchema === 'string' && metadata.outputSchema.length > 0, 'outputSchema is required')
  validateOpponentInputModes(metadata.opponentInputModes, errors, 'opponentInputModes')
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

function runtimeModelPath(modelFilePath) {
  return path.resolve(modelFilePath)
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
  return {
    engineRoots: roots,
    modelRoots: roots,
  }
}

function discoverEnginePackages(options = {}) {
  const roots = defaultRoots(options)
  const diagnostics = []
  const engineById = new Map()
  const modelById = new Map()

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

  for (const root of roots.modelRoots) {
    for (const metadataPath of findManifestFiles(root.path, 'model.json')) {
      let metadata
      try {
        metadata = readJson(metadataPath)
      } catch (error) {
        diagnostics.push(createDiagnostic('error', 'model-json-invalid', metadataPath, error.message))
        continue
      }
      const errors = validateModelMetadata(metadata)
      if (errors.length > 0) {
        diagnostics.push(createDiagnostic('error', 'model-metadata-invalid', metadataPath, errors.join('; ')))
        continue
      }
      if (modelById.has(metadata.id)) {
        diagnostics.push(createDiagnostic(
          'warning',
          'model-id-duplicate',
          metadataPath,
          `${metadata.id} is already registered; the first package wins`,
        ))
        continue
      }
      const modelFilePath = path.resolve(path.dirname(metadataPath), metadata.file)
      let fileError = ''
      try {
        const stat = fs.statSync(modelFilePath)
        if (!stat.isFile()) {
          fileError = 'model path is not a file'
        } else if (stat.size !== metadata.sizeBytes) {
          fileError = `model size is ${stat.size}, expected ${metadata.sizeBytes}`
        }
      } catch (error) {
        fileError = error.message
      }
      if (fileError) {
        diagnostics.push(createDiagnostic('error', 'model-file-invalid', modelFilePath, fileError))
      }
      modelById.set(metadata.id, {
        id: metadata.id,
        name: metadata.name,
        builtIn: root.builtIn,
        packageRoot: path.dirname(metadataPath),
        metadataPath,
        modelFilePath,
        runtimePath: runtimeModelPath(modelFilePath),
        fileValid: !fileError,
        compatible: false,
        metadata,
      })
    }
  }

  for (const model of modelById.values()) {
    const engine = engineById.get(model.metadata.engineId)
    if (!engine) {
      diagnostics.push(createDiagnostic(
        'error',
        'model-engine-missing',
        model.metadataPath,
        `engine ${model.metadata.engineId} is not installed`,
      ))
      continue
    }
    const format = engine.manifest.modelFormats.find((item) => item.id === model.metadata.format)
    if (!format) {
      diagnostics.push(createDiagnostic(
        'error',
        'model-format-unsupported',
        model.metadataPath,
        `engine ${engine.id} does not support ${model.metadata.format}`,
      ))
      continue
    }
    if (
      format.inputSchema !== model.metadata.inputSchema
      || format.outputSchema !== model.metadata.outputSchema
    ) {
      diagnostics.push(createDiagnostic(
        'error',
        'model-schema-mismatch',
        model.metadataPath,
        `model schemas do not match engine format ${format.id}`,
      ))
      continue
    }
    model.compatible = model.fileValid && engine.launchAvailable
  }

  return {
    schemaVersion: 1,
    engines: [...engineById.values()],
    models: [...modelById.values()],
    diagnostics,
  }
}

function publicEngineCatalog(catalog) {
  const platformKey = currentPlatformKey()
  return {
    schemaVersion: 1,
    engines: catalog.engines.map((engine) => {
      const entrypoint = engine.manifest.entrypoints[platformKey]
      return {
        id: engine.id,
        name: engine.name,
        version: engine.version,
        builtIn: engine.builtIn,
        kinds: engine.manifest.kinds,
        capabilities: engine.manifest.capabilities,
        modelFormats: engine.manifest.modelFormats,
        optionsSchema: engine.manifest.optionsSchema || {
          type: 'object',
          properties: {},
        },
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
    models: catalog.models.map((model) => ({
      id: model.id,
      name: model.name,
      engineId: model.metadata.engineId,
      format: model.metadata.format,
      builtIn: model.builtIn,
      compatible: model.compatible,
      runtimePath: model.runtimePath,
      sha256: model.metadata.sha256,
      inputSchema: model.metadata.inputSchema,
      outputSchema: model.metadata.outputSchema,
      opponentInputModes: model.metadata.opponentInputModes || [],
    })),
    diagnostics: catalog.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  }
}

module.exports = {
  discoverEnginePackages,
  publicEngineCatalog,
  validateEngineManifest,
  validateModelMetadata,
}
