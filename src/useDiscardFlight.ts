import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { getUiMotionDurationMs, getUiMotionEasing } from './uiMotion'
import { createExposureSampler, prepareDiscardCoverage, type DiscardCoverage } from './discardCoverage'
import { flightTranslationFrames } from './discardCoverageModel'
import type { GameView } from './contracts/game'
import type { StudioStatus } from './contracts/runtime'

const IMAGE_POSE_PROPERTIES = ['position', 'left', 'top', 'right', 'bottom', 'float', 'transform', 'transform-origin'] as const

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
  tileImageSrc: (tile: string) => string
  scheduleAutoAdvance: () => void
}) {
  const { status, reduceMotionEnabled, tileImageSrc, scheduleAutoAdvance } = options
  const coverageTrialEnabled = ref(false)
  const exposureSampler = createExposureSampler(() => hasPendingTableMotion())
  let forwardCoverage: DiscardCoverage | null = null
  let returnCoverage: DiscardCoverage | null = null
  const updateSampler = () => {
    if (import.meta.env.DEV && coverageTrialEnabled.value && !reduceMotionEnabled.value && !document.hidden) exposureSampler.start()
    else exposureSampler.stop()
    if (!coverageTrialEnabled.value || document.hidden) {
      forwardCoverage?.cancel(); forwardCoverage = null
      returnCoverage?.cancel(); returnCoverage = null
    }
  }
  document.addEventListener('visibilitychange', updateSampler)
  watch([coverageTrialEnabled, reduceMotionEnabled], updateSampler)
  const trialExposure = () => import.meta.env.DEV && coverageTrialEnabled.value
    && !reduceMotionEnabled.value ? exposureSampler.exposure() : 0

let pendingDiscardFlightFrame = 0
let pendingDiscardFlightAnimation: Animation | null = null
let pendingDiscardFlightEffects: Animation[] = []
let pendingDiscardFlightGeneration = 0
let pendingDiscardFlightBackOverlay: HTMLElement | null = null
let pendingDiscardFlightRegularPose: HTMLElement | null = null
let pendingDiscardFlightTarget: HTMLElement | null = null
let pendingDiscardReturnFrame = 0
let pendingDiscardReturnAnimation: Animation | null = null
let pendingDiscardReturnEffects: Animation[] = []
let pendingDiscardReturnGeneration = 0
let pendingDiscardReturnGhost: HTMLElement | null = null
let pendingDiscardReturnDestination: HTMLElement | null = null
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
}

function clearPendingDiscardReturnFlight() {
  returnCoverage?.cancel()
  returnCoverage = null
  pendingDiscardReturnEffects.forEach(animation => animation.cancel())
  pendingDiscardReturnEffects = []
  pendingDiscardReturnGhost?.remove()
  pendingDiscardReturnDestination?.style.removeProperty('visibility')
  pendingDiscardReturnGhost = null
  pendingDiscardReturnDestination = null
}

function cancelPendingDiscardReturnFlight() {
  pendingDiscardReturnGeneration += 1
  if (pendingDiscardReturnFrame) {
    cancelAnimationFrame(pendingDiscardReturnFrame)
    pendingDiscardReturnFrame = 0
  }
  if (pendingDiscardReturnAnimation) pendingDiscardReturnAnimation.onfinish = null
  pendingDiscardReturnAnimation?.cancel()
  pendingDiscardReturnAnimation = null
  clearPendingDiscardReturnFlight()
}

function shouldAnimateDiscardFaceChange(seat: number): boolean {
  return seat !== status.controlledSeat && !status.visibleHands
}

