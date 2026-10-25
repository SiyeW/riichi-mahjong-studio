export interface MotionProbeSurface {
  visible: boolean
  focused: boolean
  opacity: number
  mode: string
  maximized: boolean
  contentBounds: { x: number; y: number; width: number; height: number }
  documentVisibility: string
  pixelRatio: number
  invalidations: number
  power: { idleState: string }
  display: { id: number; displayFrequency: number; scaleFactor: number }
  bounds: { x: number; y: number; width: number; height: number }
}

/** Eligibility only: this does not turn callbacks into physically presented frames. */
export function stableForegroundSample(before: MotionProbeSurface, after: MotionProbeSurface): boolean {
  const foreground = (surface: MotionProbeSurface) => surface.mode === 'native'
    && surface.visible && surface.focused && surface.opacity === 1
    && surface.documentVisibility === 'visible'
    && ['active', 'idle'].includes(surface.power.idleState)
    && Number.isFinite(surface.pixelRatio) && surface.pixelRatio > 0
    && surface.bounds.width > 0 && surface.bounds.height > 0
    && typeof surface.maximized === 'boolean'
    && surface.contentBounds.width > 0 && surface.contentBounds.height > 0
    && Number.isFinite(surface.display.displayFrequency) && surface.display.displayFrequency > 0
  return foreground(before) && foreground(after)
    && before.invalidations === after.invalidations
    && before.pixelRatio === after.pixelRatio
    && before.maximized === after.maximized
    && before.display.id === after.display.id
    && before.display.displayFrequency === after.display.displayFrequency
    && before.display.scaleFactor === after.display.scaleFactor
    && before.bounds.x === after.bounds.x && before.bounds.y === after.bounds.y
    && before.bounds.width === after.bounds.width && before.bounds.height === after.bounds.height
    && before.contentBounds.x === after.contentBounds.x && before.contentBounds.y === after.contentBounds.y
    && before.contentBounds.width === after.contentBounds.width && before.contentBounds.height === after.contentBounds.height
}
