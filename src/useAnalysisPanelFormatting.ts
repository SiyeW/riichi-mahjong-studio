import { useI18n } from './i18n.ts'
import { createAnalysisFormatting } from './analysisFormatting.ts'

export function useAnalysisPanelFormatting() {
  const { t, numberLocale } = useI18n()
  return { t, numberLocale, ...createAnalysisFormatting(t, numberLocale) }
}
