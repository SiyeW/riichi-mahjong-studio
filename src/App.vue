<template>
  <div
    class="shell"
    :class="{ 'tile-artwork-pending': !tileArtworkReady }"
    :style="[{ '--zoom': tableZoom, '--ui-scale': uiScale }, colorSchemeCssVariables]"
  >
    <svg class="wall-tint-filters" aria-hidden="true">
      <defs>
        <filter id="wall-dora-tint" color-interpolation-filters="sRGB">
          <feColorMatrix
            type="matrix"
            values="
              0.3019607843 0 0 0 0
              0 0.6705882353 0 0 0
              0 0 0.8627450980 0 0
              0 0 0 1 0
            "
          />
        </filter>
        <filter id="wall-ura-tint" color-interpolation-filters="sRGB">
          <feColorMatrix
            type="matrix"
            values="
              0.8705882353 0 0 0 0
              0 0.5607843137 0 0 0
              0 0 0.3803921569 0 0
              0 0 0 1 0
            "
          />
        </filter>
      </defs>
    </svg>
    <header class="topbar">
      <div class="title-block" :class="{ 'app-title-only': !recordHeaderTitle }">
        <div>
          <p v-if="recordHeaderTitle" class="eyebrow">Riichi Mahjong Studio</p>
          <h1>
            <button
              v-if="recordPath"
              class="record-title-button record-title-text"
              type="button"
              :aria-label="t('toolbar.showInExplorer')"
              @click="showRecordInFolder"
            >{{ recordHeaderTitle }}</button>
            <span v-else class="record-title-text">Riichi Mahjong Studio</span>
          </h1>
        </div>
      </div>
      <div class="toolbar">
        <span class="toolbar-section">
          <button
            :class="{ 'is-pending': gameFileOperation === 'create' }"
            :disabled="gameFileOperation !== null"
            :aria-busy="gameFileOperation === 'create'"
            @click="createGame"
          >{{ t('toolbar.new') }}</button>
          <button
            :class="{ 'is-pending': gameFileOperation === 'open' }"
            :disabled="gameFileOperation !== null"
            :aria-busy="gameFileOperation === 'open'"
            @click="openGame"
          >{{ t('toolbar.open') }}</button>
          <button @click="openRecordImportPanel">{{ t('toolbar.import') }}</button>
          <button
            :class="{ 'is-pending': gameFileOperation === 'save' }"
            :disabled="!recordDirty || gameFileOperation !== null"
            :aria-busy="gameFileOperation === 'save'"
            @click="saveGame"
          >{{ t('toolbar.save') }}</button>
          <button
            :class="{ 'is-pending': gameFileOperation === 'save-as' }"
            :disabled="!status.gameLoaded || gameFileOperation !== null"
            :aria-busy="gameFileOperation === 'save-as'"
            @click="saveGameAs"
          >{{ t('toolbar.saveAs') }}</button>
          <button
            :class="{
              'is-pending': gameFileOperation === 'close',
              'confirm-discard': closeRecordConfirmationPending,
            }"
            :disabled="!status.gameLoaded || gameFileOperation !== null"
            :aria-busy="gameFileOperation === 'close'"
            @click="closeGame"
          >{{ closeRecordConfirmationPending ? t('toolbar.discard') : t('toolbar.close') }}</button>
        </span>
        <span class="toolbar-section">
          <span
            class="toolbar-button-hint"
            v-ui-tooltip="isReadOnlyRecord ? READ_ONLY_RECORD_HINT : undefined"
          >
            <button @click="toggleMode" :disabled="!status.gameLoaded || isReadOnlyRecord">{{ modeButtonLabel }}</button>
          </span>
          <button @click="openWallView" :disabled="!gameView.table">{{ t('toolbar.wall') }}</button>
          <span class="toolbar-panel-menu">
            <button
              :class="{ active: showAnalysisDock }"
              :aria-pressed="showAnalysisDock"
              aria-haspopup="menu"
              @click="toggleAnalysisDock"
              :disabled="!gameView.table"
            >{{ t('toolbar.analysis') }}</button>
            <span class="toolbar-panel-menu-items" role="menu" :aria-label="t('toolbar.analysis')">
              <button
                v-for="definition in ANALYSIS_PANEL_DEFINITIONS"
                :key="definition.id"
                role="menuitemcheckbox"
                :aria-checked="analysisPanelIsSelected(definition.id)"
                :class="{ active: analysisPanelIsSelected(definition.id) }"
                :disabled="!gameView.table"
                @click.stop="toggleAnalysisPanel(definition.key)"
              >{{ t(definition.labelKey) }}</button>
            </span>
          </span>
          <button
            :class="{ active: showConsoleDock }"
            :aria-pressed="showConsoleDock"
            @click="toggleConsoleDock"
          >
            {{ t('toolbar.console') }}
          </button>
        </span>
        <span class="toolbar-section">
          <button @click="openEngineWindow">{{ t('toolbar.engine') }}</button>
          <button @click="openSettingsPanel">{{ t('toolbar.settings') }}</button>
          <button @click="showAboutPanel = true">{{ t('toolbar.about') }}</button>
        </span>
      </div>
    </header>

    <div v-if="bootstrapError" class="startup-banner">
      <span>{{ bootstrapError }}</span>
      <span v-if="backendRecoveryNeeded">{{ t(backendHasCheckpoint ? 'recovery.available' : 'recovery.unavailable') }}</span>
      <button :disabled="backendRetrying" @click="retryBackend">
        {{ t(backendRetrying ? 'recovery.working' : backendRecoveryNeeded ? (backendHasCheckpoint ? 'recovery.restore' : 'recovery.restart') : 'common.retry') }}
      </button>
    </div>

    <main
      ref="workspaceRoot"
      class="workspace"
      :class="{
        'is-dock-dragging': draggingDockPanel,
        'is-dock-resizing': dockResizeDrag,
        'is-horizontal-resize': dockResizeDrag?.direction === 'horizontal',
        'is-vertical-resize': dockResizeDrag?.direction === 'vertical',
      }"
    >
      <DockLayoutNode :node="visibleWorkspaceLayout" @resize-start="startDockResize">
        <template #default="{ id: workspaceItemId }">
      <section v-if="workspaceItemId === 'table'" class="panel table-panel">
        <div
          ref="tableStageEl"
          class="table-stage"
          :class="[
            { 'tile-artwork-pending': !tileArtworkReady },
            `table-position-${tablePosition}`,
          ]"
          :aria-busy="!tileArtworkReady"
          @wheel.prevent="onTableWheel"
          @contextmenu.prevent="onTableContextMenu"
        >
          <div
            v-if="!tileArtworkReady"
            class="table-artwork-loading"
            role="status"
            aria-live="polite"
          >{{ tileArtworkLoadingLabel }}</div>
          <div v-perceptual-surface="activePerceptualSurfaceBinding" class="grid-main">
            <!-- 用户手牌（屏幕下方，south 方位） -->
            <div class="grid-hand-p0-container" :style="southLaneStyle">
              <div class="south-command-stack">
                <div class="special-action-stage" v-if="specialActions.length">
                  <div class="special-action-board">
                    <button
                      v-for="action in specialActions"
                      :key="action.id"
                      class="special-action-option"
                      :class="{ best: showTrainingRecommendations && isBestAction(action), 'special-next-main': specialNextMoveClass(action) === 'special-next-main', 'special-next-side': specialNextMoveClass(action) === 'special-next-side', active: action.type === 'reach' && gameView.table?.pendingRiichiSeat === status.controlledSeat }"
                      :aria-disabled="isReadOnlyRecord || status.mode !== 'play'"
                      @click="submitAction(action)"
                    >
                      <span class="special-action-bar-track" :class="{ 'recommendation-hidden': !showTrainingRecommendations }">
                        <span
                          class="special-action-bar-upper"
                          :style="barUpperStyle(resolveDisplayedActionBar(action))"
                        />
                        <span
                          class="special-action-bar-fill"
                          :style="barFillStyle(resolveDisplayedActionBar(action))"
                        />
                      </span>
                      <span class="special-action-label">{{ specialActionLabel(action) }}</span>
                      <span v-if="action.pai || action.consumed?.length" class="special-action-tiles">
                        <img
                          v-for="(tile, ti) in actionDisplayTiles(action)"
                          :key="`${action.id}-${ti}`"
                          class="tileImg micro-tile-img"
                          :src="tileImageSrc(tile)"
                          :alt="tileFaceLabel(tile)"
                        />
                      </span>
                    </button>
                  </div>
                </div>
              </div>
              <span class="grid-hand pov-p0 grid-hand-p0" v-if="southView">
                <span class="bottom-player-rail">
                  <div
                    v-if="southDiscardBarSlots.length"
                    class="discard-bars"
                    :class="{
                      'recommendation-toggle': canToggleDecisionRecommendations,
                      'recommendation-hidden': !showTrainingRecommendations || !discardActions.length,
                    }"
                    :role="canToggleDecisionRecommendations ? 'button' : undefined"
                    :tabindex="canToggleDecisionRecommendations ? 0 : undefined"
                    :aria-pressed="canToggleDecisionRecommendations ? decisionRecommendationsEnabled : undefined"
                    :aria-label="canToggleDecisionRecommendations ? (decisionRecommendationsEnabled ? t('toolbar.hideRecommendations') : t('toolbar.showRecommendations')) : undefined"
                    v-ui-tooltip="canToggleDecisionRecommendations ? (decisionRecommendationsEnabled ? t('toolbar.hide') : t('toolbar.show')) : undefined"
                    @click.stop="toggleDecisionRecommendations"
                    @keydown.enter.prevent="toggleDecisionRecommendations"
                    @keydown.space.prevent="toggleDecisionRecommendations"
                  >
                    <div
                      v-for="(slot, index) in southDiscardBarSlots"
                      :key="'dbar-'+index"
                      class="discard-bar-slot"
                      :class="{ best: showTrainingRecommendations && slot.isBest, 'discard-bar-next-main': !slot.isGap && tileNextMoveClass(slot.tile, slot.isDrawn) === 'tile-next-main', 'discard-bar-next-side': !slot.isGap && tileNextMoveClass(slot.tile, slot.isDrawn) === 'tile-next-side', 'is-drawn': slot.isDrawn }"
                    >
                      <span v-if="!slot.isGap" class="choice-bar-lane">
                        <span class="choice-bar-upper" :style="barUpperStyle(resolveDisplayedDiscardSlotBar(slot))" />
                        <span class="choice-bar-fill" :style="barFillStyle(resolveDisplayedDiscardSlotBar(slot))" />
                      </span>
                    </div>
                  </div>
                  <span class="hand-row">
                    <span class="pov-p0 hand-closed-p0" @contextmenu.prevent="onSouthHandContextMenu">
                      <div
                        v-for="(tile, index) in southDisplayHandParts.closed"
                        :key="'p0h-'+index"
                        :class="['tileDiv', { 'hand-discard-gap': tile === HAND_DISCARD_GAP }]"
                        :data-hand-gap-seat="tile === HAND_DISCARD_GAP ? southView.seat : undefined"
                      >
                        <img
                          v-if="tile !== HAND_DISCARD_GAP"
                          :class="['tileImg', tileNextMoveClass(tile, false), isUserDiscard(tile, southView.seat) ? 'tileImgInteractive' : '']"
                          :src="tileImageSrc(tile)"
                          :alt="tileFaceLabel(tile)"
                          @click="discardTile(tile, false)"
                          :style="{ cursor: isUserDiscard(tile, southView.seat) ? 'pointer' : 'default' }"
                        />
                      </div>
                      <span v-if="southDisplayHandParts.drawn" class="draw-gap draw-gap-p0"></span>
                      <div
                        v-if="southDisplayHandParts.drawn"
                        :class="['tileDiv', 'is-drawn', { 'hand-discard-gap': southDisplayHandParts.drawn === HAND_DISCARD_GAP }]"
                        :data-hand-gap-seat="southDisplayHandParts.drawn === HAND_DISCARD_GAP ? southView.seat : undefined"
                      >
                        <img
                          v-if="southDisplayHandParts.drawn !== HAND_DISCARD_GAP"
                          :class="['tileImg', tileNextMoveClass(southDisplayHandParts.drawn, true), isUserDiscard(southDisplayHandParts.drawn, southView.seat) ? 'tileImgInteractive' : '']"
                          :src="tileImageSrc(southDisplayHandParts.drawn)"
                          :alt="tileFaceLabel(southDisplayHandParts.drawn)"
                          @click="discardTile(southDisplayHandParts.drawn, true)"
                          :style="{ cursor: isUserDiscard(southDisplayHandParts.drawn, southView.seat) ? 'pointer' : 'default' }"
                        />
                      </div>
                    </span>
                    <span class="pov-p0 hand-calls-p0" v-if="southView.melds.length">
                      <template v-for="(meld, mi) in southView.melds.slice().reverse()" :key="'p0m-'+mi">
                        <span class="meld-group">
                          <div v-for="(item, ti) in meldDisplayTiles(meld, southView.seat)" :key="'p0mt-'+ti" class="tileDiv">
                            <img
                              :class="['tileImg', item.tileClass, { 'history-jump-target': canJumpToHistoricalNode(meldNodeId(southView.seat, southView.melds.length - 1 - mi)) }]"
                              :src="item.isBack ? tileImageSrc('?') : tileImageSrc(item.tile)"
                              :alt="tileFaceLabel(item.tile)"
                              v-ui-tooltip="historicalJumpTitle(meldNodeId(southView.seat, southView.melds.length - 1 - mi), item.isKakan ? t('history.ponTile') : t('history.meld'))"
                              @dblclick.stop="jumpToHistoricalNode(meldNodeId(southView.seat, southView.melds.length - 1 - mi))"
                            />
                            <img
                              v-if="item.isKakan"
                              :class="['tileImg', item.tileClass, 'kakan-stack', { 'history-jump-target': canJumpToHistoricalNode(meldNodeId(southView.seat, southView.melds.length - 1 - mi, 'kakan')) }]"
                              :src="item.isBack ? tileImageSrc('?') : tileImageSrc(item.tile)"
                              :alt="tileFaceLabel(item.tile)"
                              v-ui-tooltip="historicalJumpTitle(meldNodeId(southView.seat, southView.melds.length - 1 - mi, 'kakan'), t('history.kakanTile'))"
                              @dblclick.stop="jumpToHistoricalNode(meldNodeId(southView.seat, southView.melds.length - 1 - mi, 'kakan'))"
                            />
                          </div>
                        </span>
                      </template>
                    </span>
                  </span>
                  <!-- 自家手牌对应的三家放铳率，从手牌下沿向下显示。 -->
                  <div
                    class="discard-bars ron-risk-bars"
                    :class="{
                      'recommendation-toggle': canToggleDecisionRecommendations,
                      'reset-without-motion': suppressOpponentAnalysisTransitions,
                    }"
                    :role="canToggleDecisionRecommendations ? 'button' : undefined"
                    :tabindex="canToggleDecisionRecommendations ? 0 : undefined"
                    :aria-pressed="canToggleDecisionRecommendations ? decisionRecommendationsEnabled : undefined"
                    :aria-label="canToggleDecisionRecommendations ? (decisionRecommendationsEnabled ? t('toolbar.hideRecommendations') : t('toolbar.showRecommendations')) : undefined"
                    v-ui-tooltip="canToggleDecisionRecommendations ? (decisionRecommendationsEnabled ? t('toolbar.hide') : t('toolbar.show')) : undefined"
                    @click.stop="toggleDecisionRecommendations"
                    @keydown.enter.prevent="toggleDecisionRecommendations"
                    @keydown.space.prevent="toggleDecisionRecommendations"
                  >
                    <div
                      v-for="slot in southRonRiskSlots"
                      :key="`ron-risk-${slot.index}`"
                      class="discard-bar-slot ron-risk-slot"
                      :class="{
                        'is-drawn': slot.isDrawn,
                        'has-adaptive-threshold': showTrainingRecommendations && showSouthRonRiskThreshold && !slot.isGap,
                        'connect-left': slot.connectLeft,
                        'connect-right': slot.connectRight,
                      }"
                      :style="showTrainingRecommendations && showSouthRonRiskThreshold && !slot.isGap
                        ? { '--ron-risk-threshold-top': southRonRiskBarHeight(RON_BAR_ADAPTIVE_MIN) }
                        : undefined"
                    >
                      <span
                        v-if="showTrainingRecommendations && !slot.isGap"
                        class="ron-risk-lanes"
                        aria-hidden="true"
                      >
                        <span v-for="risk in slot.risks" :key="risk.key" class="ron-risk-track">
                          <span
                            :class="['ron-risk-fill', `ron-bar-${risk.key}`]"
                            :style="{ transform: `scaleY(${southRonRiskBarScale(risk.probability)})` }"
                          />
                        </span>
                      </span>
                    </div>
                  </div>
                </span>
              </span>
              <div class="south-bottom-buffer"></div>
            </div>

            <TableOpponentHands
              :seats="opponentHandPresentations"
              :visible-hands="status.visibleHands"
              :visible-hands-toggle-label="visibleHandsToggleLabel"
              :hand-discard-gap="HAND_DISCARD_GAP"
              :toggle-visible-hands="toggleVisibleHands"
              :meld-display-tiles="meldDisplayTiles"
              :meld-node-id="meldNodeId"
              :can-jump-to-historical-node="canJumpToHistoricalNode"
              :historical-jump-title="historicalJumpTitle"
              :jump-to-historical-node="jumpToHistoricalNode"
              :tile-face-label="tileFaceLabel"
              :tile-image-src="tileImageSrc"
            />

            <!-- Rivers -->
            <TableRivers
              :views="tableSeatViews"
              :show-tsumogiri-tone="showTsumogiriTone"
              :river-display-rows="riverDisplayRows"
              :can-jump-to-historical-node="canJumpToHistoricalNode"
              :historical-jump-title="historicalJumpTitle"
              :jump-to-historical-node="jumpToHistoricalNode"
              :tile-face-label="tileFaceLabel"
              :tile-image-src="tileImageSrc"
            />

            <TableCenterInfo
              v-if="gameView.table"
              :table="gameView.table"
              :views="tableSeatViews"
              :round-label="roundLabel"
              :dora-slots="centerDoraSlots"
              :is-current-actor-seat="isCurrentActorSeat"
              :seat-wind-label="seatWindLabel"
              :tile-face-label="tileFaceLabel"
              :tile-image-src="tileImageSrc"
              @toggle-round-map="toggleRoundMapOverlay"
            />
            <TableActionAnnouncement
              :game-view="gameView"
              :views="tableSeatViews"
              :find-node="findTreeNodeById"
            />
            <RoundResultOverlay
              :game-view="gameView"
              :status="status"
              :is-read-only-record="isReadOnlyRecord"
              :relative-seat-label="relativeSeatLabel"
              :tile-face-label="tileFaceLabel"
              :tile-image-src="tileImageSrc"
              @advance="advanceGame"
              @show-round-map="showRoundMapInResearchMode"
            />
        </div>
        </div>
      </section>

      <AnalysisDockModule
        v-else-if="isAnalysisPanelId(workspaceItemId)"
        :section="analysisPanelSection(workspaceItemId)"
        :title="analysisPanelTitle(workspaceItemId)"
        :dragging="draggingDockPanel === workspaceItemId"
        :suppress-transitions="suppressOpponentAnalysisTransitions"
        :ui-scale="uiScale"
        :perceptual-surface="activePerceptualSurfaceBinding"
        :loading="opponentAnalysisIsLoading"
        :load-error="opponentAnalysisLoadError"
        :analysis="gameView.opponentAnalysis"
        :shanten-opponents="shantenOpponents"
        :shanten-colors="shantenColors"
        :shanten-labels="SHANTEN_LABELS"
        :shanten-short-labels="SHANTEN_SHORT_LABELS"
        :reduce-motion="reduceMotionEnabled || suppressOpponentAnalysisTransitions"
        :controlled-seat="status.controlledSeat"
        :dealer="gameView.table?.dealer ?? 0"
        :tile-image-src="tileImageSrc"
        :tile-face-label="tileFaceLabel"
        :has-opponent-ground-truth="hasOpponentGroundTruth"
        :shanten-view-mode="shantenViewMode"
        :count-layout="analysisCountLayout"
        @drag-start="startDockPanelPointerDrag(workspaceItemId, $event)"
        @toggle-mode="shantenViewMode = shantenViewMode === 'predictions' ? 'ground_truth' : 'predictions'"
        @update:count-layout="analysisCountLayout = $event"
        @close="closeAnalysisPanel(workspaceItemId)"
      />

      <ConsoleDock
        v-else-if="workspaceItemId === 'console'"
        :dragging="draggingDockPanel === 'console'"
        @drag-start="startDockPanelPointerDrag('console', $event)"
        @close="closeConsoleDock"
      >
        <AutomaticAnalysisPanel
          v-if="status.mode === 'research'"
          :status="status"
          :apply-status="applyStatus"
        />
        <QuickSettingsPanel
          :mode="status.mode"
          :game-loaded="status.gameLoaded"
          :controlled-seat="status.controlledSeat"
          :seat-switch-in-flight="seatSwitchInFlight"
          :pending-seat-switch-label="pendingSeatSwitchLabel"
          :current-training-mode="currentTrainingMode"
          :audio-volume-label="quickAudioVolumeLabel"
          :audio-volume-percent="quickAudioVolumePercent"
          :audio-volume-value="quickAudioVolumeValue"
          :thinking-max-value="quickThinkingMaxValue"
          :max-thinking-percent="quickMaxThinkingPercent"
          :min-thinking-percent="quickMinThinkingPercent"
          :auto-advance-percent="quickAutoAdvancePercent"
          :max-thinking-label="quickMaxThinkingLabel"
          :min-thinking-label="quickMinThinkingLabel"
          :auto-advance-label="quickAutoAdvanceLabel"
          @audio-input="onQuickAudioVolumeInput"
          @audio-change="commitQuickAudioVolume"
          @seat-switch="switchSeat"
          @training-mode-change="setQuickTrainingMode"
          @thinking-input="onQuickThinkingTimeInput"
          @thinking-change="commitQuickThinkingTime"
        />

        <BranchTreePanel
          :can-set-main="canSetCurrentNodeAsMainBranch"
          :can-delete="canDeleteCurrentNode"
          :delete-confirmation-pending="deleteNodeConfirmationPending"
          :node-mutation-in-flight="nodeMutationRequestInFlight"
          :current-node-id="gameView.currentNodeId"
          :node-comment="nodeCommentDraft"
          :hovered-node-id="treeHoveredNodeId"
          :tree-dots="treeDots"
          :tree-canvas-style="treeCanvasStyle"
          :tree-base-x="treeBaseX"
          :tree-row-action-labels="treeRowActionLabels"
          :tree-square-corner-radius="treeSquareCornerRadius"
          :tree-svg-h="treeSvgH"
          :tree-svg-w="treeSvgW"
          :visible-tree-dots="visibleTreeDots"
          :visible-tree-edges="visibleTreeEdges"
          :visible-tree-hit-regions="visibleTreeHitRegions"
          :visible-tree-rows="visibleTreeRows"
          :is-current-tree-dot="isCurrentTreeDot"
          :tree-dot-radius="treeDotRadius"
          :tree-dot-stroke-width="treeDotStrokeWidth"
          :tree-edge-stroke="treeEdgeStroke"
          :tree-edge-width="treeEdgeWidth"
          :tree-square-radius="treeSquareRadius"
          :register-tree-scroll-element="registerTreeScrollElement"
          @set-main="setCurrentNodeAsMainBranch"
          @delete-node="deleteCurrentNode"
          @export="openCustomTenhouExport"
          @jump-to-node="jumpToNode"
          @tree-scroll="onTreeScroll"
          @suspend-auto-follow="suspendTreeAutoFollow"
          @resume-auto-follow="resumeTreeAutoFollow"
          @expanded="updateTreeViewport"
          @update:node-comment="nodeCommentDraft = $event"
          @update:hovered-node-id="treeHoveredNodeId = $event"
          @comment-input="onNodeCommentInput"
          @comment-blur="flushNodeCommentInBackground"
        />


        <DecisionEvaluationPanel
          :game-view="gameView"
          :effective-recommendations-enabled="effectiveDecisionRecommendationsEnabled"
          :show-recommendations="showTrainingRecommendations"
          :localized-engine-text="localizedEngineText"
          :normalize-tile-family="normalizeTileFamily"
          :reaction-type-label="reactionTypeLabel"
          :red-five="redFive"
          :tile-face-label="tileFaceLabel"
          :tile-image-src="tileImageSrc"
        />
      </ConsoleDock>
        </template>
      </DockLayoutNode>

      <div
        v-if="draggingDockPanel"
        class="dock-drop-overlay"
        aria-live="polite"
      >
        <div
          v-if="activeDockDropTarget"
          class="dock-drop-indicator"
          :class="`is-${activeDockDropTarget.edge}`"
          :style="dockDropIndicatorStyle"
        >
          <span class="visually-hidden">{{ dockDropLabel }}</span>
        </div>
      </div>
    </main>

    <footer class="footer">
      <div class="footer-model-status">
        <span class="footer-model-dots">
          <span
            v-for="item in engineStatusItems"
            :key="item.id"
            class="footer-model-indicator"
          >
            <span
              class="footer-model-dot"
              :class="{ active: item.state === 'running', loading: item.state === 'loading', error: item.state === 'error' }"
              :aria-label="item.label"
              role="img"
              tabindex="0"
            />
            <span class="ui-hover-tooltip footer-model-tooltip" role="tooltip">{{ item.label }}</span>
          </span>
        </span>
      </div>
      <div
        class="footer-memory-status"
        :aria-label="runtimeMemoryDetail"
        aria-describedby="runtime-memory-detail"
        tabindex="0"
      >
        <span>{{ t('status.applicationMemory', { value: formatMemorySize(runtimeMetrics?.applicationBytes) }) }}</span>
        <span class="footer-memory-separator" aria-hidden="true">·</span>
        <span>{{ t('status.systemAvailable', { value: formatMemorySize(runtimeMetrics?.systemAvailableBytes) }) }}</span>
        <div id="runtime-memory-detail" class="ui-hover-tooltip footer-memory-tooltip" role="tooltip">
          <div v-for="row in runtimeMemoryRows" :key="row.label" class="ui-hover-tooltip-row">
            <span>{{ row.label }}</span>
            <span>{{ row.value }}</span>
          </div>
        </div>
      </div>
    </footer>

    <RecordImportDialog
      v-if="showRecordImportPanel"
      :before-import="flushNodeComment"
      @close="closeRecordImportPanel"
      @imported="handleRecordImported"
      @open-external="openExternalLink"
    />

    <SettingsDialog
      v-if="showSettingsPanel"
      v-model:mistake-threshold="mistakeThresholdDisplay"
      :draft="settingsDraft"
      :sound-packs="settings.runtime?.soundPackCatalog.packs || []"
      :ui-scale-options="uiScaleOptions"
      @close="closeSettingsPanel"
      @save="saveSettingsPanel"
    />

    <RoundMapWindow
      v-if="roundMapOverlayOpen"
      v-model:hovered-round-id="roundMapHoveredRoundId"
      :base-x="ROUND_BASE_X"
      :dots="roundMapDots"
      :edges="roundMapEdges"
      :format-delta="formatDelta"
      :hit-regions="roundMapHitRegions"
      :rows="roundMapRows"
      :scale="uiScale"
      :settlement-layout="roundMapSettlementLayout"
      :settlement-round-label="roundMapSettlementRoundLabel"
      :settlement-title="roundMapSettlementTitle"
      :svg-height="roundMapSvgH"
      :svg-width="roundMapSvgW"
      :z-index="floatingPanelZ.roundMap"
      @close="closeRoundMapOverlay"
      @focus="focusFloatingPanel('roundMap')"
      @jump="jumpToRoundRoot"
      @start-drag="startDragFloatingPanel"
    />

    <WallViewWindow
      v-if="showWallView"
      v-model:reconstruction-seed="wallReconstructionSeed"
      :can-reconstruct="wallCanReconstruct"
      :clipboard-message="wallClipboardMessage"
      :complete="wallViewComplete"
      :has-tiles="Boolean(wallTiles.length)"
      :loading="wallLoading"
      :origin="wallOrigin"
      :read-only="isReadOnlyRecord"
      :reconstructing="wallReconstructing"
      :scale="uiScale"
      :seed="wallSeed"
      :source-url="wallSourceUrl"
      :tile-face-label="tileFaceLabel"
      :tile-image-src="tileImageSrc"
      :tile-rows="wallTileRows"
      :z-index="floatingPanelZ.wall"
      @close="closeWallView()"
      @copy="copyWallToClipboard"
      @focus="focusFloatingPanel('wall')"
      @import="importWallFromClipboard"
      @reconstruct="reconstructImportedWalls"
      @start-drag="startDragFloatingPanel"
    />

    <CustomTenhouExportPanel
      v-if="showCustomTenhouExport"
      :scale="uiScale"
      :z-index="floatingPanelZ.customExport"
      :refresh-key="customTenhouExportRefreshKey"
      @close="showCustomTenhouExport = false"
      @focus="focusFloatingPanel('customExport')"
      @start-drag="startDragFloatingPanel"
    />

    <EngineManagerWindow
      v-if="showEngineWindow"
      :scale="uiScale"
      :z-index="floatingPanelZ.engine"
      :footer-message="engineFooterMessage"
      :busy="Boolean(loadingEngineProfileId || unloadingEngineProfileId)"
      :can-delete="engineListCanDelete"
      :can-duplicate="engineListCanDuplicate"
      :can-move-down="engineListCanMoveDown"
      :can-move-up="engineListCanMoveUp"
      :delete-confirmation="engineListDeleteConfirmation"
      :outputs="engineOutputFilterItems"
      :profiles="engineProfileListItems"
      :detail="activeEngineProfileDetail"
      @close="closeEngineWindow"
      @focus="focusFloatingPanel('engine')"
      @start-drag="startDragFloatingPanel"
      @action="handleEngineProfileAction"
      @add="addEngineProfile"
      @delete="deleteEngineProfile"
      @duplicate="duplicateEngineProfile"
      @move="moveEngineProfile"
      @select="selectEngineProfile"
      @toggle-output="toggleEngineOutputFilter"
      @choose-engine="chooseEngineFile"
      @choose-weight="chooseEngineWeight"
      @device="setEngineDeviceValue"
      @legal="openEngineLegalDocument"
      @name="setEngineProfileNameValue"
      @option="setEngineOptionValue"
      @output="setEngineOutputAssignmentValue"
      @source="openExternalLink"
    />

    <MjaiDebugDialog
      v-if="showMjaiDebug"
      :cache-clear-message="analysisCacheClearMessage"
      :clearing-analysis-caches="clearingAnalysisCaches"
      :debug-data="mjaiDebugData"
      :debug-json="mjaiDebugJson"
      :game-loaded="status.gameLoaded"
      :has-shanten-raw-data="Boolean(shantenRawData.kamicha)"
      :shanten-json="shantenMjaiJson"
      :shanten-raw-json="shantenRawJson"
      :shanten-status="shantenStatus"
      @clear-cache="clearLoadedAnalysisCaches"
      @close="showMjaiDebug = false"
    />

    <AboutDialog v-if="showAboutPanel" @close="showAboutPanel = false" />
    <PerceptualColorDebugger
      v-if="showPerceptualColorDebugger"
      :tuning="perceptualSurfaceTuning"
      :bypassed="perceptualSurfaceBypassed"
      @update:tuning="updatePerceptualSurfaceTuning"
      @update:bypassed="perceptualSurfaceBypassed = $event"
      @reset="resetPerceptualSurfaceTuning"
      @close="showPerceptualColorDebugger = false"
    />
  </div>

