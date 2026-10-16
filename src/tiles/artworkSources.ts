const HONOR_ASSETS: Readonly<Record<string, string>> = { E: '1z', S: '2z', W: '3z', N: '4z', P: '5z', F: '6z', C: '7z' }

export function tileArtworkAssetName(tile: string): string {
  if (!tile || tile === '?') return 'back'
  const normalized = tile.replace('r', '')
  if (HONOR_ASSETS[normalized]) return HONOR_ASSETS[normalized]
  if (normalized[0] === '5' && tile.endsWith('r')) return `0${normalized[1]}`
  return `${normalized[0]}${normalized[1]}`
}

/** One decoded source per asset, shared by the browser's native image renderer. */
export function preloadArtworkSources(
  sources: readonly string[],
  onLoaded: () => void,
  createImage: () => HTMLImageElement = () => new Image(),
) {
  const images: HTMLImageElement[] = []
  const pending = new Set<() => void>()
  let disposed = false
  const ready = Promise.all([...new Set(sources)].map(source => new Promise<void>(resolve => {
    const image = createImage()
    image.decoding = 'async'
    images.push(image)
    let settled = false, decoding = false
    const finish = () => {
      if (settled) return
      settled = true
      image.onload = image.onerror = null
      pending.delete(finish)
      if (!disposed) onLoaded()
      resolve()
    }
    const loaded = () => {
      if (settled || decoding || disposed) return
      decoding = true
      if (typeof image.decode === 'function') void image.decode().then(finish, finish)
      else finish()
    }
    pending.add(finish)
    image.onload = loaded
    image.onerror = finish
    image.src = source
    if (image.complete) {
      if (image.naturalWidth > 0) loaded()
      else finish()
    }
  }))).then(() => !disposed)

  return {
    ready,
    dispose() {
      if (disposed) return
      disposed = true
      pending.forEach(finish => finish())
      images.forEach(image => { image.onload = image.onerror = null; image.src = '' })
      images.length = 0
    },
  }
}
