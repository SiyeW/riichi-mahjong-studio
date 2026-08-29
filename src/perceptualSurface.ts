import type { Directive } from 'vue'
import {
  mixOklab,
  oklabToRgb,
  rgbString,
  rgbToOklab,
  type RgbColor,
} from './perceptualColor.ts'

export type PerceptualColorPalette = Readonly<{
  decisionRecommendation: RgbColor
  kamicha: RgbColor
  toimen: RgbColor
  shimocha: RgbColor
  selfDealIn: RgbColor
}>

export type PerceptualSurfaceTuning = Readonly<{
  lightnessCompensation: number
  chromaticCompensation: number
  surfaceChromaGain: number
}>

export type PerceptualSurfaceBinding = Readonly<{
  palette: PerceptualColorPalette
  tuning: PerceptualSurfaceTuning
  surfaceLayerVariables?: readonly string[]
  debugLabel?: string
}>

export const DEFAULT_PERCEPTUAL_SURFACE_TUNING: PerceptualSurfaceTuning = Object.freeze({
  lightnessCompensation: 0.5,
  chromaticCompensation: 0,
  surfaceChromaGain: 0,
})

export const PERCEPTUAL_COLOR_CALIBRATION_BACKGROUND: RgbColor = [5, 57, 66]

const PERCEPTUAL_SURFACE_VARIABLES = [
  '--decision-recommendation-color',
  '--ron-kamicha-color',
  '--ron-toimen-color',
  '--ron-shimocha-color',
  '--analysis-draw-color',
  '--analysis-self-win-color',
  '--analysis-horizontal-color',
  '--analysis-self-deal-in-color',
  '--analysis-dora-color',
  '--analysis-score-color',
  '--analysis-rank-1-color',
  '--analysis-rank-2-color',
  '--analysis-rank-3-color',
  '--analysis-rank-4-color',
] as const

function surfaceAdjustedColor(
  color: RgbColor,
  surface: RgbColor,
  tuning: PerceptualSurfaceTuning,
): RgbColor {
  const canonical = rgbToOklab(color)
  const calibration = rgbToOklab(PERCEPTUAL_COLOR_CALIBRATION_BACKGROUND)
  const background = rgbToOklab(surface)
  const lightnessDelta = calibration.l - background.l
  const aDelta = calibration.a - background.a
  const bDelta = calibration.b - background.b
  const adjustedA = canonical.a + (aDelta * tuning.chromaticCompensation)
  const adjustedB = canonical.b + (bDelta * tuning.chromaticCompensation)
  const surfaceDistance = Math.hypot(lightnessDelta, aDelta, bDelta)
  const chromaMultiplier = Math.max(0, 1 + (surfaceDistance * tuning.surfaceChromaGain))
  return oklabToRgb({
    l: canonical.l + (lightnessDelta * tuning.lightnessCompensation),
    a: adjustedA * chromaMultiplier,
    b: adjustedB * chromaMultiplier,
  })
}

export function perceptualSurfaceVariables(
  palette: PerceptualColorPalette,
  surface: RgbColor,
  tuning: PerceptualSurfaceTuning = DEFAULT_PERCEPTUAL_SURFACE_TUNING,
): Record<(typeof PERCEPTUAL_SURFACE_VARIABLES)[number], string> {
  const decisionRecommendation = surfaceAdjustedColor(palette.decisionRecommendation, surface, tuning)
  const kamicha = surfaceAdjustedColor(palette.kamicha, surface, tuning)
  const toimen = surfaceAdjustedColor(palette.toimen, surface, tuning)
  const shimocha = surfaceAdjustedColor(palette.shimocha, surface, tuning)
  const selfDealIn = surfaceAdjustedColor(palette.selfDealIn, surface, tuning)
  const placementFirst: RgbColor = [235, 235, 235]
  return {
    '--decision-recommendation-color': rgbString(decisionRecommendation),
    '--ron-kamicha-color': rgbString(kamicha),
    '--ron-toimen-color': rgbString(toimen),
    '--ron-shimocha-color': rgbString(shimocha),
    '--analysis-draw-color': rgbString(kamicha),
    '--analysis-self-win-color': rgbString(shimocha),
    '--analysis-horizontal-color': rgbString(toimen),
    '--analysis-self-deal-in-color': rgbString(selfDealIn),
    '--analysis-dora-color': rgbString(kamicha),
    '--analysis-score-color': rgbString(toimen),
    '--analysis-rank-1-color': rgbString(placementFirst),
    '--analysis-rank-2-color': rgbString(mixOklab(kamicha, placementFirst, 2 / 3)),
    '--analysis-rank-3-color': rgbString(mixOklab(kamicha, placementFirst, 1 / 3)),
    '--analysis-rank-4-color': rgbString(kamicha),
  }
}