</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, proxyRefs, reactive, ref, watch, watchEffect } from 'vue'
import { installAnalysisTestHarness } from './testing/analysisHarness'
import type { StudioSettings } from './contracts/settings'
import type { GameTreeNode, GameView } from './contracts/game'
import type { StudioStatus } from './contracts/runtime'
import { flushBeforeClose } from './flushBeforeClose'
import { mergeSettingsReply } from './settingsChanges'
import { createPythonEventRouter } from './pythonEventRouter'
import { useWorkspaceDock } from './useWorkspaceDock'
import { useWallView } from './useWallView'
import { useEngineProfiles } from './useEngineProfiles'
import { useGameplayActions } from './useGameplayActions'
import { useAutoAdvance } from './useAutoAdvance'
import { useBranchNavigation } from './useBranchNavigation'
import { useBranchTreePresentation } from './useBranchTreePresentation'
import { useDiscardFlight, type GameViewTransitionDirection } from './useDiscardFlight'
import {
  formatDelta,
  useDecisionActionPresentation,
  useDecisionEntryPresentation,
} from './useDecisionPresentation'
import { useDesktopBridgeSubscriptions } from './useDesktopBridgeSubscriptions'
import { useRecordSession } from './useRecordSession'
import { localizedResultTitle } from './useRoundResultPresentation'
import { useRuntimeMetrics } from './useRuntimeMetrics'
import { useMahjongPresentationLabels } from './useMahjongPresentationLabels'
import { useSettingsSession } from './useSettingsSession'
import { useSoundTransitions, type SoundTransitionView } from './useSoundTransitions'
import { usePlayPrefetch } from './usePlayPrefetch'
import { useTablePresentation } from './useTablePresentation'
import { useTableViewport } from './useTableViewport'
import { useTileArtwork } from './useTileArtwork'
import {
  SHANTEN_SHORT_LABELS,
  shantenResultHasRows,
  useAnalysisSession,
} from './useAnalysisSession'
import {
  normalizeWorkspaceLayout,
} from './workspaceSettings'
import {
  DEFAULT_PROBABILITY_SCALE,
  probabilityScalePercent,
  probabilityScaleRatio,
} from './analysisProbabilityScale'
import AnalysisDockModule from './components/AnalysisDockModule.vue'
import AboutDialog from './components/AboutDialog.vue'
import AutomaticAnalysisPanel from './components/AutomaticAnalysisPanel.vue'
import BranchTreePanel from './components/BranchTreePanel.vue'
import ConsoleDock from './components/ConsoleDock.vue'
import CustomTenhouExportPanel from './components/CustomTenhouExportPanel.vue'
import DecisionEvaluationPanel from './components/DecisionEvaluationPanel.vue'
import DockLayoutNode from './components/DockLayoutNode.vue'
import EngineManagerWindow from './components/EngineManagerWindow.vue'
import MjaiDebugDialog from './components/MjaiDebugDialog.vue'
import QuickSettingsPanel from './components/QuickSettingsPanel.vue'
import RecordImportDialog from './components/RecordImportDialog.vue'
import RoundMapWindow from './components/RoundMapWindow.vue'
import RoundResultOverlay from './components/RoundResultOverlay.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import TableActionAnnouncement from './components/TableActionAnnouncement.vue'
import TableCenterInfo from './components/TableCenterInfo.vue'
import TableOpponentHands, { type OpponentHandPresentation } from './components/TableOpponentHands.vue'
import TableRivers from './components/TableRivers.vue'
import WallViewWindow from './components/WallViewWindow.vue'
import { useI18n } from './i18n'
import { vPerceptualSurface } from './perceptualSurface'
import {
  type AnalysisPanelId,
  type WorkspaceItemId,
} from './workspaceLayout'

