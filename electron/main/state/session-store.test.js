const assert = require('node:assert/strict')

const { normalizeSnapshot } = require('./session-store')

const snapshot = normalizeSnapshot({
  modelRuntime: {
    opponentAnalysis: {
      profileId: 'profile.first+profile.second',
      profileIds: ['profile.first', 'profile.second'],
      profiles: {
        'profile.first': { ready: true, unloaded: false },
        'profile.second': { ready: false, unloaded: true },
      },
      ready: false,
      unloaded: false,
    },
  },
})

assert.deepEqual(snapshot.modelRuntime.opponentAnalysis, {
  profileId: 'profile.first+profile.second',
  profileIds: ['profile.first', 'profile.second'],
  profiles: {
    'profile.first': { ready: true, unloaded: false },
    'profile.second': { ready: false, unloaded: true },
  },
  ready: false,
  unloaded: false,
})

console.log('session store tests passed')
