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

<style scoped>
.wall-window {
  top: calc(4rem * var(--floating-panel-scale));
  right: calc(1.25rem * var(--floating-panel-scale));
  left: auto;
  max-width: 95vw;
  max-height: 90vh;
  overflow: auto;
}

.wall-clipboard-message {
  margin: calc(0.5rem * var(--floating-panel-scale)) 0 0;
  color: rgba(220, 244, 240, 0.82);
  font-size: var(--ui-text-body);
}

.wall-loading-state {
  width: calc(var(--ron-tile-w) * 16.6);
  margin: 0;
  padding: calc(2.5rem * var(--floating-panel-scale)) calc(1rem * var(--floating-panel-scale));
  color: var(--text-dim);
  font-size: var(--ui-text-body);
  text-align: center;
}

.wall-metadata {
  display: grid;
  gap: calc(0.38rem * var(--floating-panel-scale));
  max-width: calc(48rem * var(--floating-panel-scale));
  margin: calc(0.65rem * var(--floating-panel-scale)) 0 calc(0.2rem * var(--floating-panel-scale));
  padding: calc(0.55rem * var(--floating-panel-scale)) calc(0.7rem * var(--floating-panel-scale));
  border: calc(1px * var(--floating-panel-scale)) solid rgba(137, 188, 184, 0.16);
  border-radius: calc(0.25rem * var(--floating-panel-scale));
  background: rgba(0, 38, 44, 0.34);
  color: rgba(190, 215, 211, 0.8);
  font-size: var(--ui-text-body);
  line-height: 1.4;
}

.wall-metadata p {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: calc(0.65rem * var(--floating-panel-scale));
  align-items: baseline;
  margin: 0;
}

.wall-metadata strong,
.wall-metadata code {
  min-width: 0;
  color: rgba(232, 247, 244, 0.9);
  font-size: inherit;
  font-weight: 600;
}

.wall-metadata code {
  font-family: ui-monospace, monospace;
  font-weight: 400;
  overflow-wrap: anywhere;
}

.wall-reconstruction {
  display: grid;
  gap: calc(0.38rem * var(--floating-panel-scale));
  min-width: calc(27rem * var(--floating-panel-scale));
  margin-top: calc(0.6rem * var(--floating-panel-scale));
  color: var(--text-dim);
  font-size: var(--ui-text-body);
}

.wall-reconstruction > p {
  margin: 0;
  line-height: 1.5;
}

.wall-reconstruction > button {
  justify-self: start;
}

.wall-reconstruction label {
  display: grid;
  gap: calc(0.25rem * var(--floating-panel-scale));
  max-width: calc(24rem * var(--floating-panel-scale));
}

.wall-reconstruction input {
  min-height: calc(2rem * var(--chrome-scale));
}

.wall-grid {
  display: flex;
  flex-direction: column;
  gap: calc(var(--ron-tile-w) * 0.1);
  align-items: flex-start;
  width: max-content;
  margin-top: calc(0.4rem * var(--floating-panel-scale));
}

.wall-row {
  display: flex;
  gap: calc(var(--ron-tile-w) * 0.2);
}

.wall-group {
  display: flex;
  gap: 0;
}

.wall-tile {
  position: relative;
  width: var(--ron-tile-w);
  height: var(--ron-tile-h);
  border-radius: calc((var(--ron-tile-w) - 4px) * 4 / 30);
}

.wall-tile-idx {
  position: absolute;
  right: calc(0.0625rem * var(--floating-panel-scale));
  bottom: calc(0.025rem * var(--floating-panel-scale));
  font-size: var(--floating-text-tile-index);
  line-height: 1;
  color: rgba(255, 255, 255, 0.5);
  pointer-events: none;
}

.wall-tile-img {
  --mahjong-tile-artwork-width: var(--ron-tile-w);
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.wall-dora .wall-tile-img {
  filter: url("#wall-dora-tint");
}

.wall-ura .wall-tile-img {
  filter: url("#wall-ura-tint");
}

.wall-dealt .wall-tile-idx,
.wall-drawn .wall-tile-idx,
.wall-kan_consumed .wall-tile-idx,
.wall-rinshan_drawn .wall-tile-idx,
.wall-dora_unrevealed .wall-tile-idx,
.wall-ura_unrevealed .wall-tile-idx,
.wall-dora .wall-tile-idx,
.wall-ura .wall-tile-idx {
  color: rgba(255, 255, 255, 0.7);
}

.wall-available .wall-tile-idx {
  color: rgba(0, 0, 0, 0.7);
}
</style>