const PerceptualColorDebugger = defineAsyncComponent(
  () => import('./components/PerceptualColorDebugger.vue'),
)

const { locale, numberLocale, t } = useI18n()

const seats = [0, 1, 2, 3]
const CONFIRMATION_TIMEOUT_MS = 3000
type AnalysisPanelKey = keyof StudioSettings['display']['workspaceLayout']['analysisPanels']

const {
  settings,
  settingsDraft,
  reduceMotionEnabled,
  activePerceptualSurfaceBinding,
  colorSchemeCssVariables,
  perceptualSurfaceTuning,
  perceptualSurfaceBypassed,
  analysisCountLayout,
  showPerceptualColorDebugger,
  updatePerceptualSurfaceTuning,
  resetPerceptualSurfaceTuning,
  shantenColors,
  uiScale,
  tablePosition,
  mistakeThresholdDisplay,
  uiScaleOptions,
  showSettingsPanel,
  currentTrainingMode,
  quickThinkingMaxValue,
  quickAudioVolumeValue,
  quickMaxThinkingPercent,
  quickAudioVolumePercent,
  quickMinThinkingPercent,
  quickAutoAdvancePercent,
  quickMaxThinkingLabel,
  quickAudioVolumeLabel,
  quickMinThinkingLabel,
  quickAutoAdvanceLabel,
  normalizeTrainingMode,
  applySettings,
  cloneSettingsDraftFromCurrent,
  openSettingsPanel,
  closeSettingsPanel,
  saveSettingsPanel,
  setQuickTrainingMode,
  onQuickAudioVolumeInput,
  commitQuickAudioVolume,
  onQuickThinkingTimeInput,
  commitQuickThinkingTime,
  changeUiScale,
} = useSettingsSession(t)

