<template>
  <div class="settings-preview" :class="{ collapsed }">
    <button class="panel-section-toggle" @click="collapsed = !collapsed">
      <h3>{{ t('evaluation.title') }}</h3>
      <span>{{ collapsed ? t('console.expand') : t('console.collapse') }}</span>
    </button>
    <template v-if="!collapsed">
      <p v-if="!effectiveRecommendationsEnabled" class="empty-copy">{{ t('evaluation.hidden') }}</p>
      <p v-else-if="!showRecommendations" class="empty-copy">—</p>
      <p v-else-if="gameView.analysis?.error" class="empty-copy">{{ gameView.analysis.error }}</p>
      <div v-else-if="mergedAnalysisEntries.length" class="analysis-table-scroll">
        <table class="analysis-table">
          <thead>
            <tr>
              <th scope="col" class="analysis-action-heading">{{ t('evaluation.action') }}</th>
              <th
                v-for="metric in decisionMetricDefinitions"
                :key="metric.id"
                scope="col"
                class="analysis-metric-heading"
                v-ui-tooltip="localizedEngineText(metric.description, '')"
              >
                {{ localizedEngineText(metric.title, metric.id) }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in mergedAnalysisEntries" :key="entry._key" class="analysis-row" :class="{ best: analysisEntryIsBest(entry) }">
              <td class="analysis-action-cell">
                <span v-if="entry._kind === 'discard'" class="analysis-tile-cell">
                  <img class="tileImg mini-tile-img" :src="tileImageSrc(entry.pai)" :alt="tileFaceLabel(entry.pai)" />
                  <span v-if="discardVariantLabel(entry)" class="analysis-discard-kind">{{ discardVariantLabel(entry) }}</span>
                </span>
                <span v-else class="analysis-label-cell">
                  <span>{{ resolveSpecialAnalysisLabel(entry) }}</span>
                  <span v-if="analysisActionDisplayTiles(entry).length" class="analysis-action-tiles">
                    <img
                      v-for="(tile, index) in analysisActionDisplayTiles(entry)"
                      :key="`special-analysis-${entry._key}-${index}`"
                      class="tileImg mini-tile-img"
                      :src="tileImageSrc(tile)"
                      :alt="tileFaceLabel(tile)"
                    />
                  </span>
                </span>
              </td>
              <td v-for="metric in decisionMetricDefinitions" :key="metric.id" class="analysis-metric-cell">
                {{ formatDecisionMetric(entry.metrics?.[metric.id], metric) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="gameView.analysis?.reactionEntries?.length" class="analysis-table-scroll">
        <table class="analysis-table">
          <thead>
            <tr>
              <th scope="col" class="analysis-action-heading">{{ t('evaluation.action') }}</th>
              <th
                v-for="metric in decisionMetricDefinitions"
                :key="metric.id"
                scope="col"
                class="analysis-metric-heading"
                v-ui-tooltip="localizedEngineText(metric.description, '')"
              >
                {{ localizedEngineText(metric.title, metric.id) }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in gameView.analysis?.reactionEntries || []" :key="entry.candidateId || entry.variant" class="analysis-row" :class="{ best: analysisEntryIsBest(entry) }">
              <td class="analysis-action-cell">
                <span class="analysis-label-cell">
                  <span>{{ resolveReactionAnalysisLabel(entry) }}</span>
                  <span v-if="analysisActionDisplayTiles(entry).length" class="analysis-action-tiles">
                    <img
                      v-for="(tile, index) in analysisActionDisplayTiles(entry)"
                      :key="`reaction-analysis-${entry.candidateId || entry.variant}-${index}`"
                      class="tileImg mini-tile-img"
                      :src="tileImageSrc(tile)"
                      :alt="tileFaceLabel(tile)"
                    />
                  </span>
                </span>
              </td>
              <td v-for="metric in decisionMetricDefinitions" :key="metric.id" class="analysis-metric-cell">
                {{ formatDecisionMetric(entry.metrics?.[metric.id], metric) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty-copy">—</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '../i18n'
import { useDecisionEntryPresentation } from '../useDecisionPresentation'

const props = defineProps<{
  gameView: TrainerGameView
  effectiveRecommendationsEnabled: boolean
  showRecommendations: boolean
  localizedEngineText: (value: string | Record<string, string> | undefined, fallback: string) => string
  normalizeTileFamily: (tile: string) => string
  reactionTypeLabel: (type: string) => string
  redFive: (tile: string) => string
  tileFaceLabel: (tile: string) => string
  tileImageSrc: (tile: string) => string
}>()

const { t } = useI18n()
const collapsed = ref(false)
const {
  analysisActionDisplayTiles,
  analysisEntryIsBest,
  decisionMetricDefinitions,
  discardVariantLabel,
  formatDecisionMetric,
  mergedAnalysisEntries,
  resolveReactionAnalysisLabel,
  resolveSpecialAnalysisLabel,
} = useDecisionEntryPresentation({
  gameView: props.gameView,
  t,
  normalizeTileFamily: props.normalizeTileFamily,
  redFive: props.redFive,
  reactionTypeLabel: props.reactionTypeLabel,
})
</script>

<style scoped>
.analysis-table-scroll {
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: calc(0.12rem * var(--chrome-scale));
}

.analysis-table {
  width: max-content;
  min-width: 100%;
  border-collapse: separate;
  border-spacing: 0 calc(0.10rem * var(--chrome-scale));
}

.analysis-table th {
  padding: 0 calc(0.24rem * var(--chrome-scale)) calc(0.12rem * var(--chrome-scale));
  border-bottom: 1px solid rgba(140, 195, 185, 0.12);
  color: var(--text-dim);
  font-size: var(--ui-text-body);
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
}

.analysis-action-heading {
  text-align: left;
}

.analysis-metric-heading {
  min-width: calc(3.6rem * var(--chrome-scale));
  text-align: right;
}

.analysis-row td {
  height: calc(var(--ui-tile-h) * 0.52 + (0.3125rem * var(--ui-scale)));
  padding: calc(0.14rem * var(--chrome-scale)) calc(0.24rem * var(--chrome-scale));
  background: rgba(255, 255, 255, 0.03);
  border-top: 1px solid rgba(140, 195, 185, 0.06);
  border-bottom: 1px solid rgba(140, 195, 185, 0.06);
}

.analysis-row td:first-child {
  border-left: 1px solid rgba(140, 195, 185, 0.06);
}

.analysis-row td:last-child {
  border-right: 1px solid rgba(140, 195, 185, 0.06);
}

.analysis-row.best td {
  border-color: rgba(104, 211, 118, 0.30);
  background: rgba(27, 94, 39, 0.14);
}

.analysis-action-cell {
  width: 100%;
  min-width: calc(4.8rem * var(--chrome-scale));
  white-space: nowrap;
}

.analysis-tile-cell,
.analysis-label-cell {
  font-size: var(--ui-text-control);
}

.analysis-tile-cell,
.analysis-label-cell,
.analysis-action-tiles {
  display: inline-flex;
  align-items: center;
  gap: calc(0.18rem * var(--chrome-scale));
}

.analysis-action-tiles {
  gap: 0;
}

.analysis-discard-kind {
  color: var(--text-dim);
  white-space: nowrap;
}

.analysis-metric-cell {
  min-width: calc(3.6rem * var(--chrome-scale));
  text-align: right;
  font-size: var(--ui-text-control);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  white-space: nowrap;
}
</style>
