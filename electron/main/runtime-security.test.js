const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

// Probe the bundled runtime, never the system Node or Studio's normal startup.
test('embedded Node has the DNS and Brotli security fixes and retains HTTP/TLS compatibility', () => {
  const binary = require('electron')
  const probe = String.raw`
    const assert = require('node:assert/strict')
    const dns = require('node:dns').promises
    const http = require('node:http')
    const tls = require('node:tls')
    const zlib = require('node:zlib')
    ;(async () => {
      assert.equal(zlib.constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH, -17)
      await assert.rejects(async () => dns.resolve4('invalid\0.example'), { code: 'ERR_INVALID_ARG_VALUE' })
      const certificate = { subjectaltname: 'DNS:studio.example' }
      assert.equal(tls.checkServerIdentity('studio.example', certificate), undefined)
      assert.equal(tls.checkServerIdentity('other.example', certificate).code, 'ERR_TLS_CERT_ALTNAME_INVALID')
      assert.equal(tls.checkServerIdentity('１２７.0.0.1', { subjectaltname: 'DNS:127.0.0.1' }).code,
        'ERR_TLS_CERT_ALTNAME_INVALID')
      const payload = Buffer.from(JSON.stringify({ studio: true, text: '牌譜' }))
      const compressed = zlib.brotliCompressSync(payload)
      assert.deepEqual(zlib.brotliDecompressSync(compressed), payload)
      assert.deepEqual(zlib.gunzipSync(zlib.gzipSync(payload)), payload)
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Encoding': 'br', 'Content-Type': 'application/json' })
        response.end(compressed)
      })
      try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        const result = await fetch('http://127.0.0.1:' + server.address().port)
        assert.deepEqual(await result.json(), JSON.parse(payload))
      } finally {
        server.closeAllConnections()
        if (server.listening) await new Promise(resolve => server.close(resolve))
      }
      console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node,
        chrome: process.versions.chrome, brotli: process.versions.brotli }))
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `
  const result = spawnSync(binary, ['-e', probe], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', windowsHide: true, timeout: 20_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const runtime = JSON.parse(result.stdout.trim())
  assert.equal(runtime.electron, require('electron/package.json').version,
    'installed npm metadata and the actual native runtime must agree')
  assert.equal(path.isAbsolute(binary), true)
  console.log(`Embedded runtime verified: ${JSON.stringify(runtime)}`)
})
