export function acceptsAnalysisEpoch(value: unknown, minimum: number | null): boolean {
  if (minimum === null) return true
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}
