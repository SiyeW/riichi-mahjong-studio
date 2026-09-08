<template>
  <div class="settings-modal-backdrop">
    <section class="settings-modal">
      <div class="settings-modal-header">
        <h2>{{ t('settings.title') }}</h2>
        <div class="settings-modal-actions">
          <button class="settings-btn-secondary" @click="emit('close')">
            {{ t('common.close') }}
          </button>
          <button class="settings-btn-primary" @click="emit('save')">
            {{ t('settings.save') }}
          </button>
        </div>
      </div>
      <div class="settings-subsection">
        <h3>{{ t('settings.interface') }}</h3>
        <label>
          <span>{{ t('settings.language') }}</span>
          <select v-model="props.draft.display.language">
            <option value="system">{{ t('settings.language.system') }}</option>
            <option value="zh-CN">{{ t('settings.language.zh-CN') }}</option>
            <option value="ja-JP">{{ t('settings.language.ja-JP') }}</option>
            <option value="en-US">{{ t('settings.language.en-US') }}</option>
          </select>
        </label>
        <label>
          <span>{{ t('settings.textSize') }}</span>
          <select v-model.number="props.draft.display.uiScale">
            <option v-for="scale in uiScaleOptions" :key="scale" :value="scale">
              {{ Math.round(scale * 100) }}%
            </option>
          </select>
        </label>
        <label>
          <span>{{ t('settings.colorScheme') }}</span>
          <select v-model="props.draft.display.colorScheme">
            <option value="default">{{ t('common.default') }}</option>
            <option value="killerducky">killerducky</option>
            <option value="naga">NAGA</option>
          </select>
        </label>
        <label>
          <span>{{ t('settings.tablePosition') }}</span>
          <select v-model="props.draft.display.tablePosition">
            <option value="center">{{ t('settings.tablePosition.center') }}</option>
            <option value="left">{{ t('settings.tablePosition.left') }}</option>
            <option value="right">{{ t('settings.tablePosition.right') }}</option>
          </select>
        </label>
        <label class="settings-checkbox">
          <input v-model="props.draft.display.reduceMotion" type="checkbox" />
          <span class="settings-checkbox-control" aria-hidden="true"></span>
          <span class="settings-checkbox-label">{{ t('settings.reduceMotion') }}</span>
        </label>
        <label class="settings-checkbox">
          <input v-model="props.draft.display.showTsumogiriInPlay" type="checkbox" />
          <span class="settings-checkbox-control" aria-hidden="true"></span>
          <span class="settings-checkbox-label">{{ t('settings.showTsumogiri') }}</span>
        </label>
      </div>
      <div class="settings-subsection">
        <h3>{{ t('settings.sound') }}</h3>
        <label>
          <span>{{ t('settings.soundPack') }}</span>
          <select v-model="props.draft.audio.soundPackId">
            <option value="">{{ t('common.none') }}</option>
            <option v-for="pack in soundPacks" :key="pack.id" :value="pack.id">
              {{ pack.name }}
            </option>
          </select>
        </label>
      </div>
      <div class="settings-subsection">
        <h3>{{ t('settings.game') }}</h3>
        <label>
          <span>{{ t('settings.mistakeThreshold') }}</span>
          <input v-model.number="mistakeThreshold" type="number" min="0" max="100" step="1" />
        </label>
      </div>
      <div class="settings-subsection">
        <h3>{{ t('settings.records') }}</h3>
        <label class="settings-checkbox settings-checkbox-with-description">
          <input v-model="props.draft.records.saveRecoveryOnExit" type="checkbox" />
          <span class="settings-checkbox-control" aria-hidden="true"></span>
          <span class="settings-checkbox-copy">
            <span class="settings-checkbox-label">{{ t('settings.keepRecovery') }}</span>
            <span class="settings-checkbox-description">
              {{ t('settings.keepRecovery.description') }}
            </span>
          </span>
        </label>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from '../i18n'

type SettingsDialogDraft = Pick<TrainerSettings, 'display' | 'audio' | 'records'>
type SoundPack = NonNullable<TrainerSettings['runtime']>['soundPackCatalog']['packs'][number]

const props = defineProps<{
  draft: SettingsDialogDraft
  soundPacks: SoundPack[]
  uiScaleOptions: number[]
}>()

const mistakeThreshold = defineModel<number>('mistakeThreshold', { required: true })
const emit = defineEmits<{
  close: []
  save: []
}>()
const { t } = useI18n()
</script>
