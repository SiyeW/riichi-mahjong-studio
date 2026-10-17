export function distributionBarGeometry(width: number, gapsBefore: readonly boolean[], gapWidth: number) {
  const count = gapsBefore.length
  const gap = Math.max(1, Math.round(gapWidth))
  const gapCount = gapsBefore.filter((value, index) => index > 0 && value).length
  const minimumWidth = count + gapCount * gap
  const contentWidth = Math.max(Math.floor(width), minimumWidth, 1)
  const barWidth = count ? Math.floor((contentWidth - gapCount * gap) / count) : 0
  // Remainder belongs to the outside padding, never to selected bars. Below
  // one pixel per bar, the caller scrolls this minimum-size content instead.
  const usedWidth = count * barWidth + gapCount * gap
  const padding = Math.floor((contentWidth - usedWidth) / 2)
  let cursor = padding
  const gaps: Array<{ left: number; right: number }> = []
  const bars = gapsBefore.map((before, index) => {
    if (index > 0 && before) {
      gaps.push({ left: cursor, right: cursor + gap })
      cursor += gap
    }
    const bar = { left: cursor, right: cursor + barWidth }
    cursor += barWidth
    return bar
  })
  return { contentWidth, barWidth, bars, gaps, padding }
}
