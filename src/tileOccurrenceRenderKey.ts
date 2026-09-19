export function tileOccurrenceRenderKey(
  tiles: readonly string[],
  index: number,
  prefix: string,
): string {
  const tile = tiles[index] || ''
  let occurrence = 0
  for (let candidate = 0; candidate < index; candidate += 1) {
    if (tiles[candidate] === tile) occurrence += 1
  }
  return `${prefix}-${tile}-${occurrence}`
}