const ANALYSIS_PANEL_DEFINITIONS: Array<{
  id: AnalysisPanelId
  key: AnalysisPanelKey
  section: 'opponents' | 'game' | 'risk' | 'counts'
  labelKey: string
}> = [
  { id: 'analysis-opponents', key: 'opponents', section: 'opponents', labelKey: 'analysis.opponents' },
  { id: 'analysis-game', key: 'game', section: 'game', labelKey: 'analysis.players' },
  { id: 'analysis-risk', key: 'risk', section: 'risk', labelKey: 'analysis.riskPrediction' },
  { id: 'analysis-counts', key: 'counts', section: 'counts', labelKey: 'analysis.countPrediction' },
]

const showAboutPanel = ref(false)
const showCustomTenhouExport = ref(false)
const customTenhouExportRefreshKey = ref(0)
const showMjaiDebug = ref(false)
const mjaiDebugData = ref<Record<string, unknown>>({})
const mjaiDebugJson = computed(() => JSON.stringify(mjaiDebugData.value, null, 2))
const shantenMjaiData = ref<Record<string, unknown>>({})
const shantenMjaiJson = computed(() => JSON.stringify(shantenMjaiData.value, null, 2))

// --- 工作区与分析 ---
const workspaceLayout = computed(() => normalizeWorkspaceLayout(settings.display.workspaceLayout))
let workspaceLayoutSaveGeneration = 0

function applyWorkspaceLayoutLocally(nextLayout: StudioSettings['display']['workspaceLayout']) {
  const normalized = normalizeWorkspaceLayout(nextLayout)
  settings.display.workspaceLayout = normalized
  if (showSettingsPanel.value) settingsDraft.display.workspaceLayout = JSON.parse(JSON.stringify(normalized))
  void nextTick(() => scheduleTableZoomRecalc())
  return normalized
}

function updateWorkspaceLayout(nextLayout: StudioSettings['display']['workspaceLayout']) {
  const normalized = applyWorkspaceLayoutLocally(nextLayout)
  const generation = ++workspaceLayoutSaveGeneration
  void window.studioAPI?.saveSettings({
    display: {
      workspaceLayout: JSON.parse(JSON.stringify(normalized)),
    },
  }).then((saved) => {
    if (generation !== workspaceLayoutSaveGeneration) return
    applySettings(mergeSettingsReply(settings, saved, { display: { workspaceLayout: normalized } }))
  }).catch((error) => {
    console.warn('Failed to save workspace layout:', error)
  })
}

function analysisPanelDefinition(id: AnalysisPanelId) {
  return ANALYSIS_PANEL_DEFINITIONS.find((definition) => definition.id === id)
}

function isAnalysisPanelId(id: WorkspaceItemId): id is AnalysisPanelId {
  return id.startsWith('analysis-')
}

function analysisPanelSection(id: AnalysisPanelId): 'opponents' | 'game' | 'risk' | 'counts' {
  return analysisPanelDefinition(id)?.section || 'opponents'
}

function analysisPanelTitle(id: AnalysisPanelId): string {
  return t(analysisPanelDefinition(id)?.labelKey || 'analysis.opponents')
}

function analysisPanelIsSelected(id: AnalysisPanelId): boolean {
  const definition = analysisPanelDefinition(id)
  return definition ? workspaceLayout.value.analysisPanels[definition.key] : false
}

