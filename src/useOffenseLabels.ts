import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

type PlayerProbabilities = {
  seat: number
  winProbability: number
  dealInProbability: number
}

export function useOffenseLabels(readPlayers: () => readonly PlayerProbabilities[], enabled: boolean) {
  const offenseTrackElements = new Map<number, HTMLElement>()
  const offenseLabelPositions = ref<Map<number, { win: number; dealIn: number }>>(new Map())
  let offenseResizeObserver: ResizeObserver | null = null
  let offenseMeasureFrame = 0
  let disposed = false

  function measureOffenseLabels() {
    const nextPositions = new Map<number, { win: number; dealIn: number }>()
    for (const player of readPlayers()) {
      const track = offenseTrackElements.get(player.seat)
      if (!track) continue
      const winLabel = track.querySelector<HTMLElement>('.analysis-offense-value.is-win')
      const dealInLabel = track.querySelector<HTMLElement>('.analysis-offense-value.is-deal-in')
      if (!winLabel || !dealInLabel) continue
      const trackWidth = track.clientWidth
      const winWidth = winLabel.scrollWidth
      const dealInWidth = dealInLabel.scrollWidth
      const edgeGap = Math.max(3, trackWidth * 0.008)
      const minimumSeparation = Math.max(8, trackWidth * 0.016)
      const dealInEnd = trackWidth * player.dealInProbability
      const winStart = trackWidth * (1 - player.winProbability)
      let dealInLeft = dealInEnd + edgeGap
      let winLeft = winStart - edgeGap - winWidth

      if (dealInLeft + dealInWidth + minimumSeparation > winLeft) {
        dealInLeft = Math.max(0, dealInEnd - edgeGap - dealInWidth)
        winLeft = Math.max(winStart + edgeGap, dealInLeft + dealInWidth + minimumSeparation)
        const maximumWinLeft = Math.max(0, trackWidth - winWidth)
        if (winLeft > maximumWinLeft) {
          winLeft = maximumWinLeft
          dealInLeft = Math.max(0, Math.min(dealInLeft, winLeft - minimumSeparation - dealInWidth))
        }
      }

      nextPositions.set(player.seat, {
        win: Math.max(0, Math.min(winLeft, trackWidth - winWidth)),
        dealIn: Math.max(0, Math.min(dealInLeft, trackWidth - dealInWidth)),
      })
    }
    offenseLabelPositions.value = nextPositions
  }

  function offenseLabelStyle(seat: number, kind: 'win' | 'dealIn') {
    const position = offenseLabelPositions.value.get(seat)?.[kind] || 0
    return { left: `${position}px` }
  }

  function scheduleOffenseLabelMeasurement() {
    if (disposed) return
    cancelAnimationFrame(offenseMeasureFrame)
    offenseMeasureFrame = requestAnimationFrame(() => {
      offenseMeasureFrame = 0
      measureOffenseLabels()
    })
  }

  function setOffenseTrackElement(seat: number, element: unknown) {
    const previous = offenseTrackElements.get(seat)
    if (previous && previous !== element) offenseResizeObserver?.unobserve(previous)
    if (!(element instanceof HTMLElement)) {
      offenseTrackElements.delete(seat)
      return
    }
    offenseTrackElements.set(seat, element)
    offenseResizeObserver?.observe(element)
    scheduleOffenseLabelMeasurement()
  }

  onMounted(() => {
    if (!enabled) return
    offenseResizeObserver = new ResizeObserver(scheduleOffenseLabelMeasurement)
    for (const element of offenseTrackElements.values()) offenseResizeObserver.observe(element)
    scheduleOffenseLabelMeasurement()
  })

  watch(readPlayers, () => {
    if (enabled) void nextTick(scheduleOffenseLabelMeasurement)
  }, { deep: true })

  onBeforeUnmount(() => {
    disposed = true
    cancelAnimationFrame(offenseMeasureFrame)
    offenseResizeObserver?.disconnect()
    offenseTrackElements.clear()
  })

  return { offenseLabelPositions, offenseLabelStyle, setOffenseTrackElement }
}
