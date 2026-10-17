import { embeddedTileArtwork } from '../tiles/artworkCatalog'
import type { OpacityStop } from './integral'
import type { MotionGeometry } from './messages'
import type { MotionAtlasCache } from './atlasCache'

const properties = ['display', 'position', 'left', 'right', 'top', 'bottom', 'width', 'height',
  'box-sizing', 'padding', 'margin', 'float', 'transform', 'transform-origin', 'opacity', 'z-index',
  'background', 'border', 'border-radius', 'box-shadow', 'filter', 'object-fit', 'object-position', 'overflow'] as const

export interface MotionSnapshot {
  geometry: MotionGeometry; left: number; top: number; dpr: number; opacity: string
  pixels: Uint8ClampedArray; planeCount: 1 | 2; mode: 'single' | 'overlay' | 'crossfade'; stops: OpacityStop[][]
  timings: { cssMs: number; assetsMs: number; decodeMs: number; rasterMs: number; cacheHit: boolean }
}

function shadowAllowance(style: CSSStyleDeclaration) {
  if (/blur\(|drop-shadow\(/.test(style.filter)) throw Error('Unsupported moving filter')
  let padding = 2
  for (const part of style.boxShadow.replace(/rgba?\([^)]*\)/g, '').split(',')) {
    if (/inset|none/.test(part)) continue
    const values = [...part.matchAll(/(-?[\d.]+)px/g)].map(m => Number(m[1]))
    padding = Math.max(padding, Math.abs(values[0] ?? 0) + Math.abs(values[1] ?? 0)
      + 2 * (values[2] ?? 0) + Math.max(0, values[3] ?? 0) + 2)
  }
  return padding
}

function borderSize(style: CSSStyleDeclaration, dimension: 'width' | 'height') {
  const base = parseFloat(style[dimension])
  if (style.boxSizing === 'border-box') return base
  const sides = dimension === 'width' ? ['left', 'right'] : ['top', 'bottom']
  return base + sides.reduce((sum, side) => sum + parseFloat(style.getPropertyValue(`padding-${side}`))
    + parseFloat(style.getPropertyValue(`border-${side}-width`)), 0)
}

export async function captureMotionSnapshot(source: HTMLElement, effects: readonly Animation[], dx: number, dy: number, cache?: MotionAtlasCache): Promise<MotionSnapshot> {
  const began = performance.now()
  const cacheGeneration = cache?.generation
  const distance = Math.hypot(dx, dy), dpr = devicePixelRatio
  if (!source.isConnected || distance < 1 || !Number.isFinite(distance) || !(dpr > 0)) throw Error('Invalid motion geometry')
  const originals = [source, ...source.querySelectorAll<HTMLElement>('*')]
  const styles = originals.map(node => getComputedStyle(node))
  const images = originals.filter((node): node is HTMLImageElement => node instanceof HTMLImageElement)
  if (!images.length) throw Error('Motion source has no artwork')
  const rects = images.map(node => node.getBoundingClientRect())
  const allowance = Math.max(...styles.map(shadowAllowance))
  const cropLeft = Math.floor((Math.min(...rects.map(r => r.left)) - allowance) * dpr) / dpr
  const cropTop = Math.floor((Math.min(...rects.map(r => r.top)) - allowance) * dpr) / dpr
  const cropWidth = Math.ceil((Math.max(...rects.map(r => r.right)) + allowance - cropLeft) * dpr) / dpr
  const cropHeight = Math.ceil((Math.max(...rects.map(r => r.bottom)) + allowance - cropTop) * dpr) / dpr
  const snapAxis = (value: number) => Math.abs(value) < 1e-12 ? 0 : value
  const axisX = snapAxis(dx / distance), axisY = snapAxis(dy / distance)
  const spriteWidth = Math.ceil((Math.abs(axisX) * cropWidth + Math.abs(axisY) * cropHeight) * dpr)
  const spriteHeight = Math.ceil((Math.abs(axisY) * cropWidth + Math.abs(axisX) * cropHeight) * dpr)
  if (spriteWidth * spriteHeight > 1_000_000) throw Error('Motion snapshot exceeds bounded size')
  const endLeft = cropLeft + dx, endTop = cropTop + dy
  const left = Math.floor(Math.min(cropLeft, endLeft) * dpr) / dpr
  const top = Math.floor(Math.min(cropTop, endTop) * dpr) / dpr
  const width = Math.ceil((Math.max(cropLeft, endLeft) + cropWidth - left) * dpr)
  const height = Math.ceil((Math.max(cropTop, endTop) + cropHeight - top) * dpr)
  if (width * height > 4_000_000) throw Error('Motion sweep exceeds bounded size')

  // Derive layout origin before cloning. getBoundingClientRect already includes
  // the paused start transform; copying that transform must not apply it twice.
  const rootStyle = styles[0]!, rootRect = source.getBoundingClientRect()
  const rootOpacity = rootStyle.opacity
  const matrix = new DOMMatrixReadOnly(rootStyle.transform === 'none' ? undefined : rootStyle.transform)
  if (!matrix.is2D) throw Error('Unsupported 3D motion source')
  const [originX, originY] = rootStyle.transformOrigin.split(' ').map(parseFloat)
  const boxWidth = borderSize(rootStyle, 'width'), boxHeight = borderSize(rootStyle, 'height')
  const corners = [[0,0],[boxWidth,0],[0,boxHeight],[boxWidth,boxHeight]].map(([x,y]) => ({
    x: matrix.a * (x! - originX!) + matrix.c * (y! - originY!) + originX!,
    y: matrix.b * (x! - originX!) + matrix.d * (y! - originY!) + originY!,
  }))
  const clone = source.cloneNode(true) as HTMLElement
  const nodes = [clone, ...clone.querySelectorAll<HTMLElement>('*')]
  nodes.forEach((node, i) => {
    for (const attribute of [...node.attributes]) if (!['src', 'style'].includes(attribute.name)) node.removeAttribute(attribute.name)
    node.style.cssText = properties.map(name => `${name}:${styles[i]!.getPropertyValue(name)};`).join('')
      + 'pointer-events:none;visibility:visible;transition:none;animation:none;'
  })
  Object.assign(clone.style, { position: 'absolute', margin: '0px', right: 'auto', bottom: 'auto', opacity: '1',
    // Translation belongs to flight geometry, not decorated atlas identity.
    // The rect already contains that translation; preserve only rotation/scale.
    transform: `matrix(${matrix.a},${matrix.b},${matrix.c},${matrix.d},0,0)`,
    left: `${rootRect.left - Math.min(...corners.map(p => p.x)) - cropLeft}px`,
    top: `${rootRect.top - Math.min(...corners.map(p => p.y)) - cropTop}px` })

  const opacityEffects = effects.map(animation => {
    if (!(animation.effect instanceof KeyframeEffect)) throw Error('Unsupported motion effect')
    const index = originals.indexOf(animation.effect.target as HTMLElement)
    const stops = animation.effect.getKeyframes().map(key => ({ offset: key.computedOffset, value: Number(key.opacity) }))
    if (index < 0 || stops.some(stop => !Number.isFinite(stop.value))) throw Error('Unsupported opacity effect')
    return { index, stops }
  })
  if (opacityEffects.length > 2) throw Error('Unsupported pose count')
  const mode = opacityEffects.length === 2 ? 'crossfade' : opacityEffects.length === 1 ? 'overlay' : 'single'
  // Freeze all geometry/CSS before the asynchronous asset loads. Only bundled
  // sources are embedded; file:// never goes through fetch or an encoded PNG.
  const assetsStarted = performance.now()
  await Promise.all(images.map(async image => {
    const target = nodes[originals.indexOf(image)] as HTMLImageElement
    target.src = await embeddedTileArtwork(image.src)
  }))
  const assetsFinished = performance.now()
  const timings = { cssMs: assetsStarted - began, assetsMs: assetsFinished - assetsStarted, decodeMs: 0, rasterMs: 0, cacheHit: false }
  const container = document.createElement('div')
  container.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
  container.style.cssText = `position:relative;width:${cropWidth}px;height:${cropHeight}px;overflow:visible`
  container.append(clone)
  const planes: string[] = []
  const serialize = () => { planes.push(new XMLSerializer().serializeToString(container)) }
  if (mode === 'crossfade') {
    // Native order: settled image A, regular-pose overlay B. Source-over is
    // a*A + b*B - a*b*A*Balpha; the worker prepares that product once.
    const a = opacityEffects.find(effect => originals[effect.index] instanceof HTMLImageElement)!
    const b = opacityEffects.find(effect => effect !== a)!
    if (!a || !b) throw Error('Unsupported crossfade targets')
    nodes[a.index]!.style.opacity = '1'; nodes[b.index]!.style.opacity = '0'; serialize()
    nodes[a.index]!.style.opacity = '0'; nodes[b.index]!.style.opacity = '1'; serialize()
    opacityEffects.splice(0, 2, a, b)
  } else if (mode === 'overlay') {
    nodes[opacityEffects[0]!.index]!.style.opacity = '0'; serialize()
    nodes[opacityEffects[0]!.index]!.style.opacity = '1'; serialize()
  } else serialize()
  // Both poses share one decoded atlas and one CPU raster/read. The integral
  // worker needs pixels anyway: transfer that buffer, not an intermediate bitmap
  // which it would have to draw and read again. No encoded output or disk cache.
  const angle = -Math.atan2(axisY, axisX) * 180 / Math.PI
  const w = spriteWidth/dpr, h = spriteHeight/dpr
  const atlas = planes.map((html, i) => `<svg y="${i*h}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="hidden">`
    + `<g transform="translate(${w/2} ${h/2}) rotate(${angle}) translate(${-cropWidth/2} ${-cropHeight/2})">`
    + `<foreignObject width="${cropWidth}" height="${cropHeight}">${html}</foreignObject></g></svg>`).join('')
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${spriteWidth}" height="${spriteHeight*planes.length}" viewBox="0 0 ${w} ${h*planes.length}">${atlas}</svg>`
  const rasterize = async () => {
    const image = new Image(); image.decoding = 'async'
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
    const decodeStarted = performance.now()
    await image.decode()
    const decoded = performance.now()
    timings.decodeMs = decoded - decodeStarted
    const surface = new OffscreenCanvas(spriteWidth, spriteHeight*planes.length)
    // The next operation is a pixel read, so this small staging surface must stay
    // CPU-backed rather than force a shared-compositor GPU raster/readback roundtrip.
    const context = surface.getContext('2d', { willReadFrequently: true })
    if (!context) throw Error('Motion snapshot canvas unavailable')
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, surface.width, surface.height).data
    timings.rasterMs = performance.now() - decoded
    return pixels
  }
  const result = cache ? await cache.read(markup, rasterize, cacheGeneration) : { pixels: await rasterize(), hit: false }
  const pixels = result.pixels
  timings.cacheHit = result.hit
  return { pixels, planeCount: mode === 'single' ? 1 : 2, mode, stops: opacityEffects.map(effect => effect.stops),
    left, top, dpr, opacity: rootOpacity, timings,
    geometry: { width, height, spriteWidth, spriteHeight, axisX, axisY,
      startX: (cropLeft + cropWidth/2 - left) * dpr, startY: (cropTop + cropHeight/2 - top) * dpr, dx: dx*dpr, dy: dy*dpr } }
}