const hasSelectedAnalysisPanels = computed(() => (
  ANALYSIS_PANEL_DEFINITIONS.some((definition) => workspaceLayout.value.analysisPanels[definition.key])
))
const showAnalysisDock = computed(() => (
  workspaceLayout.value.analysisVisible
  && hasSelectedAnalysisPanels.value
  && Boolean(gameView.table)
))
const showConsoleDock = computed(() => workspaceLayout.value.consoleVisible)

function showAnalysisPanel(id: AnalysisPanelId): boolean {
  return showAnalysisDock.value && analysisPanelIsSelected(id)
}

const {
  draggingDockPanel, visibleWorkspaceLayout, workspaceRoot, activeDockDropTarget,
  dockResizeDrag, startDockResize, startDockPanelPointerDrag, dockDropIndicatorStyle,
} = useWorkspaceDock({
  workspaceLayout,
  visiblePanels: computed(() => [
    ...(showConsoleDock.value ? ['console' as const] : []),
    ...ANALYSIS_PANEL_DEFINITIONS.filter(({ id }) => showAnalysisPanel(id)).map(({ id }) => id),
  ]),
  uiScale,
  applyWorkspaceLayoutLocally,
  updateWorkspaceLayout,
  invalidateLayoutSave: () => { workspaceLayoutSaveGeneration += 1 },
})

const dockDropLabel = computed(() => t({
  left: 'workspace.dockLeft',
  right: 'workspace.dockRight',
  top: 'workspace.dockTop',
  bottom: 'workspace.dockBottom',
}[activeDockDropTarget.value?.edge || 'right']))

