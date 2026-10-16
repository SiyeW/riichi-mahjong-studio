import { embeddedTileArtwork } from '../tiles/artworkCatalog'
import type { OpacityStop } from './integral'
import type { MotionGeometry } from './messages'

const properties = ['display', 'position', 'left', 'right', 'top', 'bottom', 'width', 'height',
  'box-sizing', 'padding', 'margin', 'float', 'transform', 'transform-origin', 'opacity', 'z-index',
  'background', 'border', 'border-radius', 'box-shadow', 'filter', 'object-fit', 'object-position', 'overflow'] as const

export interface MotionSnapshot {
  geometry: MotionGeometry; left: number; top: number; dpr: number
  planes: ImageBitmap[]; mode: 'single' | 'overlay' | 'crossfade'; stops: OpacityStop[][]
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

export async function captureMotionSnapshot(source: HTMLElement, effects: readonly Animation[], dx: number, dy: number): Promise<MotionSnapshot> {
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
  const matrix = new DOMMatrixReadOnly(rootStyle.transform === 'none' ? undefined : rootStyle.transform)
  if (!matrix.is2D) throw Error('Unsupported 3D motion source')
  const [originX, originY] = rootStyle.transformOrigin.split(' ').map(parseFloat)
  const w = borderSize(rootStyle, 'width'), h = borderSize(rootStyle, 'height')
  const corners = [[0,0],[w,0],[0,h],[w,h]].map(([x,y]) => ({
    x: matrix.a * (x! - originX!) + matrix.c * (y! - originY!) + matrix.e + originX!,
    y: matrix.b * (x! - originX!) + matrix.d * (y! - originY!) + matrix.f + originY!,
  }))
  const clone = source.cloneNode(true) as HTMLElement
  const nodes = [clone, ...clone.querySelectorAll<HTMLElement>('*')]
  nodes.forEach((node, i) => {
    for (const attribute of [...node.attributes]) if (!['src', 'style'].includes(attribute.name)) node.removeAttribute(attribute.name)
    node.style.cssText = properties.map(name => `${name}:${styles[i]!.getPropertyValue(name)};`).join('')
      + 'pointer-events:none;visibility:visible;transition:none;animation:none;'
  })
  Object.assign(clone.style, { position: 'absolute', margin: '0px', right: 'auto', bottom: 'auto', opacity: '1',
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
  await Promise.all(images.map(async image => {
    const target = nodes[originals.indexOf(image)] as HTMLImageElement
    target.src = await embeddedTileArtwork(image.src)
  }))
  const container = document.createElement('div')
  container.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
  container.style.cssText = `position:relative;width:${cropWidth}px;height:${cropHeight}px;overflow:visible`
  container.append(clone)
  const planes: ImageBitmap[] = []
  const serialize = async () => {
    const angle = -Math.atan2(axisY, axisX) * 180 / Math.PI
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${spriteWidth}" height="${spriteHeight}" viewBox="0 0 ${spriteWidth/dpr} ${spriteHeight/dpr}"><g transform="translate(${spriteWidth/dpr/2} ${spriteHeight/dpr/2}) rotate(${angle}) translate(${-cropWidth/2} ${-cropHeight/2})"><foreignObject width="${cropWidth}" height="${cropHeight}">${new XMLSerializer().serializeToString(container)}</foreignObject></g></svg>`
    const image = new Image(); image.decoding = 'async'
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
    await image.decode()
    // Chromium marks ImageBitmap(SVG foreignObject) origin-unclean even when
    // drawing the decoded data URL is clean. Transfer a clean rendered surface,
    // without PNG encoding, bytes, disk I/O or an additional image decode.
    const surface = new OffscreenCanvas(spriteWidth, spriteHeight)
    const context = surface.getContext('2d')
    if (!context) throw Error('Motion snapshot canvas unavailable')
    context.drawImage(image, 0, 0)
    planes.push(surface.transferToImageBitmap())
  }
  try {
    if (mode === 'crossfade') {
      // Native order: settled image A, regular-pose overlay B. Source-over is
      // a*A + b*B - a*b*A*Balpha; the worker prepares that product once.
      const a = opacityEffects.find(effect => originals[effect.index] instanceof HTMLImageElement)!
      const b = opacityEffects.find(effect => effect !== a)!
      if (!a || !b) throw Error('Unsupported crossfade targets')
      nodes[a.index]!.style.opacity = '1'; nodes[b.index]!.style.opacity = '0'; await serialize()
      nodes[a.index]!.style.opacity = '0'; nodes[b.index]!.style.opacity = '1'; await serialize()
      opacityEffects.splice(0, 2, a, b)
    } else if (mode === 'overlay') {
      nodes[opacityEffects[0]!.index]!.style.opacity = '0'; await serialize()
      nodes[opacityEffects[0]!.index]!.style.opacity = '1'; await serialize()
    } else await serialize()
    return { planes, mode, stops: opacityEffects.map(effect => effect.stops), left, top, dpr,
      geometry: { width, height, spriteWidth, spriteHeight, axisX, axisY,
        startX: (cropLeft + cropWidth/2 - left) * dpr, startY: (cropTop + cropHeight/2 - top) * dpr, dx: dx*dpr, dy: dy*dpr } }
  } catch (error) { planes.forEach(bitmap => bitmap.close()); throw error }
}
