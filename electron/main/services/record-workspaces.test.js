const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRecordWorkspaces } = require('./record-workspaces')

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rms-workspace-owner-'))
  const managers = []
  context.after(async () => {
    for (const manager of managers) await manager.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  })
  const make = options => {
    const manager = createRecordWorkspaces(root, options)
    managers.push(manager)
    return manager
  }
  return { root, make }
}

test('logical claims exclude other live mains even after backend release, until explicit retirement', async context => {
  const { make } = await fixture(context)
  const first = make(), second = make()
  const id = await first.allocate()
  await first.activate(id)
  await first.released({ workspaceId: id })
  const candidates = await second.recoverable()
  assert.equal(candidates.length, 1)
  await assert.rejects(second.claimRecovery(candidates[0]), error => error.code === 'EADDRINUSE')
  await first.discardActive()
  assert.deepEqual(await second.recoverable(), [])
})

test('clean retention keeps only the descriptor after the writer has actually released', async context => {
  const { root, make } = await fixture(context)
  const owner = make()
  const id = await owner.allocate()
  await owner.activate(id)
  await fs.writeFile(path.join(root, id, 'workspace.sqlite'), 'released backing')
  await fs.writeFile(path.join(root, id, 'source.mjstudio'), 'released source')
  const recovery = { kind: 'source', path: 'example.mjstudio', fileIdentity: { size: 12, prefix: 'test' } }
  await owner.retainClose(id, recovery)
  await owner.released({ workspaceId: id, disposition: 'retention-off' })
  const manifest = JSON.parse(await fs.readFile(path.join(root, id, 'owner.json'), 'utf8'))
  assert.equal(manifest.status, 'retained')
  assert.deepEqual(manifest.recovery, recovery)
  assert.deepEqual(await fs.readdir(path.join(root, id)), ['owner.json'])
  assert.equal(owner.getActive(), null)
})

test('retention preference changes do not overwrite a newer serialized disposition', async context => {
  const { root, make } = await fixture(context)
  let retain = true
  const owner = make({ retain: () => retain })
  const id = await owner.allocate()
  await owner.activate(id)
  retain = false
  const setting = owner.updateRetention()
  const close = owner.retainClose(id, null)
  await Promise.all([setting, close])
  const manifest = JSON.parse(await fs.readFile(path.join(root, id, 'owner.json'), 'utf8'))
  assert.equal(manifest.status, 'retention-off')
  assert.equal(manifest.retain, false)
  assert.equal(manifest.recovery, null)
  await owner.released({ workspaceId: id })
  assert.deepEqual(await fs.readdir(root), [])
})

test('a failed restore releases its claim without deleting retained data', async context => {
  const { root, make } = await fixture(context)
  const first = make()
  const id = await first.allocate()
  await first.activate(id)
  await first.retainClose(id, { kind: 'workspace', workspaceId: id })
  await first.shutdown()
  const second = make()
  const [manifest] = await second.recoverable()
  await second.claimRecovery(manifest)
  await second.abandon(id, { existing: true })
  assert.equal(JSON.parse(await fs.readFile(path.join(root, id, 'owner.json'), 'utf8')).status, 'retained')
  assert.equal((await second.recoverable()).length, 1)
})
