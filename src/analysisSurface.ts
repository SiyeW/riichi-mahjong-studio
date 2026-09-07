import { computed } from 'vue'
import type { PerceptualSurfaceBinding } from './perceptualSurface.ts'

export function analysisSurface(
  surface: () => PerceptualSurfaceBinding,
  debugLabel: string,
  surfaceLayerVariables: readonly string[] = [],
) {
  return computed<PerceptualSurfaceBinding>(() => ({
    ...surface(),
    debugLabel,
    surfaceLayerVariables,
  }))
}
