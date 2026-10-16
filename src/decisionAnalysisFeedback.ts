import type { DecisionAnalysis } from './contracts/game'
import type { ModelActivityState, ModelRuntimeState } from './contracts/engines'

export function decisionAnalysisHasRows(analysis: DecisionAnalysis | null | undefined): boolean {
  return Boolean(analysis?.discardEntries?.length || analysis?.specialEntries?.length || analysis?.reactionEntries?.length)
}

export function decisionAnalysisFeedback(analysis: DecisionAnalysis | null, eligible: boolean,
  activity: ModelActivityState, runtime: ModelRuntimeState, modelError?: string | null) {
  if (!eligible) return { pending: false, error: '' }
  if (analysis?.error) return { pending: false, error: analysis.error }
  if (analysis?.context?.dataState === 'reading') return { pending: true, error: '' }
  if (decisionAnalysisHasRows(analysis) && analysis?.context?.dataState !== 'running') return { pending: false, error: '' }
  if (activity === 'error') return { pending: false, error: modelError || '' }
  return { pending: !runtime.unloaded && (analysis?.context?.dataState === 'running'
    || activity === 'running' || activity === 'loading'), error: '' }
}
