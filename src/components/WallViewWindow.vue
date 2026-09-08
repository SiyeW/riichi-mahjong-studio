<template>
  <section
    class="analysis-float-panel wall-window"
    :style="{ '--floating-panel-scale': scale, zIndex }"
    @mousedown="emit('focus')"
    @focusin="emit('focus')"
  >
    <div class="floating-panel-header" @mousedown="emit('start-drag', $event)">
      <span>{{ t('wall.title') }}</span>
      <div class="floating-panel-header-actions">
        <button v-if="complete" class="floating-panel-action" :disabled="!hasTiles" @click="emit('copy')">
          {{ t('common.copy') }}
        </button>
        <button v-if="complete && !readOnly" class="floating-panel-action" @click="emit('import')">
          {{ t('common.import') }}
        </button>
        <button class="floating-panel-close" :aria-label="t('wall.close')" @click="emit('close')">&times;</button>
      </div>
    </div>
    <p v-if="clipboardMessage" class="wall-clipboard-message">{{ clipboardMessage }}</p>
    <p v-if="loading" class="wall-loading-state" role="status">{{ t('wall.loading') }}</p>
    <template v-else>
      <div v-if="origin !== 'generated' || seed !== null || sourceUrl" class="wall-metadata">
        <p v-if="origin !== 'generated'">
          <span>{{ t('wall.source') }}</span>
          <strong>{{ origin === 'reconstructed' ? t('wall.source.reconstructed') : t('wall.source.imported') }}</strong>
        </p>
        <p v-if="seed !== null"><span>{{ t('wall.seed') }}</span><code>{{ seed }}</code></p>
        <p v-if="sourceUrl"><span>{{ t('wall.importUrl') }}</span><code>{{ sourceUrl }}</code></p>
      </div>
      <div v-if="canReconstruct && !complete" class="wall-reconstruction">
        <button class="floating-panel-action" :disabled="reconstructing" @click="emit('reconstruct')">
          {{ reconstructing ? t('wall.reconstructing') : t('wall.reconstruct') }}
        </button>
        <p>{{ t('wall.reconstruct.description') }}</p>
        <label>
          <span>{{ t('wall.seedOptional') }}</span>
          <input v-model.trim="reconstructionSeed" type="text" inputmode="numeric" :placeholder="t('wall.seedPlaceholder')" />
        </label>
      </div>
    </template>
    <div v-if="!loading && complete" class="wall-grid">
      <div v-for="(row, rowIndex) in tileRows" :key="`wr-${rowIndex}`" class="wall-row">
        <div v-for="(group, groupIndex) in row" :key="`wg-${groupIndex}`" class="wall-group">
          <div v-for="tile in group" :key="tile.index" class="wall-tile" :class="`wall-${tile.status}`">
            <img
              :src="tileImageSrc(tile.tile)"
              :class="['tileImg', 'wall-tile-img', { tsumogiri: tile.status === 'drawn' || tile.status === 'rinshan_drawn', 'river-claimed': ['dealt', 'kan_consumed', 'dora_unrevealed', 'ura_unrevealed'].includes(tile.status) }]"
              :alt="tileFaceLabel(tile.tile)"
            />
            <span class="wall-tile-idx">{{ tile.index + 1 }}</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { WallTile } from '../useWallView'
import { useI18n } from '../i18n'

defineProps<{
  canReconstruct: boolean
  clipboardMessage: string
  complete: boolean
  hasTiles: boolean
  loading: boolean
  origin: string
  readOnly: boolean
  reconstructing: boolean
  scale: number
  seed: number | null
  sourceUrl: string
  tileRows: WallTile[][][]
  zIndex: number
  tileFaceLabel: (tile: string) => string
  tileImageSrc: (tile: string) => string
}>()

const reconstructionSeed = defineModel<string>('reconstructionSeed', { required: true })
const emit = defineEmits<{
  close: []
  copy: []
  focus: []
  import: []
  reconstruct: []
  'start-drag': [event: MouseEvent]
}>()
const { t } = useI18n()
</script>
