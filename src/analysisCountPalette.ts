import {
  mixOklab,
  oklabToRgb,
  parseCssColor,
  rgbString,
  rgbToOklab,
  type RgbColor,
} from './perceptualColor.ts'

export const COUNT_EMPTY_COLOR: RgbColor = [20, 72, 81]
const COUNT_FULL_COLOR: RgbColor = [255, 255, 255]
export type CountSourceKey = 'kamicha' | 'toimen' | 'shimocha' | 'wall'

type CssVariableReader = Pick<CSSStyleDeclaration, 'getPropertyValue'>

const PLAYER_SOURCE_STYLES: Readonly<Record<Exclude<CountSourceKey, 'wall'>, {
  variable: string
  fallback: RgbColor
}>> = {
  kamicha: { variable: '--ron-kamicha-color', fallback: [44, 143, 197] },
  toimen: { variable: '--ron-toimen-color', fallback: [211, 154, 58] },
  shimocha: { variable: '--ron-shimocha-color', fallback: [76, 175, 80] },
}

export function buildCountColorScale(base: RgbColor): readonly RgbColor[] {
  return [
    COUNT_EMPTY_COLOR,
    mixOklab(COUNT_EMPTY_COLOR, base, 0.5),
    base,
    mixOklab(base, COUNT_FULL_COLOR, 0.4),
    mixOklab(base, COUNT_FULL_COLOR, 0.8),
  ]
}

function playerBaseColors(style: CssVariableReader) {
  return Object.fromEntries(Object.entries(PLAYER_SOURCE_STYLES).map(([key, source]) => [
    key,
    parseCssColor(style.getPropertyValue(source.variable), source.fallback),
  ])) as Record<Exclude<CountSourceKey, 'wall'>, RgbColor>
}

function wallBaseColor(style: CssVariableReader): RgbColor {
  const players = Object.values(playerBaseColors(style)).map(rgbToOklab)
  const meanLightness = players.reduce((sum, color) => sum + color.l, 0) / players.length
  const meanChroma = players.reduce((sum, color) => sum + Math.hypot(color.a, color.b), 0) / players.length
  const hue = 170 * (Math.PI / 180)
  const chroma = Math.max(0.018, Math.min(0.04, meanChroma * 0.2))
  return oklabToRgb({
    l: meanLightness,
    a: chroma * Math.cos(hue),
    b: chroma * Math.sin(hue),
  })
}

export function countSourcePalette(
  sourceKey: CountSourceKey,
  style: CssVariableReader,
): string[] {
  const base = sourceKey === 'wall'
    ? wallBaseColor(style)
    : playerBaseColors(style)[sourceKey]
  return buildCountColorScale(base).map(rgbString)
}

export function countPaletteVariable(sourceKey: string, value: number): string {
  return `--analysis-count-${sourceKey}-${value}`
}

export function countSegmentColor(sourceKey: string, value: unknown): string {
  const numericValue = Math.max(0, Math.min(4, Number(value) || 0))
  return `var(${countPaletteVariable(sourceKey, numericValue)})`
}
