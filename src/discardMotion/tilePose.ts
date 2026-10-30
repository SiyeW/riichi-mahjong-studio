import type { TileNextMoveClass } from '../useNextMoveHints'

export const IMAGE_POSE_PROPERTIES = ['position', 'left', 'top', 'right', 'bottom', 'float', 'transform', 'transform-origin'] as const

export function createDiscardFlightBackOverlay(
  tile: HTMLElement,
  initialOpacity: number,
  backImageSrc: string,
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
  overlay.setAttribute('src', backImageSrc)
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

export function animateDiscardBackOverlay(
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

export function createDiscardFlightRegularPose(
  tile: HTMLElement,
  povClass: string,
  initialOpacity: number,
  { backImageSrc, inheritDiscardTone = false, handHint = '' }: {
    backImageSrc?: string
    inheritDiscardTone?: boolean
    handHint?: TileNextMoveClass
  } = {},
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
  setBranchMark(poseImage, handHint)
  if (!inheritDiscardTone) poseImage.classList.remove('river-tsumogiri')
  if (backImageSrc !== undefined) {
    poseImage.src = backImageSrc
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

export function setBranchMark(image: HTMLElement | null, hint: TileNextMoveClass) {
  image?.classList.remove('tile-next-main', 'tile-next-side')
  if (hint) image?.classList.add(hint)
}

export function animateDiscardPoseTransition(
  regularPose: HTMLElement,
  settledImage: HTMLElement,
  direction: 'settle' | 'restore',
  duration: number,
  crossfade: boolean,
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
  // Same-pose branch marks are an overlay over an opaque tile, not a whole-
  // tile crossfade (which would dim it halfway through an ordinary discard).
  if (!crossfade) return [regularAnimation]
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
