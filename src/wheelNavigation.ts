export interface NavigationWheelInput {
  deltaY: number
  deltaMode: number
  isTrusted?: boolean
  ctrlKey?: boolean
  wheelDeltaY?: number
}

// Chromium's native wheel ticks retain detents when pixel deltas depend on OS
// scroll settings. Validated through WM_MOUSEWHEEL at DPR 1, 1.25 and 2. Do not
// use script-created wheelDeltaY: Blink initializes that from deltaY differently.
// The standard-only fallback defines navigation sensitivity, not hardware ticks.
function wheelSteps(event: NavigationWheelInput) {
  const { deltaY, deltaMode, wheelDeltaY } = event
  if (!Number.isFinite(deltaY) || !deltaY || event.ctrlKey) return 0
  if (deltaMode === 2) return deltaY
  if (deltaMode === 1) return deltaY / 3
  if (deltaMode !== 0) return 0
  if (event.isTrusted && Number.isFinite(wheelDeltaY) && wheelDeltaY! * deltaY < 0) {
    return -wheelDeltaY! / 120
  }
  return deltaY / 100
}

export function createWheelStepAccumulator() {
  let remainder = 0
  return {
    reset() { remainder = 0 },
    consume(event: NavigationWheelInput) {
      remainder += wheelSteps(event)
      const steps = Math.trunc(remainder + Math.sign(remainder) * 1e-9)
      remainder -= steps
      return steps || 0
    },
  }
}
