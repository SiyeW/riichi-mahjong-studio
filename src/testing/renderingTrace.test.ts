import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRenderingTrace, readRenderingTrace } from './renderingTrace.ts'

test('rendering trace preserves uint64 identities before their first JSON parse', () => {
  assert.deepEqual(parseRenderingTrace('{"traceEvents":[{"id":18446744073709551615,"other":9007199254740993,"negative":-9007199254740993,"ts":2364571918543,"dur":0.125}]}'),
    [{ id: '18446744073709551615', other: '9007199254740993', negative: '-9007199254740993', ts: 2364571918543, dur: .125 }])
})

test('rendering trace rejects an absent event envelope and malformed JSON', () => {
  assert.throws(() => parseRenderingTrace('{}'), /event array/)
  assert.throws(() => parseRenderingTrace('{"traceEvents":'), SyntaxError)
})

test('raw trace stream joins text and base64 chunks and always releases its handle', async () => {
  const methods: string[] = []
  const chunks = [{ data: '{"traceEvents":[{"id":', eof: false },
    { data: Buffer.from('18446744073709551615}]}').toString('base64'), base64Encoded: true, eof: true }]
  const events = await readRenderingTrace({ send: async (method, params) => {
    methods.push(method)
    assert.equal(params.handle, 'owned-trace')
    return method === 'IO.read' ? chunks.shift() : undefined
  } }, 'owned-trace')
  assert.deepEqual(events, [{ id: '18446744073709551615' }])
  assert.deepEqual(methods, ['IO.read', 'IO.read', 'IO.close'])
})

test('trace byte limit and decode failure still close the owned stream', async () => {
  for (const [data, maximumBytes, pattern] of [['too long', 2, /byte limit/], ['{', 2, /JSON/]] as const) {
    let closed = 0
    await assert.rejects(readRenderingTrace({ send: async method => {
      if (method === 'IO.close') { closed++; return undefined }
      return { data, eof: true }
    } }, 'owned-trace', maximumBytes), pattern)
    assert.equal(closed, 1)
  }
})

test('read failure and invalid chunks release the owned trace stream', async () => {
  for (const failRead of [false, true]) {
    let closed = 0
    await assert.rejects(readRenderingTrace({ send: async method => {
      if (method === 'IO.close') { closed++; return undefined }
      if (failRead) throw new Error('Injected stream failure')
      return undefined
    } }, 'owned-trace'), failRead ? /Injected/ : /invalid chunk/)
    assert.equal(closed, 1)
  }
})
