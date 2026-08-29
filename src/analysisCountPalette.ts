import { mixOklab, type RgbColor } from './perceptualColor.ts'

export const COUNT_EMPTY_COLOR: RgbColor = [20, 72, 81]
const COUNT_FULL_COLOR: RgbColor = [255, 255, 255]

function channelWiseMaximum(first: RgbColor, second: RgbColor): RgbColor {
  return [
    Math.max(first[0], second[0]),
    Math.max(first[1], second[1]),
    Math.max(first[2], second[2]),
  ]
}

export function buildCountColorScale(base: RgbColor): readonly RgbColor[] {
  const three = channelWiseMaximum(base, mixOklab(base, COUNT_FULL_COLOR, 0.28))
  const four = channelWiseMaximum(three, mixOklab(base, COUNT_FULL_COLOR, 0.48))
  return [
    COUNT_EMPTY_COLOR,
    mixOklab(COUNT_EMPTY_COLOR, base, 0.5),
    base,
    three,
    four,
  ]
}
