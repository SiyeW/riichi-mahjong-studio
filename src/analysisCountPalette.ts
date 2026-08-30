import { mixOklab, type RgbColor } from './perceptualColor.ts'

export const COUNT_EMPTY_COLOR: RgbColor = [20, 72, 81]
const COUNT_FULL_COLOR: RgbColor = [255, 255, 255]

export function buildCountColorScale(base: RgbColor): readonly RgbColor[] {
  return [
    COUNT_EMPTY_COLOR,
    mixOklab(COUNT_EMPTY_COLOR, base, 0.5),
    base,
    mixOklab(base, COUNT_FULL_COLOR, 0.4),
    mixOklab(base, COUNT_FULL_COLOR, 0.8),
  ]
}
