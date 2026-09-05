import assert from 'node:assert/strict'
import test from 'node:test'
import { settingsChanges, mergeSettingsReply } from './settingsChanges.ts'
import { normalizeWorkspaceLayout } from './workspaceSettings.ts'

function fixture(): TrainerSettings {
  return {
    configPath: '',
    training: { mode: 'threshold_review', mistakeThreshold: 0.25, thinkingTimeMinS: 0.25, thinkingTimeMaxS: 1 },
    modeDefaults: { autoAdvanceDelayMs: 250 },
    display: { language: 'system', uiScale: 1, colorScheme: 'default', reduceMotion: false, tablePosition: 'center', showTsumogiriInPlay: true, workspaceLayout: normalizeWorkspaceLayout(null) },
    audio: { volume: 50, soundPackId: '' },
    records: { saveRecoveryOnExit: true },
    engines: { schemaVersion: 2, profiles: [], loadedProfileIds: [], outputAssignments: {
      'action-recommendation': '', 'opponent-shanten': '', 'opponent-deal-in-probability': '',
      'opponent-concealed-tile-count': '', 'wall-tile-count': '', 'opponent-dora-count': '',
      'opponent-score': '', 'kyoku-outcome': '', 'kyoku-score-delta': '', 'match-placement': '', 'match-score': '',
    } },
  }
}

test('quick volume changes do not submit settings or engines from an old snapshot', () => {
  const before = fixture()
  const after = structuredClone(before)
  after.audio.volume = 20
  assert.deepEqual(settingsChanges(before, after), { audio: { volume: 20 } })
  assert.deepEqual(settingsChanges(before, before), {})
})

test('a settings panel submits only changes since it opened', () => {
  const baseline = fixture()
  const draft = structuredClone(baseline)
  draft.display.colorScheme = 'naga'
  const current = structuredClone(baseline)
  current.audio.volume = 10
  current.display.uiScale = 1.5
  const patch = settingsChanges(baseline, draft)
  assert.deepEqual(patch, { display: { colorScheme: 'naga' } })
  const reply = structuredClone(draft)
  const merged = mergeSettingsReply(current, reply, patch)
  assert.equal(merged.audio.volume, 10)
  assert.equal(merged.display.uiScale, 1.5)
  assert.equal(merged.display.colorScheme, 'naga')
})

test('replies from unrelated saves commute and cannot revert current fields', () => {
  const before = fixture()
  const audioReply = structuredClone(before)
  audioReply.audio.volume = 30
  const displayReply = structuredClone(before)
  displayReply.display.uiScale = 1.25
  const audio = { audio: { volume: 30 } }
  const display = { display: { uiScale: 1.25 } }
  const a = mergeSettingsReply(mergeSettingsReply(before, audioReply, audio), displayReply, display)
  const b = mergeSettingsReply(mergeSettingsReply(before, displayReply, display), audioReply, audio)
  assert.deepEqual(a, b)
  assert.equal(a.audio.volume, 30)
  assert.equal(a.display.uiScale, 1.25)
})

test('engine replies preserve newer general settings', () => {
  const current = fixture()
  const reply = structuredClone(current)
  current.audio.volume = 80
  reply.engines.loadedProfileIds = ['example']
  const merged = mergeSettingsReply(current, reply, { engines: reply.engines })
  assert.equal(merged.audio.volume, 80)
  assert.deepEqual(merged.engines.loadedProfileIds, ['example'])
  assert.equal(current.engines.loadedProfileIds.length, 0)
})

test('patch values are detached from later draft edits', () => {
  const before = fixture()
  const after = structuredClone(before)
  after.display.workspaceLayout.analysisVisible = true
  const patch = settingsChanges(before, after)
  after.display.workspaceLayout.analysisVisible = false
  assert.equal(patch.display?.workspaceLayout?.analysisVisible, true)
})