function createDiscardFlightBackOverlay(
  tile: HTMLElement,
  initialOpacity: number,
  inheritDiscardTone = false,
): HTMLElement | null {
  const sourceImage = tile.querySelector<HTMLElement>('.tileImg:not(.discard-flight-back)')
  if (!sourceImage) return null

  const sourceStyle = getComputedStyle(sourceImage)
  const overlay = document.createElement('img')
  overlay.className = 'tileImg discard-flight-back'
  if (inheritDiscardTone && sourceImage.classList.contains('river-tsumogiri')) {
    overlay.classList.add('river-tsumogiri')
  }
  overlay.setAttribute('src', tileImageSrc('?'))
  overlay.setAttribute('alt', '')
  overlay.setAttribute('aria-hidden', 'true')
  overlay.style.width = sourceStyle.width
  overlay.style.height = sourceStyle.height
  // Preserve right alignment in CSS: offsetLeft rounds fractional tile widths
  // and makes the upper player's face/back edges separate during the fade.
  const rightAligned = sourceStyle.cssFloat === 'right' && sourceStyle.position !== 'absolute'
  overlay.style.left = rightAligned ? 'auto' : `${sourceImage.offsetLeft}px`
  overlay.style.top = `${sourceImage.offsetTop}px`
  overlay.style.right = rightAligned ? '0px' : 'auto'
  overlay.style.bottom = 'auto'
  overlay.style.transform = sourceStyle.transform
  overlay.style.transformOrigin = sourceStyle.transformOrigin
  overlay.style.opacity = `${initialOpacity}`
  tile.appendChild(overlay)
  return overlay
}

function animateDiscardBackOverlay(
  overlay: HTMLElement,
  direction: 'reveal' | 'hide',
  duration: number,
) {
  const visible = direction === 'reveal' ? '1' : '0'
  const hidden = direction === 'reveal' ? '0' : '1'
  return overlay.animate(
    [
      { opacity: hidden, offset: 0 },
      { opacity: hidden, offset: 0.2 },
      { opacity: visible, offset: 0.75 },
      { opacity: visible, offset: 1 },
    ],
    { duration, easing: 'linear', fill: 'forwards' },
  )
}

function createDiscardFlightRegularPose(
  tile: HTMLElement,
  povClass: string,
  initialOpacity: number,
  useBackImage: boolean,
  inheritDiscardTone: boolean,
): HTMLElement | null {
  const sourceImage = tile.querySelector<HTMLElement>('.tileImg:not(.discard-flight-back)')
  if (!sourceImage) return null

  const pose = document.createElement('span')
  pose.className = `discard-flight-regular-pose ${povClass}`
  pose.style.opacity = `${initialOpacity}`

  const poseTile = tile.cloneNode(true) as HTMLElement
  poseTile.classList.remove('river-riichi', 'tileDivPending', 'history-jump-target')
  poseTile.removeAttribute('data-pending-discard-seat')
  poseTile.style.removeProperty('width')
  poseTile.style.removeProperty('height')
  const poseImage = poseTile.querySelector<HTMLImageElement>('.tileImg')
  if (!poseImage) return null
  // A return clone carries the river image's settled pose inline. Its regular
  // hand pose must instead use the ordinary orientation rules below.
  IMAGE_POSE_PROPERTIES.forEach(property => poseImage.style.removeProperty(property))
  poseImage.classList.remove('river-riichi', 'last-discard')
  if (!inheritDiscardTone) poseImage.classList.remove('river-tsumogiri')
  if (useBackImage) {
    poseImage.src = tileImageSrc('?')
    poseImage.alt = ''
    poseImage.setAttribute('aria-hidden', 'true')
  }

  pose.appendChild(poseTile)
  tile.appendChild(pose)
  const settledRect = sourceImage.getBoundingClientRect()
  const regularRect = poseImage.getBoundingClientRect()
  const centerOffsetX = ((settledRect.left + settledRect.right) - (regularRect.left + regularRect.right)) / 2
  const centerOffsetY = ((settledRect.top + settledRect.bottom) - (regularRect.top + regularRect.bottom)) / 2
  pose.style.left = `calc(50% + ${centerOffsetX}px)`
  pose.style.top = `calc(50% + ${centerOffsetY}px)`
  return pose
}

