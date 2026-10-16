export type ShantenSliceGeometry = Readonly<{
  path: string
  probability: number
  textX: number
  textY: number
}>

export function normalizeShantenProbabilities(values: readonly number[], count: number): number[] {
  const sanitized = Array.from({ length: count }, (_, index) => Math.max(0, Number(values[index]) || 0))
  const total = sanitized.reduce((sum, probability) => sum + probability, 0)
  return total > 0 ? sanitized.map(probability => probability / total) : sanitized
}

// Unit-circle coordinates need no more precision than a tiny fraction of a
// physical pixel even at very large displays. Probability data stays untouched.
export function pieCoordinate(value: number): string {
  return String(Number(value.toFixed(6)))
}

export function shantenPieSlices(probabilities: readonly number[]): ShantenSliceGeometry[] {
  let cumulative = 0
  return probabilities.map(probability => {
    const startAngle = (cumulative * 2 * Math.PI) - (Math.PI / 2)
    cumulative += probability
    const endAngle = (cumulative * 2 * Math.PI) - (Math.PI / 2)
    const middleAngle = (startAngle + endAngle) / 2
    const path = probability === 0 ? 'M 0 0 Z'
      : probability >= 0.999999 ? 'M 0 -1 A 1 1 0 1 1 0 1 A 1 1 0 1 1 0 -1 Z'
        : `M 0 0 L ${pieCoordinate(Math.cos(startAngle))} ${pieCoordinate(Math.sin(startAngle))} A 1 1 0 ${probability > 0.5 ? 1 : 0} 1 ${pieCoordinate(Math.cos(endAngle))} ${pieCoordinate(Math.sin(endAngle))} Z`
    return { path, probability, textX: Math.cos(middleAngle) * 0.62, textY: Math.sin(middleAngle) * 0.62 }
  })
}
