const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { acquireRecordLease } = require('./record-live-lease')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RETIRED = new Set(['discarded', 'replaced', 'retention-off'])

/** Enduring main-owned claims. Backend death never releases these leases. */
function createRecordWorkspaces(root, { retain = () => true, acquireLease = acquireRecordLease } = {}) {
  root = path.resolve(root)
  const claims = new Map()
  let active = null
  let manifestTail = Promise.resolve()
  const releases = new Set()

  function directory(id) {
    if (!UUID.test(id)) throw new Error('Invalid private workspace identity.')
    const target = path.join(root, id)
    if (path.dirname(target) !== root) throw new Error('Workspace escaped its managed directory.')
    return target
  }

  function persist(claim, changes) {
    const operation = manifestTail.catch(() => {}).then(async () => {
      const manifest = { ...claim.manifest, ...changes, updatedAt: Date.now() }
      claim.lease.assertOwned()
      const folder = directory(manifest.workspaceId)
      await fs.mkdir(folder, { recursive: true })
      const target = path.join(folder, 'owner.json')
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        const file = await fs.open(temporary, 'wx')
        try { await file.writeFile(`${JSON.stringify(manifest)}\n`); await file.sync() } finally { await file.close() }
        await fs.rename(temporary, target)
        claim.manifest = manifest
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
    })
    manifestTail = operation
    return operation
  }

  async function allocate() {
    const workspaceId = randomUUID()
    const lease = await acquireLease('workspace', workspaceId)
    const claim = { lease, manifest: { version: 1, workspaceId }, backendReleased: false }
    claims.set(workspaceId, claim)
    try {
      await persist(claim, { status: 'prepared', retain: Boolean(retain()), recovery: { kind: 'workspace', workspaceId } })
      return workspaceId
    } catch (error) { claims.delete(workspaceId); await lease.release(); throw error }
  }

  async function activate(id, { previous = active, saved = null } = {}) {
    const claim = claims.get(id)
    if (!claim) throw new Error('Main does not own the prepared workspace.')
    await persist(claim, { status: 'active', retain: Boolean(retain()), saved,
      recovery: { kind: 'workspace', workspaceId: id } })
    active = id
    if (previous && previous !== id && claims.has(previous)) {
      await persist(claims.get(previous), { status: 'replaced', recovery: null })
      await releaseIfRetired(previous)
    }
    return previous
  }

  async function abandon(id, { existing = false } = {}) {
    const claim = claims.get(id)
    if (!claim) return
    if (!existing) await persist(claim, { status: 'discarded', recovery: null })
    if (active === id) active = null
    // Only newly abandoned candidates with no backend owner may be removed.
    // Failed restores preserve their existing recovery descriptor and bytes.
    if (existing || claim.backendReleased) {
      claims.delete(id)
      await claim.lease.release()
    }
  }

  async function retainClose(id, recovery) {
    const claim = claims.get(id)
    if (active !== id || !claim) throw new Error('Close belongs to another active workspace.')
    await persist(claim, { status: recovery ? 'retained' : 'retention-off',
      retain: Boolean(recovery), recovery })
  }

  async function cancelClose(id) {
    const claim = claims.get(id)
    if (active === id && claim) await persist(claim, { status: 'active', retain: Boolean(retain()),
      recovery: { kind: 'workspace', workspaceId: id } })
  }

  async function discardActive() {
    const id = active
    if (!id) return
    const claim = claims.get(id)
    await persist(claim, { status: 'discarded', recovery: null })
    active = null
    await releaseIfRetired(id)
  }

  async function releaseIfRetired(id) {
    const claim = claims.get(id)
    if (!claim || !claim.backendReleased || claim.manifest.status === 'active' || claim.manifest.status === 'prepared') return
    claims.delete(id)
    if (active === id) active = null
    try {
      // A clean source descriptor still lives here after its DB is retired.
      if (RETIRED.has(claim.manifest.status)) await fs.rm(directory(id), { recursive: true, force: true })
      else if (claim.manifest.recovery?.kind === 'source') {
        for (const name of ['workspace.sqlite', 'workspace.sqlite-wal', 'workspace.sqlite-shm',
          'workspace.sqlite.lock', 'source.mjstudio']) {
          await fs.rm(path.join(directory(id), name), { force: true })
        }
      }
    } finally { await claim.lease.release() }
  }

  async function releaseBackendClaim(event) {
    const claim = claims.get(event.workspaceId)
    if (!claim) return
    claim.backendReleased = true
    if (event.retirementError) throw new Error(event.retirementError)
    await releaseIfRetired(event.workspaceId)
  }

  function released(event) {
    const release = releaseBackendClaim(event)
    releases.add(release)
    const finished = () => releases.delete(release)
    release.then(finished, finished)
    return release
  }

  async function recoverable() {
    if (!retain()) return []
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const candidates = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID.test(entry.name) || claims.has(entry.name)) continue
      let manifest
      try {
        const file = path.join(directory(entry.name), 'owner.json')
        if ((await fs.stat(file)).size > 64 * 1024) continue
        manifest = JSON.parse(await fs.readFile(file, 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn('[record] unreadable recovery descriptor:', entry.name, error.message)
        continue
      }
      if (manifest.version === 1 && manifest.workspaceId === entry.name && manifest.retain
        && ['active', 'retained'].includes(manifest.status) && manifest.recovery) candidates.push(manifest)
    }
    return candidates.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async function claimRecovery(manifest) {
    if (claims.has(manifest.workspaceId)) throw new Error('Recovery is already claimed.')
    const lease = await acquireLease('workspace', manifest.workspaceId)
    claims.set(manifest.workspaceId, { lease, manifest, backendReleased: false })
    return manifest
  }

  async function updateRetention() {
    const claim = claims.get(active)
    if (claim) await persist(claim, { retain: Boolean(retain()) })
  }

  async function consumeRecovery(id) {
    const claim = claims.get(id)
    if (!claim) return
    await persist(claim, { status: 'replaced', recovery: null })
    claim.backendReleased = true // A claimed source descriptor has no backend writer.
    await releaseIfRetired(id)
  }

  async function shutdown() {
    await manifestTail.catch(() => {})
    await Promise.allSettled([...releases])
    for (const claim of claims.values()) await claim.lease.release()
    claims.clear()
    active = null
  }

  return { allocate, activate, abandon, retainClose, cancelClose, discardActive, released,
    recoverable, claimRecovery, consumeRecovery, updateRetention, shutdown, getActive: () => active,
    getManifest: id => claims.get(id)?.manifest }
}

module.exports = { createRecordWorkspaces }