function animateDiscardPoseSwap(
  regularPose: HTMLElement,
  settledImage: HTMLElement,
  direction: 'settle' | 'restore',
  duration: number,
) {
  const regularVisible = direction === 'settle' ? '1' : '0'
  const regularHidden = direction === 'settle' ? '0' : '1'
  const regularAnimation = regularPose.animate(
    [
      { opacity: regularVisible, offset: 0 },
      { opacity: regularVisible, offset: 0.2 },
      { opacity: regularHidden, offset: 0.75 },
      { opacity: regularHidden, offset: 1 },
    ],
    { duration, easing: 'linear', fill: 'forwards' },
  )
  const settledAnimation = settledImage.animate(
    [
      { opacity: regularHidden, offset: 0 },
      { opacity: regularHidden, offset: 0.2 },
      { opacity: regularVisible, offset: 0.75 },
      { opacity: regularVisible, offset: 1 },
    ],
    { duration, easing: 'linear', fill: 'forwards' },
  )
  return [regularAnimation, settledAnimation]
}

function preparePendingDiscardReturnFlight(seat: number): PendingDiscardReturnFlight | null {
  if (reduceMotionEnabled.value) return null
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
        shouldAnimateDiscardFaceChange(seat),
        false,
      )
    : null
  const backOverlay = !regularPose && shouldAnimateDiscardFaceChange(seat)
    ? createDiscardFlightBackOverlay(clonedTile, 0)
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
  return true
}

function schedulePendingDiscardReturnFlight(flight: PendingDiscardReturnFlight) {
  const generation = ++pendingDiscardReturnGeneration
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
      const duration = getUiMotionDurationMs()
      const easing = getUiMotionEasing()
      if (flight.backOverlay) {
        pendingDiscardReturnEffects = [animateDiscardBackOverlay(flight.backOverlay, 'reveal', duration)]
      }
      if (flight.regularPose && flight.settledImage) {
        pendingDiscardReturnEffects = animateDiscardPoseSwap(flight.regularPose, flight.settledImage, 'restore', duration)
      }
      returnCoverage = flight.settledImage ? prepareDiscardCoverage({
        source: flight.ghost, image: flight.settledImage, effects: pendingDiscardReturnEffects,
        duration, exposure: trialExposure(), fromX: 0, fromY: 0, toX: flight.deltaX, toY: flight.deltaY,
      }) : null
      const total = returnCoverage?.duration ?? duration
      pendingDiscardReturnAnimation = flight.ghost.animate(
        flightTranslationFrames('translate(0px, 0px)', `translate(${flight.deltaX}px, ${flight.deltaY}px)`, duration, total, easing),
        { duration: total, easing: total > duration ? 'linear' : easing, fill: 'forwards' },
      )
      const start = returnCoverage?.startTime
      if (returnCoverage && typeof start === 'number') {
        pendingDiscardReturnAnimation.startTime = start
        pendingDiscardReturnEffects.forEach(animation => { animation.startTime = start })
      }
      pendingDiscardReturnAnimation.onfinish = () => {
        if (generation !== pendingDiscardReturnGeneration) return
        pendingDiscardReturnAnimation = null
        // Keep the exact endpoint visible for one paint before revealing the hand tile.
        pendingDiscardReturnFrame = requestAnimationFrame(() => {
          pendingDiscardReturnFrame = requestAnimationFrame(() => {
            pendingDiscardReturnFrame = 0
            clearPendingDiscardReturnFlight()
          })
        })
      }
    })
  })
}