function parsedBackgroundColor(value: string): readonly [number, number, number, number] {
  const match = value.match(/^rgba?\(([^)]+)\)$/i)
  if (!match) return [0, 0, 0, 0]
  const parts = match[1].split(/[\s,\/]+/).filter(Boolean).map(Number)
  return [
    parts[0] || 0,
    parts[1] || 0,
    parts[2] || 0,
    parts.length > 3 ? Math.max(0, Math.min(1, parts[3])) : 1,
  ]
}

export function compositeBackgroundColors(colors: readonly string[]): RgbColor {
  let red = 0
  let green = 0
  let blue = 0
  let alpha = 0
  for (const color of colors) {
    const [nextRed, nextGreen, nextBlue, nextAlpha] = parsedBackgroundColor(color)
    const compositeAlpha = nextAlpha + (alpha * (1 - nextAlpha))
    if (compositeAlpha <= 0) continue
    red = ((nextRed * nextAlpha) + (red * alpha * (1 - nextAlpha))) / compositeAlpha
    green = ((nextGreen * nextAlpha) + (green * alpha * (1 - nextAlpha))) / compositeAlpha
    blue = ((nextBlue * nextAlpha) + (blue * alpha * (1 - nextAlpha))) / compositeAlpha
    alpha = compositeAlpha
  }
  return [Math.round(red), Math.round(green), Math.round(blue)]
}

export function effectiveBackgroundColor(
  element: HTMLElement,
  surfaceLayerVariables: readonly string[] = [],
): RgbColor {
  const ancestors: HTMLElement[] = []
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    ancestors.unshift(current)
  }
  const colors = ancestors.map((ancestor) => getComputedStyle(ancestor).backgroundColor)
  const elementStyle = getComputedStyle(element)
  for (const variable of surfaceLayerVariables) {
    colors.push(elementStyle.getPropertyValue(variable))
  }
  return compositeBackgroundColors(colors)
}

type PerceptualSurfaceState = {
  binding: PerceptualSurfaceBinding
  frame: number
  observer: MutationObserver
  headObserver: MutationObserver
  resize: () => void
}

const surfaceStates = new WeakMap<HTMLElement, PerceptualSurfaceState>()

function updatePerceptualSurface(element: HTMLElement, state: PerceptualSurfaceState) {
  state.frame = 0
  const surface = effectiveBackgroundColor(
    element,
    state.binding.surfaceLayerVariables,
  )
  const variables = perceptualSurfaceVariables(
    state.binding.palette,
    surface,
    state.binding.tuning,
  )
  let changed = false
  for (const variable of PERCEPTUAL_SURFACE_VARIABLES) {
    const value = variables[variable]
    if (element.style.getPropertyValue(variable) === value) continue
    element.style.setProperty(variable, value)
    changed = true
  }
  element.dataset.perceptualSurfaceColor = rgbString(surface)
  if (state.binding.debugLabel) element.dataset.perceptualSurfaceLabel = state.binding.debugLabel
  else delete element.dataset.perceptualSurfaceLabel
  if (state.binding.surfaceLayerVariables?.length) {
    element.dataset.perceptualSurfaceLayers = state.binding.surfaceLayerVariables.join(',')
  } else {
    delete element.dataset.perceptualSurfaceLayers
  }
  if (changed) {
    element.dispatchEvent(new CustomEvent('perceptual-surface-change', {
      detail: {
        label: state.binding.debugLabel || '',
        surface,
        variables,
      },
    }))
  }
}

function schedulePerceptualSurface(element: HTMLElement, state: PerceptualSurfaceState) {
  cancelAnimationFrame(state.frame)
  state.frame = requestAnimationFrame(() => updatePerceptualSurface(element, state))
}

function observeSurfaceAncestors(element: HTMLElement, state: PerceptualSurfaceState) {
  state.observer.disconnect()
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    state.observer.observe(current, { attributes: true, attributeFilter: ['class', 'style'] })
  }
}

export const vPerceptualSurface: Directive<HTMLElement, PerceptualSurfaceBinding> = {
  mounted(element, binding) {
    const state: PerceptualSurfaceState = {
      binding: binding.value,
      frame: 0,
      observer: new MutationObserver(() => schedulePerceptualSurface(element, state)),
      headObserver: new MutationObserver(() => schedulePerceptualSurface(element, state)),
      resize: () => schedulePerceptualSurface(element, state),
    }
    surfaceStates.set(element, state)
    observeSurfaceAncestors(element, state)
    state.headObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
    window.addEventListener('resize', state.resize)
    schedulePerceptualSurface(element, state)
  },
  updated(element, binding) {
    const state = surfaceStates.get(element)
    if (!state) return
    state.binding = binding.value
    observeSurfaceAncestors(element, state)
    schedulePerceptualSurface(element, state)
  },
  beforeUnmount(element) {
    const state = surfaceStates.get(element)
    if (!state) return
    cancelAnimationFrame(state.frame)
    state.observer.disconnect()
    state.headObserver.disconnect()
    window.removeEventListener('resize', state.resize)
    surfaceStates.delete(element)
  },
}
