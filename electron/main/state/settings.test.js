const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildPortableDefaultSettings, loadSettings, saveSettings } = require('./settings')
const { createDefaultDockLayout } = require('./workspace-layout')

function expectedWorkspaceLayout({ legacyOrder, ...overrides } = {}) {
  return {
    layout: createDefaultDockLayout(legacyOrder),
    analysisVisible: false,
    analysisPanels: {
      opponents: true,
      game: true,
      risk: false,
      counts: false,
    },
    consoleVisible: true,
    ...overrides,
  }
}

function testPortableDefaultsHaveNoEngines() {
  const settings = buildPortableDefaultSettings()
  assert.deepEqual(settings.engines.profiles, [])
  assert.deepEqual(settings.engines.loadedProfileIds, [])
  assert.equal(settings.engines.outputAssignments['action-recommendation'], '')
  assert.equal(settings.audio.volume, 50)
  assert.equal(settings.audio.soundPackId, '')
  assert.equal(settings.display.tablePosition, 'center')
  assert.equal(settings.display.language, 'system')
  assert.deepEqual(settings.display.workspaceLayout, expectedWorkspaceLayout())
  assert.equal('voice' in settings.audio, false)
}

function testUserProfilePersists() {
  const portableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riichi-studio-settings-'))
  const options = { appDir: portableDir, portableDir, resourceDir: portableDir }
  try {
    const settings = loadSettings(options)
    settings.engines.profiles.push({
      id: 'profile.example',
      name: 'My engine',
      engineId: 'example.engine',
      enginePath: 'C:\\engine\\engine.exe',
      weights: [{ slotId: 'model', format: 'example', path: 'C:\\engine\\model.bin' }],
      device: 'cpu',
      options: { temperature: 0.5 },
    })
    settings.engines.outputAssignments['action-recommendation'] = 'profile.example'
    settings.engines.loadedProfileIds = ['profile.example']
    settings.display.tablePosition = 'right'
    settings.display.language = 'ja-JP'
    settings.display.workspaceLayout = {
      layout: createDefaultDockLayout(['console', 'table', 'analysis']),
      analysisVisible: true,
      analysisPanels: {
        opponents: true,
        game: false,
        risk: true,
        counts: false,
      },
      consoleVisible: false,
    }
    saveSettings(settings, options)
    const reloaded = loadSettings(options)
    assert.equal(reloaded.engines.outputAssignments['action-recommendation'], 'profile.example')
    assert.equal(reloaded.engines.profiles[0].name, 'My engine')
    assert.deepEqual(reloaded.engines.loadedProfileIds, ['profile.example'])
    assert.equal(reloaded.display.tablePosition, 'right')
    assert.equal(reloaded.display.language, 'ja-JP')
    assert.deepEqual(reloaded.display.workspaceLayout, {
      layout: createDefaultDockLayout(['console', 'table', 'analysis']),
      analysisVisible: true,
      analysisPanels: {
        opponents: true,
        game: false,
        risk: true,
        counts: false,
      },
      consoleVisible: false,
    })
  } finally {
    fs.rmSync(portableDir, { recursive: true, force: true })
  }
}

function testInvalidTablePositionUsesCenter() {
  const portableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riichi-studio-display-settings-'))
  const options = { appDir: portableDir, portableDir, resourceDir: portableDir }
  try {
    fs.writeFileSync(path.join(portableDir, 'config.json'), JSON.stringify({
      display: { tablePosition: 'diagonal' },
    }))
    assert.equal(loadSettings(options).display.tablePosition, 'center')
  } finally {
    fs.rmSync(portableDir, { recursive: true, force: true })
  }
}

function testInvalidLanguageUsesSystem() {
  const portableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riichi-studio-language-settings-'))
  const options = { appDir: portableDir, portableDir, resourceDir: portableDir }
  try {
    fs.writeFileSync(path.join(portableDir, 'config.json'), JSON.stringify({
      display: { language: 'fr-FR' },
    }))
    assert.equal(loadSettings(options).display.language, 'system')
  } finally {
    fs.rmSync(portableDir, { recursive: true, force: true })
  }
}

function testInvalidWorkspaceLayoutUsesSafeDefaults() {
  const portableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riichi-studio-workspace-settings-'))
  const options = { appDir: portableDir, portableDir, resourceDir: portableDir }
  try {
    fs.writeFileSync(path.join(portableDir, 'config.json'), JSON.stringify({
      display: {
        workspaceLayout: {
          order: ['console', 'unknown', 'console'],
          analysisVisible: 'yes',
          consoleVisible: 'no',
        },
      },
    }))
    assert.deepEqual(
      loadSettings(options).display.workspaceLayout,
      expectedWorkspaceLayout({ legacyOrder: ['console', 'table', 'analysis'] }),
    )
  } finally {
    fs.rmSync(portableDir, { recursive: true, force: true })
  }
}

function testSoundPackSelectionPersistsOnlyWhileAvailable() {
  const portableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riichi-studio-sound-settings-'))
  const options = { appDir: portableDir, portableDir, resourceDir: portableDir }
  const packageRoot = path.join(portableDir, '.mjai-runtime', 'sound-packs', 'test')
  const manifestPath = path.join(packageRoot, 'test.soundpack.json')
  const soundPath = path.join(packageRoot, 'sounds', 'discard.wav')
  try {
    fs.mkdirSync(path.dirname(soundPath), { recursive: true })
    fs.writeFileSync(soundPath, 'test')
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      id: 'local.test.sound',
      name: 'Test Sound',
      version: '1.0.0',
      sounds: { 'tile.discard': 'sounds/discard.wav' },
    }))
    const settings = loadSettings(options)
    settings.audio.soundPackId = 'local.test.sound'
    saveSettings(settings, options)
    assert.equal(loadSettings(options).audio.soundPackId, 'local.test.sound')
    fs.rmSync(manifestPath)
    assert.equal(loadSettings(options).audio.soundPackId, '')
  } finally {
    fs.rmSync(portableDir, { recursive: true, force: true })
  }
}

testPortableDefaultsHaveNoEngines()
testUserProfilePersists()
testSoundPackSelectionPersistsOnlyWhileAvailable()
testInvalidTablePositionUsesCenter()
testInvalidLanguageUsesSystem()
testInvalidWorkspaceLayoutUsesSafeDefaults()
console.log('settings tests passed')
