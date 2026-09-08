export interface GraphHitRegion<TDot> {
  dot: TDot
  x: number
  y: number
  width: number | '100%'
  height: number
}

export function buildGraphHitRegions<
  TDot extends { id: string; x: number; y: number },
>(
  dots: TDot[],
  rowHeight: number,
  horizontalRadius: (dot: TDot) => number,
): GraphHitRegion<TDot>[] {
  const dotsByRow = new Map<number, TDot[]>()
  dots.forEach((dot) => {
    const row = dotsByRow.get(dot.y) || []
    row.push(dot)
    dotsByRow.set(dot.y, row)
  })

  return Array.from(dotsByRow.entries())
    .sort(([yA], [yB]) => yA - yB)
    .flatMap(([, rowDots]) => {
      const ordered = rowDots.slice().sort((a, b) => (
        a.x - b.x || a.id.localeCompare(b.id)
      ))
      return ordered.map((dot, index) => {
        const nextDot = ordered[index + 1]
        const x = index === 0 ? 0 : Math.max(0, dot.x - horizontalRadius(dot))
        const nextX = nextDot
          ? Math.max(x, nextDot.x - horizontalRadius(nextDot))
          : null
        return {
          dot,
          x,
          y: Math.max(0, dot.y - rowHeight / 2),
          width: nextX === null ? '100%' as const : nextX - x,
          height: rowHeight,
        }
      })
    })
}
