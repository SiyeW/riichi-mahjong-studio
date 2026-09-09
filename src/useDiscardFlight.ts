import { computed, nextTick, onBeforeUnmount, watch, type Ref } from 'vue'
import { getUiMotionDurationMs, getUiMotionEasing } from './uiMotion'
import type { GameView } from './contracts/game'
import type { StudioStatus } from './contracts/runtime'

export type PendingDiscardView = NonNullable<NonNullable<GameView['table']>['pendingDiscard']>
export type GameViewTransitionDirection = 'forward' | 'backward'

export interface PendingDiscardReturnFlight {
  ghost: HTMLElement
  destination: HTMLElement
  backOverlay: HTMLElement | null
  regularPose: HTMLElement | null
  settledImage: HTMLElement | null
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

let pendingDiscardFlightFrame = 0
let pendingDiscardFlightAnimation: Animation | null = null
let pendingDiscardFlightBackOverlay: HTMLElement | null = null
let pendingDiscardFlightRegularPose: HTMLElement | null = null
let pendingDiscardFlightTarget: HTMLElement | null = null
let pendingDiscardReturnFrame = 0
let pendingDiscardReturnAnimation: Animation | null = null
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

function pendingDiscardSignature(pending: PendingDiscardView | null): string {
  if (!pending) return ''
  return [pending.actor, pending.pai, pending.tsumogiri ? 1 : 0, pending.riichi ? 1 : 0].join('|')
}

function cancelPendingDiscardFlight() {
  if (pendingDiscardFlightFrame) {
    cancelAnimationFrame(pendingDiscardFlightFrame)
    pendingDiscardFlightFrame = 0
  }
  pendingDiscardFlightAnimation?.cancel()
  pendingDiscardFlightAnimation = null
  pendingDiscardFlightBackOverlay?.remove()
  pendingDiscardFlightBackOverlay = null
  pendingDiscardFlightRegularPose?.remove()
  pendingDiscardFlightRegularPose = null
  pendingDiscardFlightTarget?.style.removeProperty('visibility')
  pendingDiscardFlightTarget = null
}

function clearPendingDiscardReturnFlight() {
  pendingDiscardReturnGhost?.remove()
  pendingDiscardReturnDestination?.style.removeProperty('visibility')
  pendingDiscardReturnGhost = null
  pendingDiscardReturnDestination = null
}

function cancelPendingDiscardReturnFlight() {
  if (pendingDiscardReturnFrame) {
    cancelAnimationFrame(pendingDiscardReturnFrame)
    pendingDiscardReturnFrame = 0
  }
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
  overlay.style.left = `${sourceImage.offsetLeft}px`
  overlay.style.top = `${sourceImage.offsetTop}px`
  overlay.style.right = 'auto'
  overlay.style.bottom = 'auto'
  overlay.style.transform = sourceStyle.transform
  overlay.style.transformOrigin = sourceStyle.transformOrigin
  overlay.style.opacity = `${initialOpacity}`
  tile.appendChild(overlay)
  const sourceRect = sourceImage.getBoundingClientRect()
  const overlayRect = overlay.getBoundingClientRect()
  overlay.style.left = `${sourceImage.offsetLeft + sourceRect.left - overlayRect.left}px`
  overlay.style.top = `${sourceImage.offsetTop + sourceRect.top - overlayRect.top}px`
  return overlay
}

function animateDiscardBackOverlay(
  overlay: HTMLElement,
  direction: 'reveal' | 'hide',
  duration: number,
) {
  const visible = direction === 'reveal' ? '1' : '0'
  const hidden = direction === 'reveal' ? '0' : '1'
  overlay.animate(
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
  regularPose.animate(
    [
      { opacity: regularVisible, offset: 0 },
      { opacity: regularVisible, offset: 0.2 },
      { opacity: regularHidden, offset: 0.75 },
      { opacity: regularHidden, offset: 1 },
    ],
    { duration, easing: 'linear', fill: 'forwards' },
  )
  settledImage.animate(
    [
      { opacity: regularHidden, offset: 0 },
      { opacity: regularHidden, offset: 0.2 },
      { opacity: regularVisible, offset: 0.75 },
      { opacity: regularVisible, offset: 1 },
    ],
    { duration, easing: 'linear', fill: 'forwards' },
  )
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
    deltaX: (destinationRect.left + (destinationRect.width / 2)) - (sourceVisualRect.left + (sourceVisualRect.width / 2)),
    deltaY: (destinationRect.top + (destinationRect.height / 2)) - (sourceVisualRect.top + (sourceVisualRect.height / 2)),
  }
}

function schedulePendingDiscardReturnFlight(flight: PendingDiscardReturnFlight) {
  pendingDiscardReturnGhost = flight.ghost
  pendingDiscardReturnDestination = flight.destination
  void nextTick(() => {
    pendingDiscardReturnFrame = requestAnimationFrame(() => {
      pendingDiscardReturnFrame = 0
      if (!flight.ghost.isConnected) {
        clearPendingDiscardReturnFlight()
        return
      }
      const duration = getUiMotionDurationMs()
      const easing = getUiMotionEasing()
      if (flight.backOverlay) {
        animateDiscardBackOverlay(flight.backOverlay, 'reveal', duration)
      }
      if (flight.regularPose && flight.settledImage) {
        animateDiscardPoseSwap(flight.regularPose, flight.settledImage, 'restore', duration)
      }
      pendingDiscardReturnAnimation = flight.ghost.animate(
        [
          { transform: 'translate(0px, 0px)' },
          { transform: `translate(${flight.deltaX}px, ${flight.deltaY}px)` },
        ],
        { duration, easing, fill: 'forwards' },
      )
      pendingDiscardReturnAnimation.onfinish = () => {
        pendingDiscardReturnAnimation = null
        // Keep the exact endpoint visible for one paint before revealing the hand tile.
        pendingDiscardReturnFrame = requestAnimationFrame(() => {
          pendingDiscardReturnFrame = requestAnimationFrame(() => {
            pendingDiscardReturnFrame = 0
            clearPendingDiscardReturnFlight()
          })
        })
      }
      pendingDiscardReturnAnimation.oncancel = () => {
        pendingDiscardReturnAnimation = null
      }
    })
  })
}

function schedulePendingDiscardFlight(seat: number) {
  if (reduceMotionEnabled.value) return
  void nextTick(() => {
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
        animateDiscardBackOverlay(backOverlay, 'hide', duration)
      }
      if (regularPose) {
        animateDiscardPoseSwap(regularPose, targetTile, 'settle', duration)
      }

      pendingDiscardFlightAnimation = target.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px) ${settledTransform}` },
          { transform: settledTransform },
        ],
        { duration, easing },
      )
      pendingDiscardFlightAnimation.pause()
      pendingDiscardFlightAnimation.currentTime = 0
      target.style.removeProperty('visibility')
      pendingDiscardFlightFrame = requestAnimationFrame(() => {
        pendingDiscardFlightFrame = 0
        if (!target.isConnected || pendingDiscardFlightAnimation === null) return
        holdAutoAdvanceForTableMotion(duration)
        scheduleAutoAdvance()
        pendingDiscardFlightAnimation.play()
      })
      pendingDiscardFlightAnimation.onfinish = () => {
        pendingDiscardFlightAnimation = null
        backOverlay?.remove()
        regularPose?.remove()
        if (pendingDiscardFlightBackOverlay === backOverlay) {
          pendingDiscardFlightBackOverlay = null
        }
        if (pendingDiscardFlightRegularPose === regularPose) {
          pendingDiscardFlightRegularPose = null
        }
        if (pendingDiscardFlightTarget === target) {
          pendingDiscardFlightTarget = null
        }
        scheduleAutoAdvance()
      }
      pendingDiscardFlightAnimation.oncancel = () => {
        pendingDiscardFlightAnimation = null
        backOverlay?.remove()
        regularPose?.remove()
        if (pendingDiscardFlightBackOverlay === backOverlay) {
          pendingDiscardFlightBackOverlay = null
        }
        if (pendingDiscardFlightRegularPose === regularPose) {
          pendingDiscardFlightRegularPose = null
        }
        target.style.removeProperty('visibility')
        if (pendingDiscardFlightTarget === target) {
          pendingDiscardFlightTarget = null
        }
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

  onBeforeUnmount(() => {
    cancelPendingDiscardFlight()
    cancelPendingDiscardReturnFlight()
  })

  return {
    autoAdvanceMotionDelayMs,
    cancelPendingDiscardFlight,
    cancelPendingDiscardReturnFlight,
    hasPendingDiscardFlight,
    holdAutoAdvanceForTableMotion,
    pendingDiscardFromTable,
    pendingDiscardSignature,
    preparePendingDiscardReturnFlight,
    schedulePendingDiscardFlight,
    schedulePendingDiscardReturnFlight,
  }
}
