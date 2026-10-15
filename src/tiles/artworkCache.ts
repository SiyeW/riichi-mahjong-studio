export const ARTWORK_CACHE_VERSION = 1
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
    && Number.isSafeInteger(entry.pixelWidth) && entry.pixelWidth >= width && entry.pixelWidth <= maximumWidth
    && entry.pixelHeight === Math.ceil(entry.pixelWidth * 4 / 3)
    && entry.blob instanceof Blob && entry.blob.type === 'image/svg+xml'
    && entry.blob.size > 0 && entry.blob.size <= entry.pixelWidth * entry.pixelHeight * 8 + 1024)
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

export async function rasterizeTileArtwork(id: string, sourceHash: string, image: HTMLImageElement, width: number): Promise<CachedTileArtwork> {
  // Retain the source's intrinsic geometry. CSS padding, inset, corner radius,
  // brightness and interactive tone remain live and are never baked in.
  if (image.naturalWidth !== 300 || image.naturalHeight !== 400) throw new Error('Unexpected tile artwork geometry')
  const height = Math.ceil(width * 4 / 3)
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Artwork canvas unavailable')
  context.drawImage(image, 0, 0, width, height)
  const png = await canvas.convertToBlob({ type: 'image/png' })
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(png)
  })
  // A bitmap-only <img> takes a different intrinsic-fitting/paint path in Blink.
  // Preserve the original SVG viewport while replacing its expensive paths by
  // one image. The child's none fit prevents rounded PNG height letterboxing.
  const blob = new Blob([
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400">',
    `<image width="300" height="400" preserveAspectRatio="none" href="${data}"/></svg>`,
  ], { type: 'image/svg+xml' })
  return { id, sourceHash, version: ARTWORK_CACHE_VERSION, pixelWidth: width, pixelHeight: height, blob }
}
