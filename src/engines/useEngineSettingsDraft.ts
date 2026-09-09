import { onScopeDispose, ref, watch, type Ref } from 'vue'
import type { EngineSettings } from '../contracts/engines.ts'
import type { StudioSettings } from '../contracts/settings.ts'
import type { TranslationParams } from '../i18n.ts'
import { createRevisionSaveQueue } from '../revisionSaveQueue.ts'
import { mergeSettingsReply } from '../settingsChanges.ts'

type Translate = (key: string, params?: TranslationParams) => string

interface EngineSettingsDraftOptions {
  settings: StudioSettings
  settingsDraft: StudioSettings
  busy: Readonly<Ref<boolean>>
  t: Translate
  applySettings: (settings: StudioSettings) => void
  save: (engines: EngineSettings) => Promise<StudioSettings> | undefined
}

const AUTOSAVE_DELAY_MS = 250

function cloneEngineSettings(engines: EngineSettings): EngineSettings {
  return JSON.parse(JSON.stringify(engines)) as EngineSettings
}

export function useEngineSettingsDraft(options: EngineSettingsDraftOptions) {
  const message = ref('')
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null
  let suppressAutosave = false
  let autosaveEnabled = false

  const saves = createRevisionSaveQueue(
    () => cloneEngineSettings(options.settingsDraft.engines),
    saveSnapshot,
  )

  function replace(engines: EngineSettings) {
    suppressAutosave = true
    try {
      Object.assign(options.settingsDraft.engines, cloneEngineSettings(engines))
    } finally {
      suppressAutosave = false
    }
  }

  function cancelTimer() {
    if (autosaveTimer === null) return
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }

  function schedule(delay = AUTOSAVE_DELAY_MS) {
    cancelTimer()
    if (options.busy.value) return
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null
      void flush()
    }, delay)
  }

  watch(
    () => options.settingsDraft.engines,
    () => {
      if (suppressAutosave || !autosaveEnabled) return
      saves.changed()
      message.value = ''
      schedule()
    },
    { deep: true, flush: 'sync' },
  )

  async function saveSnapshot(snapshot: EngineSettings, revision: number): Promise<boolean> {
    const request = options.save(snapshot)
    if (!request) return false
    try {
      const saved = await request
      options.applySettings(mergeSettingsReply(
        options.settings,
        saved,
        { engines: snapshot },
      ))
      if (saves.revision === revision) replace(saved.engines)
      return true
    } catch (error) {
      message.value = options.t('engine.saveFailed', {
        message: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  function beginEditing() {
    cancelTimer()
    if (!saves.saving && !saves.pending) replace(options.settings.engines)
    autosaveEnabled = true
  }

  function flush(): Promise<boolean> {
    cancelTimer()
    return saves.flush()
  }

  function currentRevision(): number {
    return saves.revision
  }

  function snapshot(): EngineSettings {
    return cloneEngineSettings(options.settingsDraft.engines)
  }

  function acknowledge(revision: number) {
    saves.acknowledge(revision)
  }

  function replaceIfCurrent(revision: number, engines: EngineSettings) {
    if (saves.revision === revision) replace(engines)
  }

  function schedulePending() {
    if (saves.pending) schedule(0)
  }

  onScopeDispose(cancelTimer)

  return {
    acknowledge,
    beginEditing,
    currentRevision,
    flush,
    message,
    replace,
    replaceIfCurrent,
    schedulePending,
    snapshot,
  }
}
