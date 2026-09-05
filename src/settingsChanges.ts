const groups = ['training', 'modeDefaults', 'display', 'records', 'audio'] as const

export function settingsChanges(before: TrainerSettings, after: TrainerSettings): TrainerSettingsPatch {
  const patch: Record<string, Record<string, unknown>> = {}
  for (const group of groups) {
    const old = before[group] as Record<string, unknown>
    for (const [key, value] of Object.entries(after[group])) {
      if (JSON.stringify(value) === JSON.stringify(old[key])) continue
      ;(patch[group] ||= {})[key] = JSON.parse(JSON.stringify(value))
    }
  }
  return patch as TrainerSettingsPatch
}

// A reply is a complete snapshot, but it only owns the fields this request saved.
export function mergeSettingsReply(current: TrainerSettings, saved: TrainerSettings, patch: TrainerSettingsPatch): TrainerSettings {
  const next = { ...current }
  for (const group of groups) {
    if (!patch[group]) continue
    const target: Record<string, unknown> = { ...current[group] }
    for (const key of Object.keys(patch[group])) target[key] = (saved[group] as Record<string, unknown>)[key]
    Object.assign(next, { [group]: target })
  }
  if (patch.engines) next.engines = saved.engines
  return next
}
