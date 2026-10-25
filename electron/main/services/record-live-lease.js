const net = require('node:net')
const { createHash } = require('node:crypto')

const KINDS = new Set(['workspace', 'save-target', 'legacy-recovery'])

function leaseEndpoint(kind, identity, platform = process.platform) {
  if (!KINDS.has(kind) || typeof identity !== 'string' || !identity) {
    throw new Error('Invalid record lease identity.')
  }
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 40)
  if (platform === 'win32') return `\\\\.\\pipe\\rms-${kind}-${hash}`
  if (platform === 'linux') return `\0rms-${kind}-${hash}`
  throw new Error('Live record leases require Windows or Linux.')
}

/** Main keeps this OS-owned endpoint across backend crashes/restarts.
 * It carries no data and opens no port; process exit releases the identity.
 * The backend writer also holds its independent DB lease until actual exit.
 */
function acquireRecordLease(kind, identity, { platform = process.platform } = {}) {
  const endpoint = leaseEndpoint(kind, identity, platform)
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.destroy())
    let failure = null
    let released = false
    let closing = null
    const failed = error => {
      server.removeListener('listening', ready)
      server.close(() => {})
      reject(error)
    }
    const ready = () => {
      server.removeListener('error', failed)
      server.on('error', error => { failure = error })
      server.unref()
      resolve({
        assertOwned() {
          if (released || failure || !server.listening) throw failure || new Error('Record lease is no longer owned.')
        },
        release() {
          if (closing) return closing
          released = true
          closing = new Promise((done, fail) => server.close(error => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') fail(error)
            else done()
          }))
          return closing
        },
      })
    }
    server.once('error', failed)
    server.once('listening', ready)
    server.listen(endpoint)
  })
}

module.exports = { acquireRecordLease, leaseEndpoint }
