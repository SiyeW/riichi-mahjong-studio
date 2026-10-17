import { vPerceptualSurface, DEFAULT_PERCEPTUAL_SURFACE_TUNING, PERCEPTUAL_SURFACE_CHANGE_EVENT } from '/src/perceptualSurface.ts'

export async function checkPerceptualBatch() {
  const palette = { decisionRecommendation: [26, 147, 26], kamicha: [44, 143, 197],
    toimen: [211, 154, 58], shimocha: [76, 175, 80], selfDealIn: [201, 85, 77] }
  const binding = { palette, tuning: DEFAULT_PERCEPTUAL_SURFACE_TUNING }
  const owners = Array.from({ length: 4 }, (_, index) => {
    const element = document.createElement('div')
    element.style.cssText = `position:fixed;left:-10000px;background:rgb(${2 + index},25,30)`
    document.body.append(element)
    return element
  })
  const getStyle = window.getComputedStyle, setProperty = CSSStyleDeclaration.prototype.setProperty
  const operations = [], measured = new Set(), written = new Set(), mounted = new Set()
  let recording = true
  const mount = (element, value = binding) => {
    vPerceptualSurface.mounted(element, { value })
    mounted.add(element)
  }
  const retire = element => {
    if (mounted.delete(element)) vPerceptualSurface.beforeUnmount(element)
  }
  const settle = async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }
  try {
    window.getComputedStyle = (element, ...args) => {
      if (recording && owners.includes(element)) { operations.push('read'); measured.add(element) }
      return getStyle(element, ...args)
    }
    CSSStyleDeclaration.prototype.setProperty = function (...args) {
      const element = owners.find(owner => owner.style === this)
      if (recording && element) {
        operations.push('write'); written.add(element)
        if (written.size === 3) recording = false
      }
      return setProperty.apply(this, args)
    }
    owners.forEach(element => mount(element))
    retire(owners[3])
    await settle()
    recording = false
    if (measured.size !== 3 || written.size !== 3) throw Error('Surface batch did not exercise exactly the three live owners')
    if (operations.lastIndexOf('read') > operations.indexOf('write')) throw Error('Calibration reads and CSS writes were interleaved')
    if (owners[3].style.getPropertyValue('--analysis-score-color')) throw Error('Retired queued surface wrote styles')

    // During the write phase an event can retire another measured owner and
    // replace a third binding. Neither may receive its old measured result.
    owners.slice(0, 3).forEach(retire)
    owners.forEach(element => {
      for (const name of [...element.style]) if (name.startsWith('--')) element.style.removeProperty(name)
    })
    const updated = { ...binding, statusOnly: true, debugLabel: 'replacement' }
    owners[0].addEventListener(PERCEPTUAL_SURFACE_CHANGE_EVENT, () => {
      retire(owners[1])
      vPerceptualSurface.updated(owners[2], { value: updated, oldValue: binding })
    }, { once: true })
    owners.slice(0, 3).forEach(element => mount(element))
    await settle(); await settle()
    if (owners[1].style.getPropertyValue('--analysis-score-color')) throw Error('Retired measured owner received obsolete colors')
    if (owners[2].style.getPropertyValue('--analysis-score-color')
      || !owners[2].style.getPropertyValue('--engine-status-loaded')
      || owners[2].dataset.perceptualSurfaceLabel !== 'replacement') throw Error('Replaced binding received obsolete calibration')
    return { liveOwners: measured.size, readThenWrite: true, queuedRetirement: true, measuredRetirement: true, bindingReplacement: true }
  } finally {
    window.getComputedStyle = getStyle
    CSSStyleDeclaration.prototype.setProperty = setProperty
    owners.forEach(element => { retire(element); element.remove() })
  }
}
