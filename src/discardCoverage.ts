import { getUiMotionEasing, getUiMotionEasingFunction } from './uiMotion'
import { flightTranslationFrames, planDiscardCoverage } from './discardCoverageModel'

export interface DiscardCoverage { duration: number; startTime: number; cancel(): void }

// Freeze the existing tile primitive, including river/hand pose and decoration.
// No serialization, image export, alternate tile painter or per-frame DOM writes.
const visualProperties = ['display', 'position', 'left', 'right', 'top', 'bottom',
  'width', 'height', 'box-sizing', 'padding', 'margin', 'float', 'transform',
  'transform-origin', 'opacity', 'z-index', 'background', 'border', 'border-radius',
  'box-shadow', 'filter', 'object-fit', 'object-position', 'overflow'] as const

export function prepareDiscardCoverage(options: {
  source: HTMLElement; image: HTMLElement; effects: Animation[]; duration: number;
  exposure: number; fromX: number; fromY: number; toX: number; toY: number;
}): DiscardCoverage | null {
  const { source, image, effects, duration, exposure, fromX, fromY, toX, toY } = options
  if (!(exposure > 0) || !CSS.supports('mix-blend-mode', 'plus-lighter') || !source.isConnected
    || document.hidden || typeof source.animate !== 'function') return null
  const imageRect = image.getBoundingClientRect(), sourceRect = source.getBoundingClientRect()
  const plan = planDiscardCoverage(duration, exposure, Math.hypot(toX - fromX, toY - fromY),
    Math.min(imageRect.width, imageRect.height), getUiMotionEasingFunction())
  if (!plan) return null
  const originals = [source, ...source.querySelectorAll<HTMLElement>('*')]
  // All reads precede clone writes; computed CSS retains the canonical artwork.
  const frozen = originals.map(node => {
    const style = getComputedStyle(node)
    return visualProperties.map(name => `${name}:${style.getPropertyValue(name)};`).join('')
      + 'pointer-events:none;visibility:visible;transition:none;animation:none;'
  })
  const imageIndex = originals.indexOf(image)
  if (imageIndex < 0) return null
  const originalOpacity = source.style.getPropertyValue('opacity')
  const originalPriority = source.style.getPropertyPriority('opacity')
  const root = document.createElement('div')
  root.className = 'discard-flight-coverage'
  root.setAttribute('aria-hidden', 'true')
  root.inert = true
  const left = sourceRect.left + Math.min(fromX, toX) - 16
  const top = sourceRect.top + Math.min(fromY, toY) - 16
  root.style.cssText = `position:fixed;left:${left}px;top:${top}px;`
    + `width:${sourceRect.width + Math.abs(toX - fromX) + 32}px;`
    + `height:${sourceRect.height + Math.abs(toY - fromY) + 32}px;`
    + 'isolation:isolate;pointer-events:none;z-index:1000;'
  const samples: { wrapper: HTMLElement; delayed: HTMLElement; nodes: HTMLElement[] }[] = []
  const animations: Animation[] = []
  let disposed = false
  const cancel = () => {
    if (disposed) return
    disposed = true
    animations.forEach(animation => { animation.onfinish = null; animation.cancel() })
    root.remove()
    if (originalOpacity) source.style.setProperty('opacity', originalOpacity, originalPriority)
    else source.style.removeProperty('opacity')
    window.removeEventListener('resize', cancel)
    document.removeEventListener('pointerdown', cancel, true)
    document.removeEventListener('visibilitychange', visibility)
    observer?.disconnect()
  }
  const visibility = () => { if (document.hidden) cancel() }
  let observer: ResizeObserver | null = null
  try {
    const build = (parent: HTMLElement, count: number) => {
      if (count > 1) {
        for (let i = 0; i < 2; i++) {
          const pair = document.createElement('div')
          pair.style.cssText = 'position:absolute;inset:0;isolation:isolate;mix-blend-mode:plus-lighter;opacity:.5;pointer-events:none;'
          parent.append(pair)
          build(pair, count / 2)
        }
        return
      }
      const wrapper = document.createElement('div')
      wrapper.className = 'discard-flight-coverage-sample'
      wrapper.style.cssText = `position:absolute;left:${sourceRect.left - left}px;top:${sourceRect.top - top}px;pointer-events:none;`
      const clone = source.cloneNode(true) as HTMLElement
      const nodes = [clone, ...clone.querySelectorAll<HTMLElement>('*')]
      nodes.forEach((node, i) => {
        // Visual-only clones must not match action/history/hand-slot selectors.
        for (const attribute of [...node.attributes]) {
          if (attribute.name === 'id' || attribute.name === 'class' || attribute.name === 'tabindex'
            || attribute.name.startsWith('data-')) node.removeAttribute(attribute.name)
        }
        node.style.cssText = frozen[i]!
      })
      Object.assign(clone.style, { position: 'relative', left: '0px', top: '0px', right: 'auto', bottom: 'auto', margin: '0px' })
      const delayed = document.createElement('div')
      delayed.style.cssText = 'position:relative;pointer-events:none;'
      delayed.append(clone); wrapper.append(delayed); parent.append(wrapper)
      samples.push({ wrapper, delayed, nodes })
    }
    build(root, plan.count)
    document.body.append(root)
    // One post-insertion read aligns the native image pose, not the outer box.
    const copied = samples[0]!.nodes[imageIndex]!.getBoundingClientRect()
    const correctionX = imageRect.x + imageRect.width / 2 - copied.x - copied.width / 2
    const correctionY = imageRect.y + imageRect.height / 2 - copied.y - copied.height / 2
    const easing = getUiMotionEasing()
    const translate = (x: number, y: number) => `translate3d(${x}px,${y}px,0)`
    for (const [index, sample] of samples.entries()) {
      const weight = index / (plan.count - 1)
      const startX = correctionX + fromX, startY = correctionY + fromY
      // (1-w)*ease(t) + w*ease(t-exposure): two native transforms give the
      // exact uniform spatial sample without a long sampled keyframe sequence.
      if (weight === 1) sample.wrapper.style.transform = translate(startX, startY)
      else animations.push(sample.wrapper.animate(flightTranslationFrames(
          translate(startX, startY),
          translate(startX + (toX - fromX) * (1 - weight), startY + (toY - fromY) * (1 - weight)),
          duration, plan.duration, easing), { duration: plan.duration, fill: 'both', easing: 'linear' }))
      if (weight > 0) animations.push(sample.delayed.animate([
        { transform: translate(0, 0), offset: 0 },
        { transform: translate(0, 0), offset: plan.exposure / plan.duration, easing },
        { transform: translate((toX - fromX) * weight, (toY - fromY) * weight), offset: 1 },
      ], { duration: plan.duration, fill: 'both', easing: 'linear' }))
      for (const effect of effects) {
        if (!(effect.effect instanceof KeyframeEffect)) continue
        const target = originals.indexOf(effect.effect.target as HTMLElement)
        if (target < 0) continue
        animations.push(sample.nodes[target]!.animate(effect.effect.getKeyframes(),
          { duration, fill: 'both', easing: 'linear' }))
      }
    }
    if (typeof document.timeline.currentTime !== 'number') { cancel(); return null }
    // The default DocumentTimeline shares performance's zero. Its currentTime
    // may still be this frame's old timestamp after preparation/layout work.
    const start = performance.now()
    animations.forEach(animation => { animation.startTime = start })
    effects.forEach(animation => { animation.startTime = start })
    source.style.opacity = '0'
    animations[0]!.onfinish = cancel
    window.addEventListener('resize', cancel)
    document.addEventListener('pointerdown', cancel, true)
    document.addEventListener('visibilitychange', visibility)
    const width = sourceRect.width, height = sourceRect.height
    observer = new ResizeObserver(() => {
      const rect = source.getBoundingClientRect()
      if (Math.abs(rect.width - width) > .1 || Math.abs(rect.height - height) > .1) cancel()
    })
    observer.observe(source)
    return { duration: plan.duration, startTime: start, cancel }
  } catch {
    cancel()
    return null
  }
}

// rAF is a scheduling estimate, NOT display/compositor presentation telemetry.
// Run only while the opt-in trial is visible; never keep an idle loop by default.
export function createExposureSampler(isBusy: () => boolean = () => false) {
  let frame = 0, previous = 0
  const intervals: number[] = []
  const tick = (time: number) => {
    if (isBusy()) {
      previous = 0 // do not learn our own preparation/animation load
      frame = requestAnimationFrame(tick)
      return
    }
    if (previous && time > previous) {
      intervals.push(time - previous)
      if (intervals.length > 12) intervals.shift()
    }
    previous = time
    frame = requestAnimationFrame(tick)
  }
  return {
    start() { if (!frame) frame = requestAnimationFrame(tick) },
    stop() { cancelAnimationFrame(frame); frame = 0; previous = 0; intervals.length = 0 },
    exposure() {
      if (intervals.length < 3) return 0 // sharp fallback until there is evidence
      const sorted = [...intervals].sort((a, b) => a - b)
      return sorted[Math.floor((sorted.length - 1) * .75)]!
    },
  }
}
