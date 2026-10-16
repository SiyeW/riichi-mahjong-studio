import assert from 'node:assert/strict'
import test from 'node:test'
import { preloadArtworkSources, tileArtworkAssetName } from './artworkSources.ts'

function mockImages(cached = false) {
  const images: HTMLImageElement[] = [], decodes: Array<() => void> = []
  return { images, decodes, createImage: () => {
    const image = { src: '', onload: null, onerror: null, complete: cached, naturalWidth: cached ? 300 : 0,
      decode: () => new Promise<void>(resolve => decodes.push(resolve)) } as unknown as HTMLImageElement
    images.push(image)
    return image
  }, load: () => images.forEach(image => image.onload?.call(image, new Event('load'))) }
}

test('source names preserve numbered tiles, red fives, honors and hidden tiles', () => {
  for (const suit of ['m', 'p', 's']) {
    for (let rank = 1; rank <= 9; rank++) assert.equal(tileArtworkAssetName(`${rank}${suit}`), `${rank}${suit}`)
    assert.equal(tileArtworkAssetName(`5${suit}r`), `0${suit}`)
  }
  for (const [index, honor] of ['E', 'S', 'W', 'N', 'P', 'F', 'C'].entries()) assert.equal(tileArtworkAssetName(honor), `${index + 1}z`)
  assert.equal(tileArtworkAssetName('?'), 'back')
  assert.equal(tileArtworkAssetName(''), 'back')
})

test('unique sources load in parallel and readiness waits for decode', async () => {
  const mock = mockImages()
  let loaded = 0
  const preload = preloadArtworkSources(['a.svg', 'b.svg', 'a.svg'], () => loaded++, mock.createImage)
  assert.deepEqual(mock.images.map(image => image.src), ['a.svg', 'b.svg'])
  mock.load(); mock.load()
  assert.equal(mock.decodes.length, 2, 'a duplicate load signal cannot start another decode')
  assert.equal(loaded, 0)
  mock.decodes.forEach(resolve => resolve())
  assert.equal(await preload.ready, true)
  assert.equal(loaded, 2)
  preload.dispose()
  assert.ok(mock.images.every(image => image.src === '' && image.onload === null && image.onerror === null))
})

test('already loaded sources decode once and errors cannot leave readiness pending', async () => {
  const mock = mockImages(true)
  const preload = preloadArtworkSources(['cached.svg'], () => {}, mock.createImage)
  assert.equal(mock.decodes.length, 1)
  mock.decodes[0]!()
  assert.equal(await preload.ready, true)
  preload.dispose()
  const failing = mockImages()
  let loaded = 0
  const fallback = preloadArtworkSources(['missing.svg'], () => loaded++, failing.createImage)
  failing.images[0]!.onerror?.call(failing.images[0]!, new Event('error'))
  assert.equal(await fallback.ready, true)
  assert.equal(loaded, 1)
  fallback.dispose()
})

test('disposal settles pending sources and late decode cannot update a dead owner', async () => {
  for (const duringDecode of [false, true]) {
    const mock = mockImages()
    let loaded = 0
    const preload = preloadArtworkSources(['a.svg', 'b.svg'], () => loaded++, mock.createImage)
    if (duringDecode) mock.load()
    preload.dispose(); preload.dispose()
    mock.decodes.forEach(resolve => resolve())
    assert.equal(await preload.ready, false)
    assert.equal(loaded, 0)
    assert.ok(mock.images.every(image => image.src === '' && image.onload === null && image.onerror === null))
  }
})

test('a decode failure retires its source without blocking the remaining sources', async () => {
  const mock = mockImages()
  let loaded = 0
  const preload = preloadArtworkSources(['broken.svg'], () => loaded++, () => {
    const image = mock.createImage()
    image.decode = async () => { throw new Error('Injected decode failure') }
    return image
  })
  mock.load()
  assert.equal(await preload.ready, true)
  assert.equal(loaded, 1)
  preload.dispose()
})
