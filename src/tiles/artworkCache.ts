export const ARTWORK_CACHE_VERSION = 2
const DATABASE_NAME = 'rms-tile-artwork'
const STORE_NAME = 'faces'

export interface CachedTileArtwork {
  id: string
  sourceHash: string
  version: number
  pixelWidth: number
  pixelHeight: number
  blob: Blob
}

export function sufficientArtwork(
  entry: CachedTileArtwork | undefined,
  hash: string,
  width: number,
  maximumWidth: number,
): entry is CachedTileArtwork {
  return Boolean(entry && entry.version === ARTWORK_CACHE_VERSION && entry.sourceHash === hash
    && Number.isSafeInteger(entry.pixelWidth) && entry.pixelWidth % 3 === 0
    && entry.pixelWidth >= width && entry.pixelWidth <= maximumWidth
    && entry.pixelHeight === entry.pixelWidth * 4 / 3
    && entry.blob instanceof Blob && entry.blob.type === 'image/png'
    && entry.blob.size > 0 && entry.blob.size <= entry.pixelWidth * entry.pixelHeight * 8 + 1024)
}

export async function artworkPngHeaderMatches(entry: CachedTileArtwork): Promise<boolean> {
  // Check dimensions before asking the decoder to allocate a cached image.
  const bytes = await entry.blob.slice(0, 24).arrayBuffer()
  if (bytes.byteLength !== 24) return false
  const header = new DataView(bytes)
  return header.getUint32(0) === 0x89504e47 && header.getUint32(4) === 0x0d0a1a0a
    && header.getUint32(8) === 13 && header.getUint32(12) === 0x49484452
    && header.getUint32(16) === entry.pixelWidth && header.getUint32(20) === entry.pixelHeight
}

// This is disposable acceleration data, not user content or a close barrier.
// Failure/blocked storage is deliberately equivalent to an empty cache.
export function openArtworkCache() {
  let closed = false
  const database = new Promise<IDBDatabase | null>(resolve => {
    let settled = false
    const finish = (value: IDBDatabase | null) => {
      if (settled) { value?.close(); return }
      settled = true
      clearTimeout(timer)
      if (closed) value?.close()
      resolve(closed ? null : value)
    }
    const timer = setTimeout(() => finish(null), 2000)
    try {
      const request = indexedDB.open(DATABASE_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        finish(request.result)
      }
      request.onerror = () => finish(null)
      request.onblocked = () => finish(null)
    } catch { finish(null) }
  })

  async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    const db = await database
    if (!db || closed) return undefined
    return new Promise(resolve => {
      let settled = false
      let tx: IDBTransaction | undefined
      const finish = (value?: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => { try { tx?.abort() } catch { /* Already finished. */ } finish() }, 2000)
      try {
        tx = db.transaction(STORE_NAME, mode)
        const request = operation(tx.objectStore(STORE_NAME))
        tx.oncomplete = () => finish(request.result)
        tx.onerror = tx.onabort = () => finish()
      } catch { finish() }
    })
  }

  return {
    read: (id: string) => transaction<CachedTileArtwork | undefined>('readonly', store => store.get(id)),
    write: (entry: CachedTileArtwork) => transaction('readwrite', store => store.put(entry)),
    close: () => { closed = true; void database.then(db => db?.close()) },
  }
}

export async function artworkSourceHash(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}

export async function decodeArtwork(src: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.decoding = 'async'
  image.src = src
  await image.decode()
  return image
}

export function createTileArtworkRasterizer(width: number) {
  if (width % 3 !== 0) throw new Error('Artwork pixels must preserve the source aspect')
  const height = width * 4 / 3
  const canvas = new OffscreenCanvas(width, height)
  // Our output is CPU PNG bytes, not a display surface. Avoid a GPU readback
  // and one graphics resource per face; reuse one bounded scratch buffer.
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Artwork canvas unavailable')
  return {
    async rasterize(id: string, sourceHash: string, image: HTMLImageElement): Promise<CachedTileArtwork> {
      // CSS padding, inset, corner radius, brightness and interactive tone stay
      // live. Only the original face paths enter the cache.
      if (image.naturalWidth !== 300 || image.naturalHeight !== 400) throw new Error('Unexpected tile artwork geometry')
      context.clearRect(0, 0, width, height)
      context.drawImage(image, 0, 0, width, height)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      return { id, sourceHash, version: ARTWORK_CACHE_VERSION, pixelWidth: width, pixelHeight: height, blob }
    },
    close() { canvas.width = 0; canvas.height = 0 },
  }
}
