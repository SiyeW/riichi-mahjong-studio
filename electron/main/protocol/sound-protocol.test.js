const assert = require('node:assert/strict')
const test = require('node:test')
const { registerSoundProtocol } = require('./sound-protocol')

function createFixture({ resolvedPath = 'D:\\sounds\\pack\\discard.ogg' } = {}) {
  let handler
  const calls = []
  registerSoundProtocol({
    protocol: { handle: (scheme, value) => { calls.push(['handle', scheme]); handler = value } },
    net: { fetch: (url) => { calls.push(['fetch', url]); return { url } } },
    appOptions: { root: 'test' },
    discoverSoundPacksImpl: (options) => { calls.push(['discover', options]); return ['pack'] },
    resolveSoundPackFileImpl: (...args) => { calls.push(['resolve', ...args]); return resolvedPath },
    pathToFileURLImpl: (filePath) => ({ toString: () => `file:${filePath}` }),
  })
  return { calls, getHandler: () => handler }
}

test('sound protocol resolves exactly one pack and sound path before fetching the file', () => {
  const { calls, getHandler } = createFixture()
  const result = getHandler()({ url: 'rms-sound://audio/default/discard' })

  assert.deepEqual(calls, [
    ['handle', 'rms-sound'],
    ['discover', { root: 'test' }],
    ['resolve', ['pack'], 'default', 'discard'],
    ['fetch', 'file:D:\\sounds\\pack\\discard.ogg'],
  ])
  assert.deepEqual(result, { url: 'file:D:\\sounds\\pack\\discard.ogg' })
})

test('sound protocol rejects malformed and unresolved resources without fetching', async () => {
  for (const url of [
    'rms-sound://other/default/discard',
    'rms-sound://audio/default',
    'rms-sound://audio/default/discard/extra',
    'rms-sound://audio/default/%E0%A4%A',
  ]) {
    const fixture = createFixture()
    const response = fixture.getHandler()({ url })
    assert.equal(response.status, 404)
    assert.equal(await response.text(), 'Sound not found')
    assert.equal(fixture.calls.some(([name]) => name === 'fetch'), false)
  }

  const unresolved = createFixture({ resolvedPath: '' })
  const response = unresolved.getHandler()({ url: 'rms-sound://audio/default/discard' })
  assert.equal(response.status, 404)
  assert.equal(unresolved.calls.some(([name]) => name === 'fetch'), false)
})
