export function distributionBarGeometry(width: number, gapsBefore: readonly boolean[], gapWidth: number) {
  const count = gapsBefore.length
  const desiredGap = Math.max(1, Math.round(gapWidth))
  const gapCount = gapsBefore.filter((value, index) => index > 0 && value).length
  const contentWidth = Math.max(Math.floor(width), 1)
  const dense = contentWidth < count + gapCount * desiredGap
  // Normal widths use balanced integer boundaries, not a whole-domain step
  // whenever one more pixel per bar becomes available. Dense views retain all
  // categories through subpixel area coverage rather than overflow or omission.
  const gap = dense ? Math.min(desiredGap, contentWidth / Math.max(1, count + 2 * gapCount)) : desiredGap
  const barSpace = contentWidth - gapCount * gap
  const barWidth = count ? barSpace / count : 0
  let cursor = 0
  const gaps: Array<{ left: number; right: number }> = []
  const bars = gapsBefore.map((before, index) => {
    if (index > 0 && before) {
      gaps.push({ left: cursor, right: cursor + gap })
      cursor += gap
    }
    const boundary = (index + 1) * barSpace / count
    const previous = index * barSpace / count
    const bar = { left: cursor, right: cursor + (dense ? boundary - previous : Math.floor(boundary) - Math.floor(previous)) }
    if (index === count - 1) bar.right = contentWidth
    cursor = bar.right
    return bar
  })
  return { contentWidth, barWidth, bars, gaps, dense }
}