type FloatingPanelName = 'wall' | 'engine' | 'roundMap' | 'customExport'
const floatingPanelZ = reactive<Record<FloatingPanelName, number>>({
  wall: 1000,
  engine: 1000,
  roundMap: 1000,
  customExport: 1000,
})
let floatingPanelZCounter = 1000
function focusFloatingPanel(panel: FloatingPanelName) {
  floatingPanelZ[panel] = ++floatingPanelZCounter
}
function toggleAnalysisDock() {
  const nextVisible = !showAnalysisDock.value
  const analysisPanels = hasSelectedAnalysisPanels.value
    ? workspaceLayout.value.analysisPanels
    : { opponents: true, game: true, risk: false, counts: false }
  updateWorkspaceLayout({
    ...workspaceLayout.value,
    analysisVisible: nextVisible,
    analysisPanels,
  })
}
function toggleAnalysisPanel(key: AnalysisPanelKey) {
  const nextSelected = !workspaceLayout.value.analysisPanels[key]
  const analysisPanels = {
    ...workspaceLayout.value.analysisPanels,
    [key]: nextSelected,
  }
  const anySelected = Object.values(analysisPanels).some(Boolean)
  updateWorkspaceLayout({
    ...workspaceLayout.value,
    analysisVisible: anySelected && (workspaceLayout.value.analysisVisible || nextSelected),
    analysisPanels,
  })
}
function closeAnalysisPanel(id: AnalysisPanelId) {
  const definition = analysisPanelDefinition(id)
  if (!definition) return
  const analysisPanels = {
    ...workspaceLayout.value.analysisPanels,
    [definition.key]: false,
  }
  updateWorkspaceLayout({
    ...workspaceLayout.value,
    analysisVisible: Object.values(analysisPanels).some(Boolean) && workspaceLayout.value.analysisVisible,
    analysisPanels,
  })
}
function toggleConsoleDock() {
  updateWorkspaceLayout({
    ...workspaceLayout.value,
    consoleVisible: !showConsoleDock.value,
  })
}
function closeConsoleDock() {
  updateWorkspaceLayout({
    ...workspaceLayout.value,
    consoleVisible: false,
  })
}
const RON_BAR_ADAPTIVE_MIN = DEFAULT_PROBABILITY_SCALE
function southRonRiskBarHeight(prob: number): string {
  return probabilityScalePercent(prob, southRonRiskAdaptiveMax.value)
}
function southRonRiskBarScale(prob: number): number {
  return probabilityScaleRatio(prob, southRonRiskAdaptiveMax.value)
}
// Shared drag state for floating analysis panels.
let floatingPanelDragPos: { x: number; y: number } | null = null
function startDragFloatingPanel(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('button')) return
  const el = (e.currentTarget as HTMLElement).parentElement
  if (!el) return
  const rect = el.getBoundingClientRect()
  floatingPanelDragPos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  const onMove = (ev: MouseEvent) => {
    if (!floatingPanelDragPos) return
    const maxLeft = Math.max(0, window.innerWidth - rect.width)
    const maxTop = Math.max(0, window.innerHeight - rect.height)
    const left = Math.max(0, Math.min(ev.clientX - floatingPanelDragPos.x, maxLeft))
    const top = Math.max(0, Math.min(ev.clientY - floatingPanelDragPos.y, maxTop))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.right = 'auto'
    el.style.bottom = 'auto'
  }
  const onUp = () => {
    floatingPanelDragPos = null
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
const {
  tableStageEl,
  tableZoom,
  scheduleTableZoomRecalc,
} = useTableViewport({
  uiScale,
  afterLayoutChange: () => {
    updateTreeViewport()
  },
})

const status = reactive<StudioStatus>({
  aiThinkingTimeS: 0,
  mode: 'play',
  controlledSeat: 0,
  pendingSeatSwitch: null,
  visibleHands: false,
  gameLoaded: false,
  device: '...',
  modelPerformance: {
    decision: [0, 0, 0, 0],
    opponentAnalysis: 0,
  },
  analysisVisibility: {
    decisionRecommendations: true,
    opponentAnalysis: false,
  },
  modelActivity: {
    decision: ['idle', 'idle', 'idle', 'idle'],
    opponentAnalysis: 'idle',
    errors: {
      decision: [null, null, null, null],
      opponentAnalysis: null,
    },
  },
  modelRuntime: {
    decision: { profileId: '', ready: false, unloaded: false },
    opponentAnalysis: { profileId: '', ready: false, unloaded: false },
  },
  autoAnalysis: {
    status: 'idle',
    completed: 0,
    total: 0,
    cached: 0,
    analyzed: 0,
    failed: 0,
    currentNodeId: null,
    currentModel: null,
    message: '',
    timeline: '',
    timelineReady: 0,
  },
})
const {
  runtimeMetrics,
  runtimeMemoryRows,
  runtimeMemoryDetail,
  formatMemorySize,
  startRuntimeMetrics,
} = useRuntimeMetrics(t)
const showTsumogiriTone = computed(() => (
  status.mode !== 'play' || settings.display.showTsumogiriInPlay !== false
))

const seatSwitchInFlight = ref(false)
const pendingSeatSwitchLabel = ref('')
const gameView = reactive<GameView>({
  gameId: null,
  matchId: null,
  readOnly: false,
  sourceUrl: null,
  readOnlyReason: null,
  currentNodeId: null,
  nodeComment: '',
  opponentAnalysis: null,
  matchSummary: null,
  table: null,
  legalActions: [],
  analysis: null,
  comparison: null,
  pendingReview: null,
  tree: null,
})

const {
  SHANTEN_LABELS,
  acceptsDecisionEventEpoch,
  acceptsOpponentEventEpoch,
  analysisCacheClearMessage,
  applyOpponentAnalysisEvent,
  applyShantenResult,
  cacheDecisionAnalysis,
  canToggleDecisionRecommendations,
  clearLoadedAnalysisCaches,
  clearOpponentAnalysisWithoutMotion,
  clearingAnalysisCaches,
  decisionRecommendationsEnabled,
  effectiveDecisionRecommendationsEnabled,
  fetchShantenOnce,
  hasOpponentGroundTruth,
  invalidateOpponentRead,
  opponentAnalysisIsLoading,
  opponentAnalysisLoadError,
  opponentAnalysisNeeded,
  opponentAnalysisPermanentlyUnavailable,
  resetForBackendLifecycle,
  resetForNewGame,
  resolveNextDecisionAnalysis,
  ronWaitPredData,
  shantenOpponents,
  shantenRawData,
  shantenRawJson,
  shantenStatus,
  shantenViewMode,
  showTrainingRecommendations,
  suppressOpponentAnalysisTransitions,
  syncAnalysisVisibilityToBackend,
  toggleDecisionRecommendations,
} = useAnalysisSession({
  settings,
  status,
  gameView,
  showAnalysisDock,
  t,
  normalizeTrainingMode,
  applyStatus,
  applyGameView,
  scheduleTableZoomRecalc,
  clearDecisionPresentation: (treeRevision) => {
    gameView.analysis = null
    gameView.comparison = null
    gameView.pendingReview = null
    treeNodeList.value.forEach((node) => { node.comparison = null })
    if (gameView.tree) gameView.tree.revision = treeRevision
  },
})

const {
  activeCatalogEngine,
  activeEngineProfileDetail,
  addEngineProfile,
  captureRuntimeEngineProfile,
  chooseEngineFile,
  chooseEngineWeight,
  closeEngineWindow,
  deleteEngineProfile,
  duplicateEngineProfile,
  engineFooterMessage,
  engineOutputFilterItems,
  engineProfileListItems,
  engineSaveMessage,
  engineStatusItems,
  engineListCanDelete,
  engineListCanDuplicate,
  engineListCanMoveDown,
  engineListCanMoveUp,
  engineListDeleteConfirmation,
  flushEngineAutosave,
  handleEngineProfileAction,
  loadingEngineProfileId,
  localizedEngineText,
  markConfiguredEngineStarting,
  moveEngineProfile,
  openEngineWindow,
  selectEngineProfile,
  setEngineDeviceValue,
  setEngineOptionValue,
  setEngineOutputAssignmentValue,
  setEngineProfileNameValue,
  showEngineWindow,
  toggleEngineOutputFilter,
  unloadingEngineProfileId,
} = useEngineProfiles({
  settings,
  settingsDraft,
  status,
  locale,
  t,
  closeSettingsPanel: () => { showSettingsPanel.value = false },
  focus: () => focusFloatingPanel('engine'),
  applySettings,
  applyStatus,
  afterOpponentUnload: () => {
    if (!shantenResultHasRows(gameView.opponentAnalysis)) {
      clearOpponentAnalysisWithoutMotion()
    }
    void fetchShantenOnce()
  },
})

watch(
  () => [gameView.gameId, gameView.currentNodeId, status.controlledSeat],
  () => { void fetchShantenOnce() },
)

const {
  activatePlayPrefetchPosition,
  applyPlayPrefetchStatus,
  beginPlayPrefetchAdvance,
  markPlayPrefetchReady,
  playPrefetchReady,
  playPrefetchWaiting,
  resetPlayPrefetch,
} = usePlayPrefetch({
  currentPosition: () => ({ gameId: gameView.gameId, nodeId: gameView.currentNodeId }),
  onCurrentStatusChanged: () => scheduleAutoAdvance(),
})
const bootstrapError = ref('')
const backendRecoveryNeeded = ref(false)
const backendHasCheckpoint = ref(false)
const backendRetrying = ref(false)

async function retryBackend() {
  if (backendRetrying.value || !window.studioAPI) return
  backendRetrying.value = true
  try {
    if (backendRecoveryNeeded.value) await window.studioAPI.restartBackend()
    else await refreshBootstrapState()
  } catch (error) {
    bootstrapError.value = t('recovery.failed', { message: error instanceof Error ? error.message : String(error) })
  } finally {
    backendRetrying.value = false
  }
}
const { handleSoundTransitions } = useSoundTransitions({
  settings,
  status,
  isBlocked: () => Boolean(bootstrapError.value),
})

const isReadOnlyRecord = computed(() => Boolean(gameView.readOnly))
const { clearAutoAdvanceTimer, scheduleAutoAdvance } = useAutoAdvance({
  gameView,
  status,
  settings,
  readOnlyRecord: isReadOnlyRecord,
  prefetchReady: playPrefetchReady,
  prefetchWaiting: playPrefetchWaiting,
  motionDelayMs: () => autoAdvanceMotionDelayMs(),
  hasPendingMotion: () => hasPendingDiscardFlight(),
  advance: () => advanceGame(),
})
const {
  advanceGame,
  confirmPendingReview,
  currentGameplayResponseGeneration,
  discardTile,
  invalidateGameplayResponses,
  isUserDiscard,
  submitAction,
} = useGameplayActions({
  gameView,
  status,
  readOnlyRecord: isReadOnlyRecord,
  prefetchReady: playPrefetchReady,
  applyStatus,
  applyGameView,
  applyPlayPrefetchStatus,
  beginPlayPrefetchAdvance,
  scheduleAutoAdvance,
})
const {
  showWallView,
  wallTiles,
  wallLoading,
  wallViewComplete,
  wallCanReconstruct,
  wallSeed,
  wallOrigin,
  wallSourceUrl,
  wallReconstructionSeed,
  wallReconstructing,
  wallClipboardMessage,
  wallTileRows,
  openWallView,
  closeWallView,
  refreshWallView,
  reconstructImportedWalls,
  copyWallToClipboard,
  importWallFromClipboard,
  reportReconstructedRounds,
} = useWallView({
  gameView,
  readOnlyRecord: isReadOnlyRecord,
  t,
  focus: () => focusFloatingPanel('wall'),
  applyStatus,
  applyGameView,
})
const READ_ONLY_RECORD_HINT = computed(() => t('mode.readOnlyHint'))

const modeButtonLabel = computed(() => {
  if (isReadOnlyRecord.value) return t('mode.readOnlyResearch')
  return status.mode === 'play' ? t('mode.enterResearch') : t('mode.enterPlay')
})

const visibleHandsToggleLabel = computed(() => (
  status.visibleHands ? t('mode.hideHands') : t('mode.showHands')
))

const tableLabels = useMahjongPresentationLabels({ gameView, status, t })
const {
  relativeSeatLabel,
  seatWindLabel,
  isCurrentActorSeat,
  roundWindLabel,
  tileFaceLabel,
  reactionTypeLabel,
  ryukyokuActionLabel,
  specialActionLabel,
  normalizeTileFamily,
  redFive,
} = tableLabels


const roundLabel = computed(() => {
  const table = gameView.table
  if (!table) return '—'
  let label = `${roundWindLabel(table.bakaze)}${table.kyoku}`
  if (table.honba > 0) label += `-${table.honba}`
  return label
})

const windowTitle = computed(() => {
  const dirtyPrefix = recordDirty.value ? '*' : ''
  if (!gameView.table) return `${dirtyPrefix}—`
  const honba = Number(gameView.table.honba ?? 0)
  const score = gameView.table.scores?.[status.controlledSeat] ?? 25000
  const base = honba > 0
    ? `${gameView.table.bakaze}${gameView.table.kyoku}-${honba}`
    : `${gameView.table.bakaze}${gameView.table.kyoku}`
  return `${dirtyPrefix}${base} ${score}`
})


function formatTreeAction(action?: Record<string, unknown> | null): string {
  const a = action
  if (!a) return '—'
  const actionType = String(a.type || '')
  const actor = Number(a.actor ?? -1)
  const pai = a.pai ? tileFaceLabel(String(a.pai)) : ''

  // dora reveal — system event, no actor
  if (actionType === 'dora') return t('tree.newDora', { tile: pai })

  // System events do not belong to a player seat.
  if (actionType === 'start_kyoku') return t('action.roundStart')
  if (actionType === 'round_result') return t('action.roundResult')
  if (actionType === 'game_end' || actionType === 'match_end') return t('action.matchEnd')

  const seat = relativeSeatLabel(actor)
  const consumed = (Array.isArray(a.consumed) ? a.consumed : []).map((tile) => tileFaceLabel(String(tile))).join('')

  // dahai: 摸切 or 手切
  if (actionType === 'dahai') {
    const kind = Boolean(a.tsumogiri) ? t('action.tsumogiri') : t('action.tedashi')
    return t('tree.playerTileAction', { player: seat, action: kind, tile: pai })
  }

  // tsumo (draw) — hide opponent's drawn tile when visibleHands is off
  if (actionType === 'tsumo') {
    const showPai = status.visibleHands || actor === status.controlledSeat ? pai : '？'
    return t('tree.playerTileAction', { player: seat, action: t('action.draw'), tile: showPai })
  }

  // hora: 自摸 or 荣和
  if (actionType === 'hora') {
    const isTsumo = a.variant === 'tsumo' || actor === Number(a.target ?? -2)
    return t('tree.playerAction', { player: seat, action: isTsumo ? t('action.tsumo') : t('action.ron') })
  }

  // reach / riichi declaration
  if (actionType === 'reach') return t('tree.playerAction', { player: seat, action: t('action.riichi') })
  if (actionType === 'reach_accepted') return t('tree.playerAction', { player: seat, action: t('action.riichiAccepted') })

  // meld actions
  if (actionType === 'pon') return t('tree.playerMeldAction', { player: seat, action: t('action.pon'), tile: pai, consumed: consumed ? ` (${consumed})` : '' })
  if (actionType === 'chi') return t('tree.playerMeldAction', { player: seat, action: t('action.chi'), tile: pai, consumed: consumed ? ` (${consumed})` : '' })
  if (actionType === 'daiminkan' || actionType === 'ankan' || actionType === 'kakan') return t('tree.playerTileAction', { player: seat, action: t('action.kan'), tile: pai })

  // ryukyoku
  if (actionType === 'ryukyoku') {
    return ryukyokuActionLabel(a)
  }

  // fallback
  const label = reactionTypeLabel(actionType)
  return pai
    ? t('tree.playerTileAction', { player: seat, action: label, tile: pai })
    : t('tree.playerAction', { player: seat, action: label })
}

const {
  resolveSpecialEntry,
  resolveReactionEntry,
  resolveDiscardEntry,
  analysisEntryIsBest,
  resolveAnalysisEntryBar,
} = useDecisionEntryPresentation({
  gameView,
  t,
  normalizeTileFamily: (tile) => normalizeTileFamily(tile),
  redFive: (tile) => redFive(tile),
  reactionTypeLabel: (type) => reactionTypeLabel(type),
})

const {
  actionDisplayTiles,
  barFillStyle,
  barUpperStyle,
  findQuickPassAction,
  findQuickTsumogiriAction,
  formatActionValue,
  isBestAction,
  resolveDisplayedActionBar,
  resolveDisplayedDiscardSlotBar,
} = useDecisionActionPresentation({
  gameView,
  showTrainingRecommendations,
  t,
  normalizeTileFamily: (tile) => normalizeTileFamily(tile),
  redFive: (tile) => redFive(tile),
  getSpecialActions: () => specialActions.value,
  getDiscardActions: () => discardActions.value,
  getSouthHandDisplay: () => southHandDisplay.value,
  hasRecommendationAnalysis,
  resolveSpecialEntry,
  resolveReactionEntry,
  resolveDiscardEntry,
  analysisEntryIsBest,
  resolveAnalysisEntryBar,
})

const {
  HAND_DISCARD_GAP,
  tableSeatViews,
  southView,
  northView,
  eastView,
  westView,
  discardActions,
  specialActions,
  showTreeComparisons,
  centerDoraSlots,
  southDiscardBarSlots,
  southLaneStyle,
  canJumpToHistoricalNode,
  historicalJumpTitle,
  jumpToHistoricalNode,
  meldNodeId,
  meldDisplayTiles,
  southDisplayHandParts,
  eastDisplayHandParts,
  northDisplayHandParts,
  westDisplayHandParts,
  southHandDisplay,
  southRonRiskSlots,
  southRonRiskAdaptiveMax,
  showSouthRonRiskThreshold,
  riverDisplayRows,
} = useTablePresentation({
  gameView,
  status,
  currentTrainingMode,
  ronWaitPredData,
  t,
  labels: tableLabels,
  resolveDiscardEntry: (action) => resolveDiscardEntry(action),
  analysisEntryIsBest: (entry) => analysisEntryIsBest(entry),
  getNodeMapById: () => nodeMapById.value,
  jumpToNode: (nodeId) => jumpToNode(nodeId),
})

const opponentHandPresentations = computed<OpponentHandPresentation[]>(() => [
  { view: eastView.value, handParts: eastDisplayHandParts.value },
  { view: northView.value, handParts: northDisplayHandParts.value },
  { view: westView.value, handParts: westDisplayHandParts.value },
].filter((seat): seat is OpponentHandPresentation => Boolean(seat.view)))

const {
  ROUND_BASE_X,
  activeRoundRootId,
  isCurrentTreeDot,
  closeRoundMapOverlay,
  nodeMapById,
  onTreeScroll,
  openRoundMapOverlay,
  resumeTreeAutoFollow,
  roundMapDots,
  roundMapEdges,
  roundMapHitRegions,
  roundMapHoveredRoundId,
  roundMapOverlayOpen,
  roundMapRows,
  roundMapSettlementLayout,
  roundMapSettlementRoundLabel,
  roundMapSettlementTitle,
  roundMapSvgH,
  roundMapSvgW,
  roundRootById,
  specialNextMoveClass,
  suspendTreeAutoFollow,
  tileNextMoveClass,
  toggleRoundMapOverlay,
  treeBaseX,
  treeCanvasStyle,
  treeDotRadius,
  treeDotStrokeWidth,
  treeDots,
  treeEdgeStroke,
  treeEdgeWidth,
  treeHoveredNodeId,
  treeNodeList,
  treeRowActionLabels,
  treeScrollEl,
  treeSquareCornerRadius,
  treeSquareRadius,
  treeSvgH,
  treeSvgW,
  updateTreeViewport,
  visibleTreeDots,
  visibleTreeEdges,
  visibleTreeHitRegions,
  visibleTreeRows,
} = useBranchTreePresentation({
  gameView,
  status,
  settings,
  uiScale,
  showTreeComparisons,
  t,
  formatTreeAction,
  localizedResultTitle: (value) => localizedResultTitle(value, t),
  relativeSeatLabel,
  roundWindLabel,
  focusRoundMap: () => focusFloatingPanel('roundMap'),
})

function registerTreeScrollElement(element: Element | null) {
  treeScrollEl.value = element instanceof HTMLElement ? element : null
  if (treeScrollEl.value) void nextTick(updateTreeViewport)
}

function findTreeNodeById(nodeId: string): GameTreeNode | undefined {
  return nodeMapById.value.get(nodeId)
}
const {
  acceptsCurrentViewRequestContext,
  canDeleteCurrentNode,
  canSetCurrentNodeAsMainBranch,
  cancelPendingWheelNavigation,
  currentViewRequestContext,
  deleteCurrentNode,
  deleteNodeConfirmationPending,
  flushNodeComment,
  flushNodeCommentInBackground,
  hasNodeCommentDrafts,
  invalidateNavigation,
  jumpToNode,
  navigateTreeByOffset,
  nodeCommentDraft,
  nodeMutationRequestInFlight,
  onNodeCommentInput,
  resetForNewGame: resetBranchNavigationForNewGame,
  setCurrentNodeAsMainBranch,
  syncFromGameView: syncBranchNavigationFromGameView,
} = useBranchNavigation({
  gameView,
  status,
  isReadOnlyRecord,
  nodeMapById,
  activeRoundRootId,
  roundRootById,
  confirmationTimeoutMs: CONFIRMATION_TIMEOUT_MS,
  getGameplayResponseGeneration: currentGameplayResponseGeneration,
  markRecordDirty: () => markRecordDirty(),
  applyStatus,
  applyGameView,
})

const {
  clearRecordMetadata,
  closeGame,
  closeRecordConfirmationPending,
  closeRecordImportPanel,
  createGame,
  gameFileOperation,
  handleRecordDirtyChanged,
  handleRecordImported,
  markRecordDirty,
  openGame,
  openRecordImportPanel,
  recordDirty,
  recordHeaderTitle,
  recordPath,
  restoreRecordMetadata,
  saveGame,
  saveGameAs,
  setRecordDirtySnapshot,
  showRecordImportPanel,
  showRecordInFolder,
} = useRecordSession({
  status,
  gameView,
  flushNodeComment,
  hasNodeCommentDrafts,
  applyStatus,
  applyGameView,
  refreshGameView,
  prepareClose: () => {
    invalidateGameplayResponses()
    cancelPendingWheelNavigation()
    clearAutoAdvanceTimer()
    closeWallView(true)
    closeRoundMapOverlay()
  },
  handleReconstruction: async (roundCount) => {
    await openWallView()
    reportReconstructedRounds(roundCount)
  },
})

async function jumpToRoundRoot(roundRootId: string) {
  await jumpToNode(roundRootId)
}


const {
  tileArtworkReady,
  tileArtworkLoadingLabel,
  tileImageSrc,
  prepareTileArtwork,
} = useTileArtwork(t)


function applyStatus(nextStatus: StudioStatus) {
  Object.assign(status, nextStatus)
}

const {
  autoAdvanceMotionDelayMs,
  cancelPendingDiscardFlight,
  cancelPendingDiscardReturnFlight,
  hasPendingDiscardFlight,
  holdAutoAdvanceForTableMotion,
  pendingDiscardFromTable,
  pendingDiscardSignature,
  preparePendingDiscardReturnFlight,
  schedulePendingDiscardFlight,
  schedulePendingDiscardReturnFlight,
} = useDiscardFlight({
  status,
  reduceMotionEnabled,
  tileImageSrc,
  scheduleAutoAdvance,
})
function opponentAnalysisRoundKey(view: GameView): string | null {
  if (!view.gameId || !view.table) return null
  const roundRootId = view.tree?.currentRoundRootId
  if (roundRootId) return `${view.gameId}\u0000${roundRootId}`
  return `${view.gameId}\u0000${view.table.roundIndex}\u0000${view.table.honba}`
}

function treeNodeCount(tree: GameView['tree']): number {
  const nodes = tree?.nodes
  if (Array.isArray(nodes)) return nodes.length
  return nodes && typeof nodes === 'object' ? Object.keys(nodes).length : 0
}

function treeContainsNode(tree: GameView['tree'], nodeId: string | null | undefined): boolean {
  if (!nodeId) return false
  const nodes = tree?.nodes
  if (Array.isArray(nodes)) return nodes.some((node) => node.id === nodeId)
  return Boolean(nodes && typeof nodes === 'object' && Object.prototype.hasOwnProperty.call(nodes, nodeId))
}

function applyGameView(nextView: GameView, transitionDirection: GameViewTransitionDirection = 'forward') {
  invalidateOpponentRead()
  const previousSoundView: SoundTransitionView = {
    table: gameView.table,
    legalActions: gameView.legalActions,
    pendingReview: gameView.pendingReview,
  }
  const isNewGame = nextView.gameId !== gameView.gameId
  const previousRoundKey = opponentAnalysisRoundKey(gameView)
  const nextRoundKey = opponentAnalysisRoundKey(nextView)
  const roundChanged = isNewGame || (nextRoundKey !== null && nextRoundKey !== previousRoundKey)
  if (roundChanged) {
    clearOpponentAnalysisWithoutMotion()
  }
  const nextAnalysis = resolveNextDecisionAnalysis(nextView, isNewGame)
  const previousPendingDiscard = pendingDiscardFromTable(gameView.table)
  const previousPendingSignature = pendingDiscardSignature(previousPendingDiscard)
  const nextPendingDiscard = pendingDiscardFromTable(nextView.table)
  const nextPendingSignature = pendingDiscardSignature(nextPendingDiscard)
  const pendingDiscardChanged = previousPendingSignature !== nextPendingSignature
  if (pendingDiscardChanged) {
    cancelPendingDiscardFlight()
    cancelPendingDiscardReturnFlight()
    holdAutoAdvanceForTableMotion()
  }
  const returnFlight = !isNewGame
    && transitionDirection === 'backward'
    && previousPendingDiscard
    && !nextPendingDiscard
    ? preparePendingDiscardReturnFlight(previousPendingDiscard.actor)
    : null
  if (isNewGame) {
    resetForNewGame()
    resetBranchNavigationForNewGame()
  }
  gameView.gameId = nextView.gameId
  gameView.matchId = nextView.matchId
  gameView.readOnly = Boolean(nextView.readOnly)
  gameView.sourceUrl = nextView.sourceUrl || null
  gameView.readOnlyReason = nextView.readOnlyReason || null
  gameView.currentNodeId = nextView.currentNodeId
  gameView.nodeComment = nextView.nodeComment || ''
  syncBranchNavigationFromGameView(nextView)
  gameView.opponentAnalysis = nextView.opponentAnalysis || null
  activatePlayPrefetchPosition(nextView.gameId, nextView.currentNodeId)
  gameView.matchSummary = nextView.matchSummary
  gameView.table = nextView.table
  gameView.legalActions = nextView.legalActions
  gameView.analysis = nextAnalysis
  gameView.comparison = nextView.comparison
  gameView.pendingReview = nextView.pendingReview
  if (gameView.opponentAnalysis) {
    const analysisUnavailable = opponentAnalysisPermanentlyUnavailable.value
    applyShantenResult(gameView.opponentAnalysis, {
      withoutMotion: analysisUnavailable,
      clearWhenEmpty: analysisUnavailable,
    })
  }
  const nextTree = nextView.tree
  const currentTree = gameView.tree
  const currentTreeHasCursor = treeContainsNode(currentTree, nextTree?.currentNodeId)
  const canReuseFullTree = !isNewGame
    && Boolean(currentTree && nextTree)
    && !nextTree?.compact
    && currentTreeHasCursor
    && treeNodeCount(currentTree) === treeNodeCount(nextTree)
    && nextTree?.revision !== undefined
    && nextTree.revision === currentTree?.revision
    && nextTree.viewSeat === currentTree?.viewSeat
    && nextTree.currentRoundRootId === currentTree?.currentRoundRootId
  if (!isNewGame && currentTree && nextTree?.compact) {
    currentTree.currentNodeId = nextTree.currentNodeId
    currentTree.mainLeafNodeId = nextTree.mainLeafNodeId
    currentTree.currentRoundRootId = nextTree.currentRoundRootId
    currentTree.viewSeat = nextTree.viewSeat
    // A compact response has no nodes. Keep the content revision unchanged so
    // the next full response cannot mistake a stale tree for an up-to-date one.
  } else if (canReuseFullTree && currentTree && nextTree) {
    currentTree.currentNodeId = nextTree.currentNodeId
    currentTree.mainLeafNodeId = nextTree.mainLeafNodeId
    currentTree.currentRoundRootId = nextTree.currentRoundRootId
  } else {
    gameView.tree = nextTree
  }
  scheduleAutoAdvance()
  handleSoundTransitions(previousSoundView, nextView, isNewGame, transitionDirection)
  if (returnFlight) {
    schedulePendingDiscardReturnFlight(returnFlight)
  } else if (!isNewGame && transitionDirection === 'forward' && pendingDiscardChanged && nextPendingDiscard) {
    schedulePendingDiscardFlight(nextPendingDiscard.actor)
  }
  if (showWallView.value) void refreshWallView()
  if (showCustomTenhouExport.value) customTenhouExportRefreshKey.value += 1
}

function hasRecommendationAnalysis(): boolean {
  const analysis = gameView.analysis
  return Boolean(analysis?.discardEntries?.length || analysis?.reactionEntries?.length || analysis?.specialEntries?.length)
}

function openExternalLink(url: string) {
  void window.studioAPI?.openExternal(url).catch((error) => {
    console.error('Failed to open external link:', error)
  })
}

function openEngineLegalDocument(kind: 'license' | 'notice', index: number) {
  if (!activeCatalogEngine.value) return
  void window.studioAPI?.openEngineLegalDocument({
    engineId: activeCatalogEngine.value.id,
    kind,
    index,
  }).catch((error) => {
    console.error('Failed to open engine legal document:', error)
  })
}

async function refreshGameView() {
  if (!window.studioAPI) return
  const requestContext = currentViewRequestContext()
  const nodeId = gameView.currentNodeId
  const response = await window.studioAPI.getGameView()
  if (nodeId !== gameView.currentNodeId || !acceptsCurrentViewRequestContext(requestContext)) return
  applyStatus(response.state)
  applyGameView(response.view)
}

async function refreshBootstrapState() {
  if (!window.studioAPI) {
    bootstrapError.value = t('error.desktopBridge')
    return
  }
  try {
    // Load settings first — this works even if the Python backend is down
    let nextSettings: StudioSettings
    try {
      nextSettings = await window.studioAPI.getSettings()
      applySettings(nextSettings)
      captureRuntimeEngineProfile('decision', nextSettings.engines)
      captureRuntimeEngineProfile('opponent', nextSettings.engines)
      markConfiguredEngineStarting('decision', nextSettings.engines)
      markConfiguredEngineStarting('opponent', nextSettings.engines)
    } catch {
      // Settings file not readable? Use defaults already in `settings`
    }
    const nextStatus = await window.studioAPI.getStatus()
    applyStatus(nextStatus)
    markConfiguredEngineStarting('decision', settings.engines)
    markConfiguredEngineStarting('opponent', settings.engines)
    await syncAnalysisVisibilityToBackend()
    const restored = await window.studioAPI.restoreStartupRecovery()
    if (restored) {
      applyStatus(restored.state)
      applyGameView(restored.view)
      restoreRecordMetadata(restored.path, Boolean(restored.recoveryRecord))
    } else {
      await refreshGameView()
    }
    if (window.studioAPI.getRecordDirty) {
      setRecordDirtySnapshot(await window.studioAPI.getRecordDirty())
    }
    bootstrapError.value = ''
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('exited before responding') || message.includes('Permission denied') || message.includes('ModuleNotFoundError')) {
      bootstrapError.value = t('error.backendStart', { message })
      cloneSettingsDraftFromCurrent()
      showSettingsPanel.value = true
    } else {
      bootstrapError.value = t('error.bootstrap', { message })
    }
  }
}

