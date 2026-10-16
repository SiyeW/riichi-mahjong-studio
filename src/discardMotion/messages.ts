import type { OpacityStop } from './integral'

export interface MotionGeometry {
  width: number; height: number; spriteWidth: number; spriteHeight: number
  startX: number; startY: number; dx: number; dy: number; axisX: number; axisY: number
}
export type MotionRequest =
  | { type: 'init'; canvas: OffscreenCanvas }
  | { type: 'prepare'; id: number; geometry: MotionGeometry; planes: ImageBitmap[];
      mode: 'single' | 'overlay' | 'crossfade'; stops: OpacityStop[][]; duration: number; easing: string }
  | { type: 'start'; id: number; absoluteTime: number }
  | { type: 'cancel'; id: number }

export interface SubmittedInterval { time: number; previous: number; progress: number; span: number }
export type MotionReply =
  | { type: 'warm' }
  | { type: 'ready'; id: number; preparationMs: number }
  | { type: 'done'; id: number; intervals: SubmittedInterval[] }
  | { type: 'failed'; id: number; reason: string }
