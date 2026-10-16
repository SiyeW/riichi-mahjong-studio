export type MotionSample = { progress: number; previousProgress: number; blurLength: number; backOpacity: number }

export function updateInterval(hz: number, every: number) {
  const interval = 1000 * every / hz
  return Number.isFinite(interval) && interval > 0 ? interval : 0
}

export function sweepSampleCount(distance: number, tileSpan: number) {
  return Math.max(8, Math.min(64, Math.ceil(distance / (tileSpan * 0.5)) + 1))
}

export function sweepOffsets(length: number, count: number) {
  return Array.from({ length: count }, (_, index) => index === count - 1 ? 0 : -length * (1 - index / (count - 1)))
}

export function sampledTime(elapsed: number, duration: number, hz: number, every: number) {
  if (elapsed >= duration) return duration
  if (elapsed <= 0) return 0
  const interval = updateInterval(hz, every)
  if (!interval) return duration
  return Math.floor(elapsed / interval) * interval
}

export function motionSample(time: number, duration: number, distance: number, exposure: number,
  reverse: boolean, ease: (progress: number) => number): MotionSample {
  if (duration <= 0) return { progress: 1, previousProgress: 1, blurLength: 0, backOpacity: reverse ? 1 : 0 }
  const current = Math.max(0, Math.min(duration, time))
  const progress = ease(current / duration)
  const previousProgress = ease(Math.max(0, current - exposure) / duration)
  const fade = Math.max(0, Math.min(1, (current / duration - 0.2) / 0.55))
  // Cover the complete previous-to-current interval, rather than centering a
  // short Gaussian around the current position. Spatial weights are uniform;
  // face/pose still comes from the current sample, not a historical image.
  const blurLength = distance * Math.abs(progress - previousProgress)
  return { progress, previousProgress, blurLength, backOpacity: reverse ? fade : 1 - fade }
}
