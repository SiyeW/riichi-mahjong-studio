import type { StudioSettings } from './contracts/settings'

const TRAINING_MODE_ALIASES: Readonly<Record<string, StudioSettings['training']['mode']>> = {
  no_review: 'no_review',
  free_play: 'preview_before_click',
  guided: 'threshold_review',
  strict: 'always_review',
  preview_before_click: 'preview_before_click',
  threshold_review: 'threshold_review',
  always_review: 'always_review',
}

export function normalizeTrainingMode(value: unknown): StudioSettings['training']['mode'] {
  return TRAINING_MODE_ALIASES[String(value || '')] || 'threshold_review'
}