function openCustomTenhouExport() {
  if (!gameView.currentNodeId) return
  showCustomTenhouExport.value = true
  focusFloatingPanel('customExport')
}

async function prepareRendererForDisplay() {
  await nextTick()
  updateTreeViewport()
  const bootstrapRefresh = refreshBootstrapState()
  await prepareTileArtwork()
  await bootstrapRefresh
}

async function toggleMode() {
  if (!window.studioAPI || !status.gameLoaded || isReadOnlyRecord.value) return
  invalidateGameplayResponses()
  cancelPendingWheelNavigation()
  clearAutoAdvanceTimer()
  const nextMode = status.mode === 'play' ? 'research' : 'play'
  applyStatus(await window.studioAPI.setMode(nextMode))
  await refreshGameView()
}

async function showRoundMapInResearchMode() {
  if (!window.studioAPI || !status.gameLoaded) return
  if (status.mode !== 'research') {
    invalidateGameplayResponses()
    cancelPendingWheelNavigation()
    clearAutoAdvanceTimer()
    applyStatus(await window.studioAPI.setMode('research'))
    await refreshGameView()
  }
  openRoundMapOverlay()
}

async function toggleVisibleHands() {
  if (!window.studioAPI) return
  applyStatus(await window.studioAPI.toggleVisibleHands())
  await refreshGameView()
}

