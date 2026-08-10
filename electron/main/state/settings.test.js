const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildPortableDefaultSettings, loadSettings, saveSettings } = require('./settings')

function testPortableDefaultsHaveNoEngines() {
  const settings = buildPortableDefaultSettings()
  assert.deepEqual(settings.engines.profiles, [])
  assert.equal(settings.engines.outputAssignments['action-recommendation'], '')
  assert.equal(settings.audio.volume, 50)
  assert.equal(settings.audio.soundPackId, '')
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
    saveSettings(settings, options)
    const reloaded = loadSettings(options)
    assert.equal(reloaded.engines.outputAssignments['action-recommendation'], 'profile.example')
    assert.equal(reloaded.engines.profiles[0].name, 'My engine')
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
console.log('settings tests passed')
