import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { getUiMotionDurationMs, getUiMotionEasing } from './uiMotion'
import { createDiscardCoverageRenderer, type DiscardCoverage } from './discardMotion/coverage'
import { IMAGE_POSE_PROPERTIES, animateDiscardBackOverlay, animateDiscardPoseTransition,
  createDiscardFlightBackOverlay, createDiscardFlightRegularPose, setBranchMark } from './discardMotion/tilePose'
import type { GameView } from './contracts/game'
import type { StudioStatus } from './contracts/runtime'
import type { TileNextMoveClass } from './useNextMoveHints'

export type PendingDiscardView = NonNullable<NonNullable<GameView['table']>['pendingDiscard']>
export interface PendingDiscardReturnFlight {
  ghost: HTMLElement
  destination: HTMLElement | null
  backOverlay: HTMLElement | null
  regularPose: HTMLElement | null
  settledImage: HTMLElement | null
  seat: number
  sourceCenterX: number
  sourceCenterY: number
  destinationCenterX: number
  destinationCenterY: number
  deltaX: number
  deltaY: number
}

export function useDiscardFlight(options: {
  status: StudioStatus
  reduceMotionEnabled: Readonly<Ref<boolean>>
  motionBlurEnabled: Readonly<Ref<boolean>>
  tileImageSrc: (tile: string) => string
  scheduleAutoAdvance: () => void
}) {
  const { status, reduceMotionEnabled, motionBlurEnabled, tileImageSrc, scheduleAutoAdvance } = options
  // Admission includes queued nextTick/rAF and bounded snapshot preparation;
  // reverse ownership ends only after the destination has been revealed.
  const forwardMotionActive = ref(false), returnMotionActive = ref(false)
  const tableMotionActive = computed(() => forwardMotionActive.value || returnMotionActive.value)
  const coverageRenderer = createDiscardCoverageRenderer({
    diagnostics: import.meta.env.MODE === 'ui-test' || import.meta.env.MODE === 'desktop-test',
  })
  let forwardCoverage: DiscardCoverage | null = null
  let returnCoverage: DiscardCoverage | null = null
  const updateCoverage = () => {
    if (document.hidden || reduceMotionEnabled.value) {
      // Invisible/throttled animation callbacks must never hold gameplay.
      cancelPendingDiscardFlight()
      cancelPendingDiscardReturnFlight()
      coverageRenderer.stop()
      scheduleAutoAdvance()
    }
    else if (motionBlurEnabled.value) coverageRenderer.start()
    else {
      forwardCoverage?.cancel(); forwardCoverage = null
      returnCoverage?.cancel(); returnCoverage = null
      coverageRenderer.stop()
    }
  }
  document.addEventListener('visibilitychange', updateCoverage)
  // Start the default-on renderer after its DOM and cancellation owner exist.
  onMounted(updateCoverage)
  watch([motionBlurEnabled, reduceMotionEnabled], updateCoverage)
  const geometryChanged = () => {
    cancelPendingDiscardFlight()
    cancelPendingDiscardReturnFlight()
    scheduleAutoAdvance()
  }
  window.addEventListener('resize', geometryChanged)

  let pendingDiscardFlightFrame = 0
  let pendingDiscardFlightAnimation: Animation | null = null
  let pendingDiscardFlightEffects: Animation[] = []
  let pendingDiscardFlightGeneration = 0
  let pendingDiscardFlightBackOverlay: HTMLElement | null = null
  let pendingDiscardFlightRegularPose: HTMLElement | null = null
  let pendingDiscardFlightTarget: HTMLElement | null = null
  let pendingDiscardFlightSize: ResizeObserver | null = null
  let pendingDiscardReturnFrame = 0
  let pendingDiscardReturnAnimation: Animation | null = null
  let pendingDiscardReturnEffects: Animation[] = []
  let pendingDiscardReturnGeneration = 0
  let pendingDiscardReturnGhost: HTMLElement | null = null
  let pendingDiscardReturnDestination: HTMLElement | null = null
  let pendingDiscardReturnSize: ResizeObserver | null = null
  let autoAdvanceMotionNotBefore = 0

  function holdAutoAdvanceForTableMotion(duration = getUiMotionDurationMs()) {
    if (reduceMotionEnabled.value) return
    autoAdvanceMotionNotBefore = Math.max(
      autoAdvanceMotionNotBefore,
      performance.now() + duration,
    )
  }

  function pendingDiscardFromTable(table: GameView['table']): PendingDiscardView | null {
    return table?.pendingRiichiDiscard || table?.pendingDiscard || null
  }

  function pendingDiscardSignature(table: GameView['table']): string {
    const pending = pendingDiscardFromTable(table)
    if (!pending) return ''
    return [table?.bakaze, table?.kyoku, table?.honba, table?.rivers[pending.actor]?.length,
      pending.actor, pending.pai, pending.tsumogiri ? 1 : 0, pending.riichi ? 1 : 0].join('|')
  }

  function cancelPendingDiscardFlight() {
    pendingDiscardFlightGeneration += 1
    pendingDiscardFlightSize?.disconnect(); pendingDiscardFlightSize = null
    forwardCoverage?.cancel()
    forwardCoverage = null
    if (pendingDiscardFlightFrame) {
      cancelAnimationFrame(pendingDiscardFlightFrame)
      pendingDiscardFlightFrame = 0
    }
    if (pendingDiscardFlightAnimation) pendingDiscardFlightAnimation.onfinish = null
    pendingDiscardFlightAnimation?.cancel()
    pendingDiscardFlightAnimation = null
    pendingDiscardFlightEffects.forEach(animation => animation.cancel())
    pendingDiscardFlightEffects = []
    pendingDiscardFlightBackOverlay?.remove()
    pendingDiscardFlightBackOverlay = null
    pendingDiscardFlightRegularPose?.remove()
    pendingDiscardFlightRegularPose = null
    pendingDiscardFlightTarget?.style.removeProperty('will-change')
    pendingDiscardFlightTarget?.style.removeProperty('visibility')
    pendingDiscardFlightTarget = null
    forwardMotionActive.value = false
  }

  function clearPendingDiscardReturnFlight() {
    pendingDiscardReturnSize?.disconnect(); pendingDiscardReturnSize = null
    returnCoverage?.cancel()
    returnCoverage = null
    if (pendingDiscardReturnAnimation) pendingDiscardReturnAnimation.onfinish = null
    pendingDiscardReturnAnimation?.cancel()
    pendingDiscardReturnAnimation = null
    pendingDiscardReturnEffects.forEach(animation => animation.cancel())
    pendingDiscardReturnEffects = []
    pendingDiscardReturnGhost?.remove()
    pendingDiscardReturnDestination?.style.removeProperty('visibility')
    pendingDiscardReturnGhost = null
    pendingDiscardReturnDestination = null
    returnMotionActive.value = false
  }

  function cancelPendingDiscardReturnFlight() {
    pendingDiscardReturnGeneration += 1
    if (pendingDiscardReturnFrame) {
      cancelAnimationFrame(pendingDiscardReturnFrame)
      pendingDiscardReturnFrame = 0
    }
    clearPendingDiscardReturnFlight()
  }

  function shouldAnimateDiscardFaceChange(seat: number): boolean {
    return seat !== status.controlledSeat && !status.visibleHands
  }

  function observeMotionSize(element: HTMLElement, invalidate: () => void) {
    const original = element.getBoundingClientRect(), ratio = devicePixelRatio
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect()
      if (!element.isConnected || devicePixelRatio !== ratio
        || Math.abs(rect.width - original.width) > .1 || Math.abs(rect.height - original.height) > .1) invalidate()
    })
    observer.observe(element)
    return observer
  }


  function preparePendingDiscardReturnFlight(seat: number): PendingDiscardReturnFlight | null {
    if (reduceMotionEnabled.value || document.hidden) return null
    const destination = document.querySelector<HTMLElement>(`[data-hand-gap-seat="${seat}"]`)
    const source = document.querySelector<HTMLElement>(`[data-pending-discard-seat="${seat}"]`)
    if (!destination || !source) return null

    const sourceRect = source.getBoundingClientRect()
    const destinationRect = destination.getBoundingClientRect()
    const povClass = [...(source.closest<HTMLElement>('[class*="pov-p"]')?.classList || [])]
      .find((className) => /^pov-p[0-3]$/.test(className))
    if (!povClass) return null

    const ghost = document.createElement('span')
    ghost.className = `discard-return-ghost ${povClass}`
    ghost.style.left = `${sourceRect.left}px`
    ghost.style.top = `${sourceRect.top}px`
    const sourceStyle = getComputedStyle(source)
    for (const property of ['--zoom', '--zoom-tiles', '--tile-img-w', '--tile-img-h', '--tile-w', '--tile-h']) {
      ghost.style.setProperty(property, sourceStyle.getPropertyValue(property))
    }
    const clonedTile = source.cloneNode(true) as HTMLElement
    clonedTile.removeAttribute('data-pending-discard-seat')
    clonedTile.style.width = sourceStyle.width
    clonedTile.style.height = sourceStyle.height
    const sourceImage = source.querySelector<HTMLElement>('.tileImg')
    const clonedImage = clonedTile.querySelector<HTMLElement>('.tileImg')
    const sourceVisualRect = sourceImage?.getBoundingClientRect() || sourceRect
    if (sourceImage && clonedImage) {
      const sourceImageStyle = getComputedStyle(sourceImage)
      clonedImage.style.width = sourceImageStyle.width
      clonedImage.style.height = sourceImageStyle.height
      // River-specific selectors no longer match after the clone moves to body.
      // Preserve the actual settled pose, including a sideways riichi discard.
      IMAGE_POSE_PROPERTIES.forEach(property => {
        clonedImage.style.setProperty(property, sourceImageStyle.getPropertyValue(property))
      })
    }
    ghost.appendChild(clonedTile)
    document.body.appendChild(ghost)
    const regularPose = source.classList.contains('river-riichi')
      ? createDiscardFlightRegularPose(
          clonedTile,
          povClass,
          0,
          { backImageSrc: shouldAnimateDiscardFaceChange(seat) ? tileImageSrc('?') : undefined },
        )
      : null
    const backOverlay = !regularPose && shouldAnimateDiscardFaceChange(seat)
      ? createDiscardFlightBackOverlay(clonedTile, 0, tileImageSrc('?'))
      : null
    destination.style.visibility = 'hidden'

    return {
      ghost,
      destination,
      backOverlay,
      regularPose,
      settledImage: clonedImage,
      seat,
      sourceCenterX: sourceVisualRect.left + (sourceVisualRect.width / 2),
      sourceCenterY: sourceVisualRect.top + (sourceVisualRect.height / 2),
      destinationCenterX: destinationRect.left + (destinationRect.width / 2),
      destinationCenterY: destinationRect.top + (destinationRect.height / 2),
      deltaX: (destinationRect.left + (destinationRect.width / 2)) - (sourceVisualRect.left + (sourceVisualRect.width / 2)),
      deltaY: (destinationRect.top + (destinationRect.height / 2)) - (sourceVisualRect.top + (sourceVisualRect.height / 2)),
    }
  }

  function resolvePendingDiscardReturnDestination(flight: PendingDiscardReturnFlight) {
    const candidates = [...document.querySelectorAll<HTMLElement>(`[data-hand-seat="${flight.seat}"]`)]
    let closest: HTMLElement | null = null
    let closestDistance = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
      const rect = candidate.getBoundingClientRect()
      const centerX = rect.left + (rect.width / 2)
      const centerY = rect.top + (rect.height / 2)
      const distance = ((centerX - flight.destinationCenterX) ** 2)
        + ((centerY - flight.destinationCenterY) ** 2)
      if (distance < closestDistance) {
        closest = candidate
        closestDistance = distance
      }
    }
    if (!closest) return false

    const destinationRect = closest.getBoundingClientRect()
    flight.destination = closest
    pendingDiscardReturnDestination = closest
    flight.deltaX = (destinationRect.left + (destinationRect.width / 2))
      - flight.sourceCenterX
    flight.deltaY = (destinationRect.top + (destinationRect.height / 2))
      - flight.sourceCenterY
    closest.style.visibility = 'hidden'
    const destinationImage = closest.querySelector<HTMLElement>('.tileImg')
    const handHint: TileNextMoveClass = destinationImage?.classList.contains('tile-next-main') ? 'tile-next-main'
      : destinationImage?.classList.contains('tile-next-side') ? 'tile-next-side' : ''
    if (handHint && !flight.regularPose) {
      const tile = flight.ghost.firstElementChild as HTMLElement | null
      const povClass = [...flight.ghost.classList].find(name => /^pov-p[0-3]$/.test(name))
      if (tile && povClass) {
        flight.backOverlay?.remove(); flight.backOverlay = null
        flight.regularPose = createDiscardFlightRegularPose(tile, povClass, 0, {
          backImageSrc: shouldAnimateDiscardFaceChange(flight.seat) ? tileImageSrc('?') : undefined,
          handHint,
        })
      }
    }
    if (flight.regularPose) setBranchMark(flight.regularPose.querySelector('.tileImg'), handHint)
    return true
  }

  function schedulePendingDiscardReturnFlight(flight: PendingDiscardReturnFlight) {
    if (reduceMotionEnabled.value || document.hidden) {
      flight.ghost.remove(); flight.destination?.style.removeProperty('visibility')
      return
    }
    const generation = ++pendingDiscardReturnGeneration
    returnMotionActive.value = true
    pendingDiscardReturnGhost = flight.ghost
    pendingDiscardReturnDestination = flight.destination
    void nextTick(() => {
      if (generation !== pendingDiscardReturnGeneration) return
      pendingDiscardReturnFrame = requestAnimationFrame(() => {
        pendingDiscardReturnFrame = 0
        if (!flight.ghost.isConnected) {
          clearPendingDiscardReturnFlight()
          return
        }
        // The gap in the pending-discard frame is replaced by the returned tile
        // after Vue commits the previous node. Re-resolve the hand slot here so
        // that tile stays hidden until the reverse flight reaches it.
        if (!resolvePendingDiscardReturnDestination(flight)) {
          clearPendingDiscardReturnFlight()
          return
        }
        pendingDiscardReturnSize = observeMotionSize(flight.destination!, () => {
          if (generation !== pendingDiscardReturnGeneration || !returnMotionActive.value) return
          cancelPendingDiscardReturnFlight()
        })
        const duration = getUiMotionDurationMs()
        const easing = getUiMotionEasing()
        if (flight.backOverlay) {
          pendingDiscardReturnEffects = [animateDiscardBackOverlay(flight.backOverlay, 'reveal', duration)]
        }
        if (flight.regularPose && flight.settledImage) {
          pendingDiscardReturnEffects = animateDiscardPoseTransition(flight.regularPose, flight.settledImage, 'restore', duration,
            Boolean(flight.ghost.firstElementChild?.classList.contains('river-riichi')))
        }
        pendingDiscardReturnAnimation = flight.ghost.animate(
          [{ transform: 'translate(0px, 0px)' }, { transform: `translate(${flight.deltaX}px, ${flight.deltaY}px)` }],
          { duration, easing, fill: 'forwards' },
        )
        const movement = pendingDiscardReturnAnimation
        returnCoverage = coverageRenderer.prepare({ source: flight.ghost, effects: pendingDiscardReturnEffects,
          movement, duration, easing, dx: flight.deltaX, dy: flight.deltaY })
        const coverage = returnCoverage
        let finished = false
        const finish = () => {
          if (finished || generation !== pendingDiscardReturnGeneration) return
          finished = true
          returnCoverage?.cancel(); returnCoverage = null
          // Keep the exact endpoint visible for one paint before revealing the hand tile.
          pendingDiscardReturnFrame = requestAnimationFrame(() => {
            pendingDiscardReturnFrame = requestAnimationFrame(() => {
              pendingDiscardReturnFrame = 0
              clearPendingDiscardReturnFlight()
            })
          })
        }
        movement.onfinish = () => { if (!coverage?.waiting) finish() }
        void coverage?.finished.then(() => {
          if (generation === pendingDiscardReturnGeneration && movement.playState === 'finished') finish()
        })
      })
    })
  }

  function schedulePendingDiscardFlight(seat: number, handHint: TileNextMoveClass = '') {
    if (reduceMotionEnabled.value || document.hidden) return
    const generation = ++pendingDiscardFlightGeneration
    forwardMotionActive.value = true
    void nextTick(() => {
      if (generation !== pendingDiscardFlightGeneration) return
      if (reduceMotionEnabled.value || document.hidden) {
        cancelPendingDiscardFlight(); scheduleAutoAdvance(); return
      }
      const gap = document.querySelector<HTMLElement>(`[data-hand-gap-seat="${seat}"]`)
      const target = document.querySelector<HTMLElement>(`[data-pending-discard-seat="${seat}"]`)
      const targetTile = target?.querySelector<HTMLElement>('.tileImg')
      if (!gap || !target || !targetTile || typeof target.animate !== 'function') {
        forwardMotionActive.value = false
        scheduleAutoAdvance()
        return
      }

      const povClass = [...(target.closest<HTMLElement>('[class*="pov-p"]')?.classList || [])]
        .find((className) => /^pov-p[0-3]$/.test(className))
      const swapsPose = target.classList.contains('river-riichi')
      const regularPose = (swapsPose || handHint) && povClass
        ? createDiscardFlightRegularPose(
            target,
            povClass,
            1,
            { backImageSrc: shouldAnimateDiscardFaceChange(seat) ? tileImageSrc('?') : undefined,
              inheritDiscardTone: !handHint, handHint },
          )
        : null
      const backOverlay = !regularPose && shouldAnimateDiscardFaceChange(seat)
        ? createDiscardFlightBackOverlay(target, 1, tileImageSrc('?'), true)
        : null
      pendingDiscardFlightBackOverlay = backOverlay
      pendingDiscardFlightRegularPose = regularPose
      pendingDiscardFlightTarget = target
      // Promote only the tile that is actually in flight. Reserving layers for
      // every table tile is expensive, but promoting this one before its first
      // keyframe avoids spending the short 110 ms motion window on layer setup.
      target.style.willChange = 'transform'
      // The controlled seat has no back overlay, but must remain hidden until
      // its start keyframe is ready just like the other three seats.
      target.style.visibility = 'hidden'

      pendingDiscardFlightFrame = requestAnimationFrame(() => {
        pendingDiscardFlightFrame = 0
        if (!gap.isConnected || !target.isConnected || !targetTile.isConnected) {
          cancelPendingDiscardFlight()
          scheduleAutoAdvance()
          return
        }

        const gapRect = gap.getBoundingClientRect()
        const targetRect = targetTile.getBoundingClientRect()
        const deltaX = (gapRect.left + (gapRect.width / 2)) - (targetRect.left + (targetRect.width / 2))
        const deltaY = (gapRect.top + (gapRect.height / 2)) - (targetRect.top + (targetRect.height / 2))
        const duration = getUiMotionDurationMs()
        const easing = getUiMotionEasing()
        const finalTransform = getComputedStyle(target).transform
        const settledTransform = finalTransform === 'none' ? 'translate(0px, 0px)' : finalTransform
        pendingDiscardFlightSize = observeMotionSize(target, () => {
          if (generation !== pendingDiscardFlightGeneration || !forwardMotionActive.value) return
          cancelPendingDiscardFlight(); scheduleAutoAdvance()
        })
        if (backOverlay) {
          pendingDiscardFlightEffects = [animateDiscardBackOverlay(backOverlay, 'hide', duration)]
        }
        if (regularPose) {
          pendingDiscardFlightEffects = animateDiscardPoseTransition(regularPose, targetTile, 'settle', duration, swapsPose)
        }

        pendingDiscardFlightAnimation = target.animate(
          [{ transform: `translate3d(${deltaX}px, ${deltaY}px, 0) ${settledTransform}` }, { transform: settledTransform }],
          { duration, easing },
        )
        const movement = pendingDiscardFlightAnimation
        forwardCoverage = coverageRenderer.prepare({ source: target, effects: pendingDiscardFlightEffects,
          movement, duration, easing, dx: -deltaX, dy: -deltaY })
        const coverage = forwardCoverage
        // Face, pose and translation start together on this frame. Pausing only
        // translation lets the face change before the tile even leaves the hand.
        target.style.removeProperty('visibility')
        holdAutoAdvanceForTableMotion(duration)
        scheduleAutoAdvance()
        const finish = () => {
          if (generation !== pendingDiscardFlightGeneration) return
          cancelPendingDiscardFlight()
          scheduleAutoAdvance()
        }
        movement.onfinish = () => { if (!coverage?.waiting) finish() }
        void coverage?.finished.then(() => {
          if (generation === pendingDiscardFlightGeneration && movement.playState === 'finished') finish()
        })
      })
    })
  }

  function autoAdvanceMotionDelayMs() {
    return reduceMotionEnabled.value
      ? 0
      : Math.max(0, Math.ceil(autoAdvanceMotionNotBefore - performance.now()))
  }

  function hasPendingDiscardFlight() {
    return forwardMotionActive.value
  }

  onBeforeUnmount(() => {
    coverageRenderer.stop()
    document.removeEventListener('visibilitychange', updateCoverage)
    window.removeEventListener('resize', geometryChanged)
    cancelPendingDiscardFlight()
    cancelPendingDiscardReturnFlight()
  })

  return {
    autoAdvanceMotionDelayMs,
    cancelPendingDiscardFlight,
    cancelPendingDiscardReturnFlight,
    hasPendingDiscardFlight,
    tableMotionActive,
    holdAutoAdvanceForTableMotion,
    pendingDiscardFromTable,
    pendingDiscardSignature,
    preparePendingDiscardReturnFlight,
    schedulePendingDiscardFlight,
    schedulePendingDiscardReturnFlight,
  }
}
