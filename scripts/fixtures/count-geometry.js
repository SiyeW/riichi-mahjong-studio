export function checkCountGeometryPhases() {
  const grid = document.querySelector('.analysis-count-grid')
  if (!grid) throw Error('Count geometry fixture requires a populated count panel')
  const component = grid.__vueParentComponent.setupState
  const operations = []
  const getRect = Element.prototype.getBoundingClientRect, getStyle = window.getComputedStyle
  const setProperty = CSSStyleDeclaration.prototype.setProperty
  const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')
  const height = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height')
  const oldTileWidth = grid.style.getPropertyValue('--analysis-tile-width')
  let measuring = false
  try {
    grid.style.removeProperty('--analysis-tile-width')
    for (const canvas of grid.querySelectorAll('canvas')) canvas.width = 1
    Element.prototype.getBoundingClientRect = function (...args) {
      if (measuring) operations.push('read')
      return getRect.apply(this, args)
    }
    window.getComputedStyle = (...args) => { if (measuring) operations.push('read'); return getStyle(...args) }
    CSSStyleDeclaration.prototype.setProperty = function (...args) {
      if (measuring && this === grid.style) operations.push('css')
      return setProperty.apply(this, args)
    }
    for (const [name, descriptor] of [['width', width], ['height', height]]) {
      Object.defineProperty(HTMLCanvasElement.prototype, name, { ...descriptor, set(value) {
        if (measuring && grid.contains(this)) operations.push('bitmap')
        descriptor.set.call(this, value)
      } })
    }
    measuring = true
    component.updateCountBarGeometry()
    measuring = false
    const firstCss = operations.indexOf('css'), lastCss = operations.lastIndexOf('css')
    const firstBitmap = operations.indexOf('bitmap'), lastRead = operations.lastIndexOf('read')
    if (firstCss < 0 || firstBitmap < 0) throw Error('Geometry test did not exercise CSS and bitmap writes')
    if (operations.slice(firstCss, lastCss + 1).includes('read')) throw Error('Count CSS mutation is interleaved with layout reads')
    if (firstBitmap <= lastRead) throw Error('A canvas size mutation preceded another geometry read')
    component.renderCountCanvases()
    return { cssWrites: operations.filter(op => op === 'css').length,
      bitmapWrites: operations.filter(op => op === 'bitmap').length,
      reads: operations.filter(op => op === 'read').length, cssBatch: true, bitmapBatch: true }
  } finally {
    measuring = false
    Element.prototype.getBoundingClientRect = getRect; window.getComputedStyle = getStyle
    CSSStyleDeclaration.prototype.setProperty = setProperty
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', width)
    Object.defineProperty(HTMLCanvasElement.prototype, 'height', height)
    if (oldTileWidth) grid.style.setProperty('--analysis-tile-width', oldTileWidth)
    else grid.style.removeProperty('--analysis-tile-width')
    component.updateCountBarGeometry(); component.renderCountCanvases()
  }
}
