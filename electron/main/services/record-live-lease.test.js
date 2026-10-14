const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { acquireRecordLease, leaseEndpoint } = require('./record-live-lease')

const supported = process.platform === 'win32' || process.platform === 'linux'

test('lease identities are hashed, flat, separated by role and use no TCP port or socket file', () => {
  const identity = 'D:/用户的目录/records/private/secret.mjstudio'
  const pipe = leaseEndpoint('workspace', identity, 'win32')
  assert.ok(pipe.startsWith('\\\\.\\pipe\\rms-workspace-'))
  assert.ok(!pipe.includes('secret') && !pipe.includes('用户'))
  assert.ok(leaseEndpoint('workspace', identity, 'linux').startsWith('\0'))
  assert.notEqual(leaseEndpoint('workspace', identity, 'linux'), leaseEndpoint('save-target', identity, 'linux'))
  assert.throws(() => leaseEndpoint('arbitrary', identity), /identity/)
})

test('a live main lease excludes another owner and repeated release joins one completion', { skip: !supported }, async () => {
  const identity = randomUUID()
  const first = await acquireRecordLease('workspace', identity)
  try {
    first.assertOwned()
    await assert.rejects(acquireRecordLease('workspace', identity), { code: 'EADDRINUSE' })
    const closing = first.release()
    assert.equal(first.release(), closing)
    await closing
    assert.throws(() => first.assertOwned(), /owned/)
    const next = await acquireRecordLease('workspace', identity)
    await next.release()
  } finally {
    await first.release()
  }
})

test('OS ownership excludes another process and disappears after owner death without a PID-file guess',
  { skip: !supported, timeout: 10000 }, async t => {
    const identity = randomUUID()
    const modulePath = require.resolve('./record-live-lease')
    const code = `const { acquireRecordLease } = require(${JSON.stringify(modulePath)});
      acquireRecordLease('workspace', process.argv[1]).then(lease => {
        console.log('ready'); setInterval(() => lease.assertOwned(), 1000);
      }).catch(error => { console.error(error.code); process.exit(1) });`
    const child = spawn(process.execPath, ['-e', code, identity], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
    })
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`Lease child exited before readiness: ${code}`)))
      child.stdout.once('data', data => data.toString().includes('ready') ? resolve() : reject(new Error('Unexpected lease child response')))
    })
    await assert.rejects(acquireRecordLease('workspace', identity), { code: 'EADDRINUSE' })
    const exited = once(child, 'exit')
    child.kill()
    await exited
    const reclaimed = await acquireRecordLease('workspace', identity)
    await reclaimed.release()
  })
