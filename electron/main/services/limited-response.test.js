const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readLimitedResponseText } = require('./limited-response')

function streamResponse(chunks, headers = {}) {
  let pulls = 0
  let cancelled = false
  const body = new ReadableStream({
    pull(controller) {
      const chunk = chunks[pulls++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  return { response: new Response(body, { headers }), pulls: () => pulls, cancelled: () => cancelled }
}

test('bounded response decoding preserves UTF-8 split across chunks at the exact byte limit', async () => {
  const original = '牌譜🀄日本語'
  const bytes = new TextEncoder().encode(original)
  const fixture = streamResponse([...bytes].map(byte => Uint8Array.of(byte)))
  assert.equal(await readLimitedResponseText(fixture.response, bytes.length, 'too large'), original)
  assert.equal(fixture.cancelled(), false)
})

test('oversized advertised bodies are cancelled before reading', async () => {
  const fixture = streamResponse([Uint8Array.of(1)], { 'content-length': '100' })
  await assert.rejects(readLimitedResponseText(fixture.response, 10, 'too large'), /too large/)
  assert.equal(fixture.pulls(), 0)
  assert.equal(fixture.cancelled(), true)
})

test('missing or understated lengths cannot bypass the byte limit', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    const fixture = streamResponse([new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)], headers)
    await assert.rejects(readLimitedResponseText(fixture.response, 10, 'too large'), /too large/)
    assert.equal(fixture.pulls(), 2)
    assert.equal(fixture.cancelled(), true)
  }
})

test('stream failures are propagated and the reader is released', async () => {
  const failure = new Error('connection interrupted')
  const body = new ReadableStream({ pull(controller) { controller.error(failure) } })
  await assert.rejects(readLimitedResponseText(new Response(body), 10, 'too large'), error => error === failure)
  assert.equal(body.locked, false)
})

test('empty response bodies decode to empty text', async () => {
  assert.equal(await readLimitedResponseText(new Response(null), 10, 'too large'), '')
})
