const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  buildPortableDefaultSettings,
  loadSettings,
  saveSettings,
} = require('./settings')

function testPortableDefaultsHaveNoEngines() {
  const settings = buildPortableDefaultSettings()
  assert.deepEqual(settings.engines.decisionProfiles, [])
  assert.deepEqual(settings.engines.opponentAnalysisProfiles, [])
  assert.equal(settings.engines.selectedDecisionProfileId, '')
  assert.equal(settings.engines.selectedOpponentAnalysisProfileId, '')
  assert.equal(settings.audio.volume, 50)
  assert.equal(settings.audio.voice, 'female')
}

function testUserProfilePersists() {
  const portableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riichi-studio-settings-'))
  const options = { appDir: portableDir, portableDir, resourceDir: portableDir }
  try {
    const settings = loadSettings(options)
    settings.engines.decisionProfiles.push({
      id: 'profile.example',
      name: 'My engine',
      engineId: 'example.decision',
      modelId: 'example.model',
      options: { temperature: 0.5 },
    })
    settings.engines.selectedDecisionProfileId = 'profile.example'
    saveSettings(settings, options)
    const reloaded = loadSettings(options)
    assert.equal(reloaded.engines.selectedDecisionProfileId, 'profile.example')
    assert.equal(reloaded.engines.decisionProfiles[0].name, 'My engine')
  } finally {
    fs.rmSync(portableDir, { recursive: true, force: true })
  }
}

testPortableDefaultsHaveNoEngines()
testUserProfilePersists()
console.log('settings tests passed')
