const { pathToFileURL } = require('node:url')
const { discoverSoundPacks, resolveSoundPackFile } = require('../state/sound-pack-registry')

function registerSoundProtocol({
  protocol,
  net,
  appOptions,
  discoverSoundPacksImpl = discoverSoundPacks,
  resolveSoundPackFileImpl = resolveSoundPackFile,
  pathToFileURLImpl = pathToFileURL,
}) {
  protocol.handle('rms-sound', (request) => {
    try {
      const requestUrl = new URL(request.url)
      const parts = requestUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (requestUrl.hostname !== 'audio' || parts.length !== 2) {
        return new Response('Sound not found', { status: 404 })
      }
      const filePath = resolveSoundPackFileImpl(
        discoverSoundPacksImpl(appOptions),
        parts[0],
        parts[1],
      )
      if (!filePath) return new Response('Sound not found', { status: 404 })
      return net.fetch(pathToFileURLImpl(filePath).toString())
    } catch {
      return new Response('Sound not found', { status: 404 })
    }
  })
}

module.exports = { registerSoundProtocol }
