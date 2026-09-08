import type { TranslationParams } from './i18n'

type Translate = (key: string, params?: TranslationParams) => string
type RuntimeState = { ready: boolean; unloaded: boolean } | null
export type EngineRuntimeKind = 'decision' | 'opponent'

export interface EngineStatusItem {
  id: string
  label: string
  state: TrainerModelActivityState
}

export function normalizeModelActivityState(value: unknown): TrainerModelActivityState {
  if (value === 'loading' || value === 'running' || value === 'error') return value
  return value === true ? 'running' : 'idle'
}

export function buildEngineStatusItems(options: {
  profiles: TrainerEngineProfile[]
  status: TrainerStatusSnapshot
  loadingProfileId: string
  loadErrors: Readonly<Record<string, string>>
  runtimeState: (profile: TrainerEngineProfile, kind: EngineRuntimeKind) => RuntimeState
  runtimeKinds: (profile: TrainerEngineProfile) => EngineRuntimeKind[]
  t: Translate
}): EngineStatusItem[] {
  const { profiles, status, loadingProfileId, loadErrors, runtimeState, runtimeKinds, t } = options
  const controlledSeat = status.controlledSeat
  const decision = (status.modelActivity?.decision || []).map(normalizeModelActivityState)
  const errors = status.modelActivity?.errors
  const performance = status.modelPerformance || { decision: [0, 0, 0, 0], opponentAnalysis: 0 }
  const statePriority: TrainerModelActivityState[] = ['error', 'loading', 'running', 'idle']
  const decisionState = statePriority.find((state) => decision.includes(state)) || 'idle'
  const relativeNames = [t('seat.self'), t('seat.shimocha'), t('seat.toimen'), t('seat.kamicha')]
  const activeRoles = relativeNames.filter((_, offset) => {
    const state = decision[(controlledSeat + offset) % 4]
    return state === 'running' || state === 'loading'
  })
  const decisionErrors = [...new Set((errors?.decision || []).filter(Boolean))] as string[]
  const decisionTimings = (performance.decision || []).filter((value) => Number.isFinite(value) && value > 0)
  const decisionAverage = decisionTimings.length
    ? decisionTimings.reduce((sum, value) => sum + value, 0) / decisionTimings.length
    : 0

  return profiles.flatMap((profile) => {
    const decisionRuntime = runtimeState(profile, 'decision')
    const opponentRuntime = runtimeState(profile, 'opponent')
    const kinds = new Set<EngineRuntimeKind>()
    if (decisionRuntime && !decisionRuntime.unloaded) kinds.add('decision')
    if (opponentRuntime && !opponentRuntime.unloaded) kinds.add('opponent')
    if (loadingProfileId === profile.id) {
      for (const kind of runtimeKinds(profile)) kinds.add(kind)
    }
    const localError = loadErrors[profile.id] || ''
    if (!kinds.size && !localError) return []

    const states: TrainerModelActivityState[] = []
    const timingValues: number[] = []
    const errorValues: string[] = localError ? [localError] : []
    if (kinds.has('decision')) {
      states.push(decisionState)
      if (decisionAverage > 0) timingValues.push(decisionAverage)
      errorValues.push(...decisionErrors)
    }
    if (kinds.has('opponent')) {
      states.push(normalizeModelActivityState(status.modelActivity?.opponentAnalysis))
      if (Number.isFinite(performance.opponentAnalysis) && performance.opponentAnalysis > 0) {
        timingValues.push(performance.opponentAnalysis)
      }
      if (errors?.opponentAnalysis) errorValues.push(String(errors.opponentAnalysis))
    }
    if (loadingProfileId === profile.id) states.push('loading')
    if (errorValues.some(Boolean)) states.push('error')
    const state = statePriority.find((candidate) => states.includes(candidate)) || 'idle'
    const averageMs = timingValues.length
      ? timingValues.reduce((sum, value) => sum + value, 0) / timingValues.length
      : 0
    const roleLabel = kinds.has('decision') && activeRoles.length
      ? ` · ${activeRoles.join(t('common.listSeparator'))}`
      : ''
    const baseLabel = `${profile.name || t('common.unnamedEngine')}${roleLabel}`
    const uniqueErrors = [...new Set(errorValues.filter(Boolean))]
    return [{
      id: profile.id,
      label: state === 'error' && uniqueErrors.length
        ? `${baseLabel}：${uniqueErrors.join('；')}`
        : averageMs > 0
          ? t('status.recentAverage', { engine: baseLabel, value: averageMs.toFixed(1) })
          : baseLabel,
      state,
    }]
  })
}
