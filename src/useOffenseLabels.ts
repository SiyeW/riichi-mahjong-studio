import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

type PlayerProbabilities = {
  seat: number
  winProbability: number
  dealInProbability: number
}

export function useOffenseLabels(readPlayers: () => readonly PlayerProbabilities[], enabled: boolean) {
  const offenseTrackElements = new Map<number, HTMLElement>()
  const offenseMeasurements = new Map<number, { track: number; win: number; dealIn: number }>()
  const observedElements = new Map<number, Element[]>()
  const measurementTargets = new WeakMap<Element, { seat: number; kind: 'track' | 'win' | 'dealIn' }>()
  const offenseLabelPositions = ref<Map<number, { win: number; dealIn: number }>>(new Map())
  let offenseResizeObserver: ResizeObserver | null = null

  function updateOffenseLabelPositions() {
    const nextPositions = new Map<number, { win: number; dealIn: number }>()
    for (const player of readPlayers()) {
      const measurements = offenseMeasurements.get(player.seat)
      if (!measurements) continue
      const trackWidth = measurements.track
      const winWidth = measurements.win
      const dealInWidth = measurements.dealIn
      if (trackWidth <= 0 || winWidth <= 0 || dealInWidth <= 0) continue
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

  function handleOffenseResize(entries: ResizeObserverEntry[]) {
    let changed = false
    for (const entry of entries) {
      const target = measurementTargets.get(entry.target)
      if (!target) continue
      const measurements = offenseMeasurements.get(target.seat) || { track: 0, win: 0, dealIn: 0 }
      const width = entry.contentRect.width
      if (Math.abs(measurements[target.kind] - width) < 0.01) continue
      measurements[target.kind] = width
      offenseMeasurements.set(target.seat, measurements)
      changed = true
    }
    if (changed) updateOffenseLabelPositions()
  }

  function stopObservingSeat(seat: number) {
    for (const element of observedElements.get(seat) || []) offenseResizeObserver?.unobserve(element)
    observedElements.delete(seat)
    offenseMeasurements.delete(seat)
  }

  function observeSeat(seat: number, track: HTMLElement) {
    if (!offenseResizeObserver) return
    const winLabel = track.querySelector<HTMLElement>('.analysis-offense-value.is-win')
    const dealInLabel = track.querySelector<HTMLElement>('.analysis-offense-value.is-deal-in')
    if (!winLabel || !dealInLabel) return
    const elements = [track, winLabel, dealInLabel]
    const kinds = ['track', 'win', 'dealIn'] as const
    elements.forEach((element, index) => {
      measurementTargets.set(element, { seat, kind: kinds[index] })
      offenseResizeObserver?.observe(element)
    })
    observedElements.set(seat, elements)
  }

  function setOffenseTrackElement(seat: number, element: unknown) {
    const previous = offenseTrackElements.get(seat)
    if (previous && previous !== element) stopObservingSeat(seat)
    if (!(element instanceof HTMLElement)) {
      offenseTrackElements.delete(seat)
      return
    }
    offenseTrackElements.set(seat, element)
    observeSeat(seat, element)
  }

  onMounted(() => {
    if (!enabled) return
    offenseResizeObserver = new ResizeObserver(handleOffenseResize)
    for (const [seat, element] of offenseTrackElements) observeSeat(seat, element)
  })

  watch(readPlayers, () => {
    if (enabled) updateOffenseLabelPositions()
  })

  onBeforeUnmount(() => {
    offenseResizeObserver?.disconnect()
    offenseTrackElements.clear()
    offenseMeasurements.clear()
    observedElements.clear()
  })

  return { offenseLabelPositions, offenseLabelStyle, setOffenseTrackElement }
}