async function switchSeat(seat: number, label: string) {
  if (!window.studioAPI || seatSwitchInFlight.value || seat === status.controlledSeat) return
  invalidateGameplayResponses()
  invalidateNavigation()
  seatSwitchInFlight.value = true
  pendingSeatSwitchLabel.value = label
  try {
    const requestContext = currentViewRequestContext()
    gameView.analysis = null
    const response = await window.studioAPI.requestSeatSwitch(seat)
    if (!acceptsCurrentViewRequestContext(requestContext)) return
    applyStatus(response)
    await refreshGameView()
  } finally {
    seatSwitchInFlight.value = false
    pendingSeatSwitchLabel.value = ''
  }
}

watchEffect(() => {
  document.title = windowTitle.value
})

function onTableWheel(event: WheelEvent) {
  event.preventDefault()
  if (status.mode !== 'research') return
  if (event.deltaY > 0) navigateTreeByOffset(1)
  if (event.deltaY < 0) navigateTreeByOffset(-1)
}

function onTableContextMenu(event: MouseEvent) {
  event.preventDefault()
  const passAction = findQuickPassAction()
  if (passAction) {
    void submitAction(passAction)
    return
  }
  const tsumogiriAction = findQuickTsumogiriAction()
  if (tsumogiriAction) {
    void discardTile(tsumogiriAction.pai || '', true)
  }
}

function onSouthHandContextMenu(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  const passAction = findQuickPassAction()
  if (passAction) {
    void submitAction(passAction)
    return
  }
  const tsumogiriAction = findQuickTsumogiriAction()
  if (tsumogiriAction) {
    void discardTile(tsumogiriAction.pai || '', true)
  }
}

const handlePythonEvent = createPythonEventRouter({
  status,
  gameView,
  bootstrapError,
  backendRecoveryNeeded,
  backendHasCheckpoint,
  clearingAnalysisCaches,
  effectiveDecisionRecommendationsEnabled,
  nodeMapById,
  t,
  applyStatus,
  applyGameView,
  clearRecordMetadata,
  resetForBackendLifecycle,
  invalidateGameplayResponses,
  invalidateNavigation,
  clearAutoAdvanceTimer,
  resetPlayPrefetch,
  acceptsOpponentEventEpoch,
  acceptsDecisionEventEpoch,
  markPlayPrefetchReady,
  clearOpponentAnalysisWithoutMotion,
  fetchShantenOnce,
  applyOpponentAnalysisEvent,
  cacheDecisionAnalysis,
})

async function fetchAndShowMjaiDebug() {
  showMjaiDebug.value = true
  analysisCacheClearMessage.value = ''
  if (window.studioAPI?.getLatestMjaiDebug) {
    try {
      const result = await window.studioAPI.getLatestMjaiDebug()
      mjaiDebugData.value = (result as Record<string, unknown>).debug as Record<string, unknown> || {}
    } catch {
      mjaiDebugData.value = { error: 'Failed to fetch mjai debug data' }
    }
  }
  if (window.studioAPI?.getAnalysisDebug) {
    try {
      const result = await window.studioAPI.getAnalysisDebug()
      shantenMjaiData.value = (result as Record<string, unknown>).debug as Record<string, unknown> || {}
    } catch {
      shantenMjaiData.value = { error: 'Failed to fetch shanten mjai' }
    }
  }
}

let lastUiScaleWheelAt = 0
function onUiScaleWheel(event: WheelEvent) {
  if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return
  event.preventDefault()
  event.stopImmediatePropagation()
  const now = performance.now()
  if (now - lastUiScaleWheelAt < 90) return
  lastUiScaleWheelAt = now
  void changeUiScale(event.deltaY < 0 ? 'in' : 'out')
}

function onKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      void changeUiScale('in')
      return
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      void changeUiScale('out')
      return
    }
    if (e.key === '0') {
      e.preventDefault()
      void changeUiScale('reset')
      return
    }
  }
  if (e.key === 'F8' && import.meta.env.DEV) {
    e.preventDefault()
    showPerceptualColorDebugger.value = !showPerceptualColorDebugger.value
    return
  }
  if (e.key === 'F1') {
    e.preventDefault()
    if (showMjaiDebug.value) {
      showMjaiDebug.value = false
    } else {
      void fetchAndShowMjaiDebug()
    }
  }
}

useDesktopBridgeSubscriptions({
  pythonEvent: handlePythonEvent,
  recordDirtyChanged: handleRecordDirtyChanged,
  uiZoomShortcut: (direction) => { void changeUiScale(direction) },
  beforeClose: () => flushBeforeClose(
    flushNodeComment,
    flushEngineAutosave,
    () => engineSaveMessage.value || t('native.closeSaveFailed.message'),
  ),
})

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('wheel', onUiScaleWheel, { capture: true, passive: false })
  startRuntimeMetrics()
  void prepareRendererForDisplay()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('wheel', onUiScaleWheel, true)
  document.documentElement.classList.remove('reduce-motion')
})
if (import.meta.env.MODE === 'ui-test') {
  installAnalysisTestHarness(proxyRefs({
    recordDirty,
    recordPath,
    saveGame,
    saveGameAs,
    status,
    gameView,
    settings,
    workspaceLayout,
    analysisCountLayout,
    showPerceptualColorDebugger,
    bootstrapError,
    tileArtworkReady,
    opponentAnalysisIsLoading,
    showWallView,
    wallTiles,
    showEngineWindow,
    showMjaiDebug,
    handlePythonEvent,
    fetchShantenOnce,
    jumpToNode,
    toggleAnalysisDock,
    clearLoadedAnalysisCaches,
    openWallView,
    closeWallView,
    openEngineWindow,
    closeEngineWindow,
  }))
}
</script>
