import type { OpacityStop } from './integral'

export interface MotionGeometry {
  width: number; height: number; spriteWidth: number; spriteHeight: number
  startX: number; startY: number; dx: number; dy: number; axisX: number; axisY: number
}
export type MotionRequest =
  | { type: 'init'; canvas: OffscreenCanvas; diagnostics?: boolean }
  | { type: 'prepare'; id: number; geometry: MotionGeometry; pixels: Uint8ClampedArray; planeCount: 1 | 2;
      mode: 'single' | 'overlay' | 'crossfade'; stops: OpacityStop[][]; duration: number; easing: string }
  | { type: 'start'; id: number; absoluteTime: number }
  | { type: 'cancel'; id: number }

// Absolute clock endpoints in ms; span is in physical canvas pixels.
export interface SubmittedInterval { fromTime: number; time: number; previous: number; progress: number; span: number }
export type MotionReply =
  | { type: 'warm' }
  | { type: 'ready'; id: number; preparationMs: number }
  | { type: 'done'; id: number; intervals?: SubmittedInterval[] }
  | { type: 'failed'; id: number; reason: string }
