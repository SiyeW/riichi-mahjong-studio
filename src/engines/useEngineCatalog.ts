import { computed, reactive, type Ref } from 'vue'
import type { DesktopBridge } from '../contracts/desktopBridge.ts'
import type { EngineDescription, EngineOutputId, EngineProfile } from '../contracts/engines.ts'
import type { StudioSettings } from '../contracts/settings.ts'

export type SupportedEngineOutputId = EngineOutputId

export const SUPPORTED_ENGINE_OUTPUT_DEFINITIONS: ReadonlyArray<{
  id: SupportedEngineOutputId
  labelKey: string
}> = [
  { id: 'action-recommendation', labelKey: 'analysis.output.action' },
  { id: 'opponent-shanten', labelKey: 'analysis.output.shanten' },
  { id: 'opponent-deal-in-probability', labelKey: 'analysis.output.dealIn' },
  { id: 'opponent-concealed-tile-count', labelKey: 'analysis.output.concealedTiles' },
  { id: 'wall-tile-count', labelKey: 'analysis.output.wallTiles' },
  { id: 'opponent-dora-count', labelKey: 'analysis.output.dora' },
  { id: 'opponent-score', labelKey: 'analysis.output.score' },
  { id: 'kyoku-outcome', labelKey: 'analysis.output.kyokuOutcome' },
  { id: 'kyoku-score-delta', labelKey: 'analysis.output.kyokuDelta' },
  { id: 'match-placement', labelKey: 'analysis.output.matchPlacement' },
  { id: 'match-score', labelKey: 'analysis.output.matchScore' },
]

export const OPPONENT_ENGINE_OUTPUT_IDS = SUPPORTED_ENGINE_OUTPUT_DEFINITIONS
  .map(({ id }) => id)
  .filter((id): id is Exclude<SupportedEngineOutputId, 'action-recommendation'> => (
    id !== 'action-recommendation'
  ))

export interface EngineOptionEntry {
  key: string
  label: string
  type: string
  enumValues: Array<string | number | boolean> | null
  minimum?: number
  maximum?: number
  defaultValue: unknown
}

interface EngineCatalogOptions {
  bridge: () => DesktopBridge | undefined
  settings: StudioSettings
  locale: Readonly<Ref<string>>
  t: (key: string) => string
}

export function useEngineCatalog(options: EngineCatalogOptions) {
  const descriptions = reactive<Record<string, EngineDescription>>({})
  const describeErrors = reactive<Record<string, string>>({})
  const describingKeys = reactive(new Set<string>())

  const supportedOutputs = computed(() => SUPPORTED_ENGINE_OUTPUT_DEFINITIONS.map(({ id, labelKey }) => ({
    id,
    label: options.t(labelKey),
  })))
  const diagnostics = computed(() => options.settings.runtime?.engineCatalog?.diagnostics || [])

  function descriptionKey(profile: EngineProfile | null): string {
    return String(profile?.enginePath || profile?.engineId || '')
  }

  function descriptionForProfile(profile: EngineProfile | null): EngineDescription | null {
    return descriptions[descriptionKey(profile)] || null
  }

  function catalogEngineForProfile(profile: EngineProfile | null) {
    return options.settings.runtime?.engineCatalog?.engines.find((engine) => (
      engine.id === profile?.engineId
      || engine.enginePath.toLowerCase() === String(profile?.enginePath || '').toLowerCase()
    )) || null
  }

  function supportedOutputsForProfile(profile: EngineProfile) {
    const contracts = descriptionForProfile(profile)?.outputContracts || []
    return supportedOutputs.value.filter((supported) => contracts.some(({ id }) => id === supported.id))
  }

  function weightSlotsForProfile(profile: EngineProfile) {
    const description = descriptionForProfile(profile)
    const supportedIds = new Set(supportedOutputsForProfile(profile).map(({ id }) => id))
    return (description?.weightSlots || []).filter((slot) => (
      slot.requiredForOutputs?.some(({ id }) => supportedIds.has(id as SupportedEngineOutputId)) === true
    ))
  }

  function optionEntriesForProfile(profile: EngineProfile | null): EngineOptionEntry[] {
    const properties = descriptionForProfile(profile)?.optionsSchema?.properties || {}
    return Object.entries(properties)
      .filter(([key]) => key !== 'device')
      .map(([key, schema]) => ({
        key,
        label: schema['x-ui']?.label || key,
        type: schema.type || 'string',
        enumValues: Array.isArray(schema.enum) ? schema.enum : null,
        minimum: schema.minimum,
        maximum: schema.maximum,
        defaultValue: schema.default,
      }))
  }

  function localizedText(
    value: string | Record<string, string> | undefined,
    fallback: string,
  ): string {
    if (typeof value === 'string') return value
    const language = options.locale.value.split('-')[0]
    return value?.[options.locale.value]
      || value?.[language]
      || value?.['en-US']
      || value?.en
      || value?.default
      || value?.['zh-CN']
      || fallback
  }

  function invalidate(profile: EngineProfile | null): void {
    const key = descriptionKey(profile)
    delete descriptions[key]
    delete describeErrors[key]
  }

  async function describe(
    profile: EngineProfile | null,
    describeOptions: { force?: boolean } = {},
  ): Promise<EngineDescription | null> {
    const key = descriptionKey(profile)
    if (!profile?.enginePath) return null
    if (describeOptions.force) invalidate(profile)
    if (descriptions[key]) return descriptions[key]
    const bridge = options.bridge()
    if (describingKeys.has(key) || !bridge?.describeEngine) return null
    describingKeys.add(key)
    delete describeErrors[key]
    try {
      const description = await bridge.describeEngine({
        engineId: profile.engineId || undefined,
        engineVersion: profile.engineVersion || undefined,
        enginePath: profile.enginePath,
        engineCommand: Array.isArray(profile.engineCommand)
          ? profile.engineCommand.map(String)
          : [],
        engineCwd: profile.engineCwd,
      })
      descriptions[key] = description
      return description
    } catch (error) {
      describeErrors[key] = error instanceof Error ? error.message : String(error)
      return null
    } finally {
      describingKeys.delete(key)
    }
  }

  return {
    catalogEngineForProfile,
    describe,
    describeErrors,
    describingKeys,
    invalidate,
    descriptionForProfile,
    descriptionKey,
    diagnostics,
    localizedText,
    optionEntriesForProfile,
    supportedOutputs,
    supportedOutputsForProfile,
    weightSlotsForProfile,
  }
}
