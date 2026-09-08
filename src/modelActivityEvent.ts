import { normalizeModelActivityState } from './engineStatusItems.ts'

export interface ModelActivityEventResult {
  opponentFailed: boolean
}

export function applyModelActivityEvent(
  status: TrainerStatusSnapshot,
  event: TrainerPythonEvent,
  unknownError: string,
): ModelActivityEventResult {
  const activityState = normalizeModelActivityState(event.activityState ?? event.active)
  const averageMs = Number(event.averageMs)
  const errors = status.modelActivity?.errors || {
    decision: [null, null, null, null],
    opponentAnalysis: null,
  }

  if (event.model === 'decision' && Number.isInteger(event.seat)) {
    if (event.runtime) status.modelRuntime.decision = { ...event.runtime }
    const seat = Number(event.seat)
    if (seat >= 0 && seat < 4) {
      const decision = [...(status.modelActivity?.decision || ['idle', 'idle', 'idle', 'idle'])]
      const decisionErrors = [...errors.decision]
      const decisionPerformance = [...(status.modelPerformance?.decision || [0, 0, 0, 0])]
      decision[seat] = activityState
      decisionErrors[seat] = activityState === 'error' ? String(event.error || unknownError) : null
      if (Number.isFinite(averageMs) && averageMs >= 0) decisionPerformance[seat] = averageMs
      status.modelPerformance = {
        decision: decisionPerformance,
        opponentAnalysis: status.modelPerformance?.opponentAnalysis || 0,
      }
      status.modelActivity = {
        decision,
        opponentAnalysis: normalizeModelActivityState(status.modelActivity?.opponentAnalysis),
        errors: {
          decision: decisionErrors,
          opponentAnalysis: errors.opponentAnalysis,
        },
      }
    }
    return { opponentFailed: false }
  }

  if (event.model === 'opponent_analysis') {
    if (event.runtime) status.modelRuntime.opponentAnalysis = { ...event.runtime }
    if (Number.isFinite(averageMs) && averageMs >= 0) {
      status.modelPerformance = {
        decision: [...(status.modelPerformance?.decision || [0, 0, 0, 0])],
        opponentAnalysis: averageMs,
      }
    }
    status.modelActivity = {
      decision: [...(status.modelActivity?.decision || ['idle', 'idle', 'idle', 'idle'])]
        .map(normalizeModelActivityState),
      opponentAnalysis: activityState,
      errors: {
        decision: [...errors.decision],
        opponentAnalysis: activityState === 'error' ? String(event.error || unknownError) : null,
      },
    }
    return { opponentFailed: activityState === 'error' }
  }

  return { opponentFailed: false }
}
