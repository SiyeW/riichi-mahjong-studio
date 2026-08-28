export type RgbColor = readonly [number, number, number]
export type OklabColor = Readonly<{ l: number; a: number; b: number }>

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

export function parseCssColor(value: string, fallback: RgbColor): RgbColor {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1]
  if (hex) {
    const expanded = hex.length === 3 ? [...hex].map((part) => part.repeat(2)).join('') : hex
    return [
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16),
    ]
  }
  const rgb = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
  if (!rgb) return fallback
  const channel = (part: string) => clamp(Number(part), 0, 255)
  return [channel(rgb[1]), channel(rgb[2]), channel(rgb[3])]
}

function srgbToLinear(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(channel: number): number {
  const value = clamp(channel, 0, 1)
  const srgb = value <= 0.0031308
    ? value * 12.92
    : (1.055 * (value ** (1 / 2.4))) - 0.055
  return Math.round(srgb * 255)
}

export function rgbToOklab(rgb: RgbColor): OklabColor {
  const [r, g, b] = rgb.map(srgbToLinear)
  const lRoot = Math.cbrt((0.4122214708 * r) + (0.5363325363 * g) + (0.0514459929 * b))
  const mRoot = Math.cbrt((0.2119034982 * r) + (0.6806995451 * g) + (0.1073969566 * b))
  const sRoot = Math.cbrt((0.0883024619 * r) + (0.2817188376 * g) + (0.6299787005 * b))
  return {
    l: (0.2104542553 * lRoot) + (0.793617785 * mRoot) - (0.0040720468 * sRoot),
    a: (1.9779984951 * lRoot) - (2.428592205 * mRoot) + (0.4505937099 * sRoot),
    b: (0.0259040371 * lRoot) + (0.7827717662 * mRoot) - (0.808675766 * sRoot),
  }
}

function oklabToLinearRgb(color: OklabColor): [number, number, number] {
  const lRoot = color.l + (0.3963377774 * color.a) + (0.2158037573 * color.b)
  const mRoot = color.l - (0.1055613458 * color.a) - (0.0638541728 * color.b)
  const sRoot = color.l - (0.0894841775 * color.a) - (1.291485548 * color.b)
  const l = lRoot ** 3
  const m = mRoot ** 3
  const s = sRoot ** 3
  return [
    (4.0767416621 * l) - (3.3077115913 * m) + (0.2309699292 * s),
    (-1.2684380046 * l) + (2.6097574011 * m) - (0.3413193965 * s),
    (-0.0041960863 * l) - (0.7034186147 * m) + (1.707614701 * s),
  ]
}

function isInSrgbGamut(channels: readonly number[]): boolean {
  return channels.every((channel) => channel >= -1e-7 && channel <= 1 + 1e-7)
}

export function oklabToRgb(color: OklabColor): RgbColor {
  let mapped = color
  if (!isInSrgbGamut(oklabToLinearRgb(mapped))) {
    const chroma = Math.hypot(color.a, color.b)
    const hue = Math.atan2(color.b, color.a)
    let low = 0
    let high = chroma
    for (let index = 0; index < 20; index += 1) {
      const candidateChroma = (low + high) / 2
      const candidate = {
        l: color.l,
        a: candidateChroma * Math.cos(hue),
        b: candidateChroma * Math.sin(hue),
      }
      if (isInSrgbGamut(oklabToLinearRgb(candidate))) low = candidateChroma
      else high = candidateChroma
    }
    mapped = {
      l: color.l,
      a: low * Math.cos(hue),
      b: low * Math.sin(hue),
    }
  }
  const [r, g, b] = oklabToLinearRgb(mapped)
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)]
}

export function rgbString(rgb: RgbColor): string {
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`
}

export function mixOklab(start: RgbColor, end: RgbColor, ratio: number): RgbColor {
  const from = rgbToOklab(start)
  const to = rgbToOklab(end)
  const amount = clamp(ratio, 0, 1)
  return oklabToRgb({
    l: from.l + ((to.l - from.l) * amount),
    a: from.a + ((to.a - from.a) * amount),
    b: from.b + ((to.b - from.b) * amount),
  })
}

export function scaleOklab(color: RgbColor, factor: number): RgbColor {
  const lab = rgbToOklab(color)
  const amount = Math.max(0, factor)
  return oklabToRgb({ l: lab.l * amount, a: lab.a * amount, b: lab.b * amount })
}

function oklabDistance(first: OklabColor, second: OklabColor): number {
  return Math.hypot(first.l - second.l, first.a - second.a, first.b - second.b)
}

export function mostDistinctOklabColor(colors: readonly RgbColor[]): RgbColor {
  const labs = colors.map(rgbToOklab)
  const lightness = labs.reduce((sum, color) => sum + color.l, 0) / labs.length
  const chroma = labs.reduce((sum, color) => sum + Math.hypot(color.a, color.b), 0) / labs.length
  let bestColor: RgbColor = [201, 85, 77]
  let bestDistance = -1
  for (let degrees = 0; degrees < 360; degrees += 1) {
    const hue = degrees * (Math.PI / 180)
    const candidate = oklabToRgb({
      l: lightness,
      a: chroma * Math.cos(hue),
      b: chroma * Math.sin(hue),
    })
    const candidateLab = rgbToOklab(candidate)
    const minimumDistance = Math.min(...labs.map((color) => oklabDistance(candidateLab, color)))
    if (minimumDistance > bestDistance) {
      bestDistance = minimumDistance
      bestColor = candidate
    }
  }
  return bestColor
}
