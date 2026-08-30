import { oklabToRgb, rgbToOklab, type RgbColor } from './perceptualColor.ts'

export const COUNT_EMPTY_COLOR: RgbColor = [20, 72, 81]

function toneAt(
  base: RgbColor,
  lightness: number,
  chromaScale: number,
): RgbColor {
  const color = rgbToOklab(base)
  const chroma = Math.hypot(color.a, color.b)
  const hue = Math.atan2(color.b, color.a)
  return oklabToRgb({
    l: Math.max(0, Math.min(1, lightness)),
    a: chroma * chromaScale * Math.cos(hue),
    b: chroma * chromaScale * Math.sin(hue),
  })
}

export function buildCountColorScale(base: RgbColor): readonly RgbColor[] {
  const empty = rgbToOklab(COUNT_EMPTY_COLOR)
  const color = rgbToOklab(base)
  return [
    COUNT_EMPTY_COLOR,
    toneAt(base, Math.max(empty.l + 0.04, color.l - 0.10), 0.90),
    base,
    toneAt(base, Math.min(0.96, color.l + 0.08), 0.92),
    toneAt(base, Math.min(0.985, color.l + 0.15), 0.82),
  ]
}

export function buildWallCountColorScale(base: RgbColor): readonly RgbColor[] {
  const empty = rgbToOklab(COUNT_EMPTY_COLOR)
  const color = rgbToOklab(base)
  return [
    COUNT_EMPTY_COLOR,
    toneAt(base, Math.max(empty.l + 0.04, color.l - 0.08), 0.82),
    base,
    toneAt(base, Math.min(0.84, color.l + 0.06), 0.86),
    toneAt(base, Math.min(0.90, color.l + 0.12), 0.74),
  ]
}