function schedulePendingDiscardFlight(seat: number) {
  if (reduceMotionEnabled.value) return
  const generation = ++pendingDiscardFlightGeneration
  void nextTick(() => {
    if (generation !== pendingDiscardFlightGeneration) return
    const gap = document.querySelector<HTMLElement>(`[data-hand-gap-seat="${seat}"]`)
    const target = document.querySelector<HTMLElement>(`[data-pending-discard-seat="${seat}"]`)
    const targetTile = target?.querySelector<HTMLElement>('.tileImg')
    if (!gap || !target || !targetTile || typeof target.animate !== 'function') return

    const povClass = [...(target.closest<HTMLElement>('[class*="pov-p"]')?.classList || [])]
      .find((className) => /^pov-p[0-3]$/.test(className))
    const regularPose = target.classList.contains('river-riichi') && povClass
      ? createDiscardFlightRegularPose(
          target,
          povClass,
          1,
          shouldAnimateDiscardFaceChange(seat),
          true,
        )
      : null
    const backOverlay = !regularPose && shouldAnimateDiscardFaceChange(seat)
      ? createDiscardFlightBackOverlay(target, 1, true)
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
      if (backOverlay) {
        pendingDiscardFlightEffects = [animateDiscardBackOverlay(backOverlay, 'hide', duration)]
      }
      if (regularPose) {
        pendingDiscardFlightEffects = animateDiscardPoseSwap(regularPose, targetTile, 'settle', duration)
      }

      forwardCoverage = prepareDiscardCoverage({
        source: target, image: targetTile, effects: pendingDiscardFlightEffects,
        duration, exposure: trialExposure(), fromX: deltaX, fromY: deltaY, toX: 0, toY: 0,
      })
      const total = forwardCoverage?.duration ?? duration
      pendingDiscardFlightAnimation = target.animate(
        flightTranslationFrames(`translate3d(${deltaX}px, ${deltaY}px, 0) ${settledTransform}`, settledTransform, duration, total, easing),
        { duration: total, easing: total > duration ? 'linear' : easing },
      )
      const start = forwardCoverage?.startTime
      if (forwardCoverage && typeof start === 'number') {
        pendingDiscardFlightAnimation.startTime = start
        pendingDiscardFlightEffects.forEach(animation => { animation.startTime = start })
      }
      // Face, pose and translation start together on this frame. Pausing only
      // translation lets the face change before the tile even leaves the hand.
      target.style.removeProperty('visibility')
      holdAutoAdvanceForTableMotion(total)
      scheduleAutoAdvance()
      pendingDiscardFlightAnimation.onfinish = () => {
        if (generation !== pendingDiscardFlightGeneration) return
        pendingDiscardFlightAnimation = null
        forwardCoverage?.cancel()
        forwardCoverage = null
        pendingDiscardFlightEffects.forEach(animation => animation.cancel())
        pendingDiscardFlightEffects = []
        backOverlay?.remove()
        regularPose?.remove()
        if (pendingDiscardFlightBackOverlay === backOverlay) {
          pendingDiscardFlightBackOverlay = null
        }
        if (pendingDiscardFlightRegularPose === regularPose) {
          pendingDiscardFlightRegularPose = null
        }
        if (pendingDiscardFlightTarget === target) {
          target.style.removeProperty('will-change')
          pendingDiscardFlightTarget = null
        }
        scheduleAutoAdvance()
      }
    })
  })
}

watch(reduceMotionEnabled, (reduced) => {
  if (!reduced) return
  cancelPendingDiscardFlight()
  cancelPendingDiscardReturnFlight()
})



  function autoAdvanceMotionDelayMs() {
    return reduceMotionEnabled.value
      ? 0
      : Math.max(0, Math.ceil(autoAdvanceMotionNotBefore - performance.now()))
  }

  function hasPendingDiscardFlight() {
    return pendingDiscardFlightAnimation !== null
  }

  function hasPendingTableMotion() {
    return pendingDiscardFlightAnimation !== null || pendingDiscardReturnAnimation !== null
      || pendingDiscardFlightFrame !== 0 || pendingDiscardReturnFrame !== 0
  }

  onBeforeUnmount(() => {
    exposureSampler.stop()
    document.removeEventListener('visibilitychange', updateSampler)
    cancelPendingDiscardFlight()
    cancelPendingDiscardReturnFlight()
  })

  return {
    coverageTrialEnabled,
    autoAdvanceMotionDelayMs,
    cancelPendingDiscardFlight,
    cancelPendingDiscardReturnFlight,
    hasPendingDiscardFlight,
    hasPendingTableMotion,
    holdAutoAdvanceForTableMotion,
    pendingDiscardFromTable,
    pendingDiscardSignature,
    preparePendingDiscardReturnFlight,
    schedulePendingDiscardFlight,
    schedulePendingDiscardReturnFlight,
  }
}
