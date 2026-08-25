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
            :title="isReadOnlyRecord ? READ_ONLY_RECORD_HINT : undefined"
          >
            <button @click="toggleMode" :disabled="!status.gameLoaded || isReadOnlyRecord">{{ modeButtonLabel }}</button>
          </span>
          <button @click="openWallView" :disabled="!gameView.table">{{ t('toolbar.wall') }}</button>
          <button
            :class="{ active: showAnalysisDock }"
            :aria-pressed="showAnalysisDock"
            @click="toggleAnalysisDock"
            :disabled="!gameView.table"
          >{{ t('toolbar.analysis') }}</button>
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
      <button @click="refreshBootstrapState">{{ t('common.retry') }}</button>
    </div>

    <main ref="workspaceRoot" class="workspace">
      <section class="panel table-panel" :style="{ order: workspaceItemOrder('table') }">
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
          <div class="grid-main">
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
                    :title="canToggleDecisionRecommendations ? (decisionRecommendationsEnabled ? t('toolbar.hide') : t('toolbar.show')) : undefined"
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
                              :title="historicalJumpTitle(meldNodeId(southView.seat, southView.melds.length - 1 - mi), item.isKakan ? t('history.ponTile') : t('history.meld'))"
                              @dblclick.stop="jumpToHistoricalNode(meldNodeId(southView.seat, southView.melds.length - 1 - mi))"
                            />
                            <img
                              v-if="item.isKakan"
                              :class="['tileImg', item.tileClass, 'kakan-stack', { 'history-jump-target': canJumpToHistoricalNode(meldNodeId(southView.seat, southView.melds.length - 1 - mi, 'kakan')) }]"
                              :src="item.isBack ? tileImageSrc('?') : tileImageSrc(item.tile)"
                              :alt="tileFaceLabel(item.tile)"
                              :title="historicalJumpTitle(meldNodeId(southView.seat, southView.melds.length - 1 - mi, 'kakan'), t('history.kakanTile'))"
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
                    :title="canToggleDecisionRecommendations ? (decisionRecommendationsEnabled ? t('toolbar.hide') : t('toolbar.show')) : undefined"
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

            <!-- 屏幕右侧（east 方位），用户下家 -->
            <span class="grid-hand pov-p1 grid-hand-p1" :class="{ 'hands-hidden': !status.visibleHands }" v-if="eastView">
              <span
                class="pov-p1 hand-closed-p1 opponent-hand-toggle"
                role="button"
                tabindex="0"
                :aria-label="visibleHandsToggleLabel"
                :title="visibleHandsToggleLabel"
                @click.stop="toggleVisibleHands"
                @keydown.enter.prevent="toggleVisibleHands"
                @keydown.space.prevent="toggleVisibleHands"
              >
                <div
                  v-for="(tile, index) in eastDisplayHandParts.closed"
                  :key="'p1h-'+index"
                  :class="['tileDiv', { 'hand-discard-gap': tile === HAND_DISCARD_GAP }]"
                  :data-hand-gap-seat="tile === HAND_DISCARD_GAP ? eastView.seat : undefined"
                ><img v-if="tile !== HAND_DISCARD_GAP" :src="tileImageSrc(tile)" class="tileImg" :alt="tileFaceLabel(tile)" /></div>
                <span v-if="eastDisplayHandParts.drawn" class="draw-gap draw-gap-p1"></span>
                <div
                  v-if="eastDisplayHandParts.drawn"
                  :class="['tileDiv', 'is-drawn', { 'hand-discard-gap': eastDisplayHandParts.drawn === HAND_DISCARD_GAP }]"
                  :data-hand-gap-seat="eastDisplayHandParts.drawn === HAND_DISCARD_GAP ? eastView.seat : undefined"
                ><img v-if="eastDisplayHandParts.drawn !== HAND_DISCARD_GAP" :src="tileImageSrc(eastDisplayHandParts.drawn)" class="tileImg" :alt="tileFaceLabel(eastDisplayHandParts.drawn)" /></div>
                <div class="tileDiv narrow" v-if="eastView.hand.length < 13" style="opacity:0"><img :src="tileImageSrc('?')" class="tileImg" /></div>
              </span>
              <span class="pov-p1 hand-calls-p1" v-if="eastView.melds.length">
                <template v-for="(meld, mi) in eastView.melds.slice().reverse()" :key="'p1m-'+mi">
                  <div v-for="(item, ti) in meldDisplayTiles(meld, eastView.seat)" :key="'p1mt-'+ti" class="tileDiv">
                    <img :class="['tileImg', item.tileClass, { 'history-jump-target': canJumpToHistoricalNode(meldNodeId(eastView.seat, eastView.melds.length - 1 - mi)) }]" :src="item.isBack ? tileImageSrc('?') : tileImageSrc(item.tile)" :alt="tileFaceLabel(item.tile)" :title="historicalJumpTitle(meldNodeId(eastView.seat, eastView.melds.length - 1 - mi), item.isKakan ? t('history.ponTile') : t('history.meld'))" @dblclick.stop="jumpToHistoricalNode(meldNodeId(eastView.seat, eastView.melds.length - 1 - mi))" />
                    <img v-if="item.isKakan" :class="['tileImg', item.tileClass, 'kakan-stack', { 'history-jump-target': canJumpToHistoricalNode(meldNodeId(eastView.seat, eastView.melds.length - 1 - mi, 'kakan')) }]" :src="item.isBack ? tileImageSrc('?') : tileImageSrc(item.tile)" :alt="tileFaceLabel(item.tile)" :title="historicalJumpTitle(meldNodeId(eastView.seat, eastView.melds.length - 1 - mi, 'kakan'), t('history.kakanTile'))" @dblclick.stop="jumpToHistoricalNode(meldNodeId(eastView.seat, eastView.melds.length - 1 - mi, 'kakan'))" />
                  </div>
                </template>
              </span>
            </span>

            <!-- 屏幕上方（north 方位），用户对家 -->
            <span class="grid-hand pov-p2 grid-hand-p2" :class="{ 'hands-hidden': !status.visibleHands }" v-if="northView">
              <span
                class="pov-p2 hand-closed-p2 opponent-hand-toggle"
                role="button"
                tabindex="0"
                :aria-label="visibleHandsToggleLabel"
                :title="visibleHandsToggleLabel"
                @click.stop="toggleVisibleHands"
                @keydown.enter.prevent="toggleVisibleHands"
                @keydown.space.prevent="toggleVisibleHands"
              >
                <div
                  v-for="(tile, index) in northDisplayHandParts.closed"
                  :key="'p2h-'+index"
                  :class="['tileDiv', { 'hand-discard-gap': tile === HAND_DISCARD_GAP }]"
                  :data-hand-gap-seat="tile === HAND_DISCARD_GAP ? northView.seat : undefined"
                ><img v-if="tile !== HAND_DISCARD_GAP" :src="tileImageSrc(tile)" class="tileImg" :alt="tileFaceLabel(tile)" /></div>
                <span v-if="northDisplayHandParts.drawn" class="draw-gap draw-gap-p2"></span>
                <div
                  v-if="northDisplayHandParts.drawn"
                  :class="['tileDiv', 'is-drawn', { 'hand-discard-gap': northDisplayHandParts.drawn === HAND_DISCARD_GAP }]"
                  :data-hand-gap-seat="northDisplayHandParts.drawn === HAND_DISCARD_GAP ? northView.seat : undefined"
                ><img v-if="northDisplayHandParts.drawn !== HAND_DISCARD_GAP" :src="tileImageSrc(northDisplayHandParts.drawn)" class="tileImg" :alt="tileFaceLabel(northDisplayHandParts.drawn)" /></div>
                <div class="tileDiv narrow" v-if="northView.hand.length < 13" style="opacity:0"><img :src="tileImageSrc('?')" class="tileImg" /></div>
              </span>
              <span class="pov-p2 hand-calls-p2" v-if="northView.melds.length">
                <template v-for="(meld, mi) in northView.melds.slice().reverse()" :key="'p2m-'+mi">
                  <div v-for="(item, ti) in meldDisplayTiles(meld, northView.seat)" :key="'p2mt-'+ti" class="tileDiv">
                    <img :class="['tileImg', item.tileClass, { 'history-jump-target': canJumpToHistoricalNode(meldNodeId(northView.seat, northView.melds.length - 1 - mi)) }]" :src="item.isBack ? tileImageSrc('?') : tileImageSrc(item.tile)" :alt="tileFaceLabel(item.tile)" :title="historicalJumpTitle(meldNodeId(northView.seat, northView.melds.length - 1 - mi), item.isKakan ? t('history.ponTile') : t('history.meld'))" @dblclick.stop="jumpToHistoricalNode(meldNodeId(northView.seat, northView.melds.length - 1 - mi))" />
                    <img v-if="item.isKakan" :class="['tileImg', item.tileClass, 'kakan-stack', { 'history-jump-target': canJumpToHistoricalNode(meldNodeId(northView.seat, northView.melds.length - 1 - mi, 'kakan')) }]" :src="item.isBack ? tileImageSrc('?') : tileImageSrc(item.tile)" :alt="tileFaceLabel(item.tile)" :title="historicalJumpTitle(meldNodeId(northView.seat, northView.melds.length - 1 - mi, 'kakan'), t('history.kakanTile'))" @dblclick.stop="jumpToHistoricalNode(meldNodeId(northView.seat, northView.melds.length - 1 - mi, 'kakan'))" />
                  </div>
                </template>
              </span>
            </span>

            <!-- 屏幕左侧（west 方位），用户上家 -->
            <span class="grid-hand pov-p3 grid-hand-p3" :class="{ 'hands-hidden': !status.visibleHands }" v-if="westView">
              <span
                class="pov-p3 hand-closed-p3 opponent-hand-toggle"
                role="button"
                tabindex="0"
                :aria-label="visibleHandsToggleLabel"
                :title="visibleHandsToggleLabel"
                @click.stop="toggleVisibleHands"
                @keydown.enter.prevent="toggleVisibleHands"
                @keydown.space.prevent="toggleVisibleHands"
              >
                <div
                  v-for="(tile, index) in westDisplayHandParts.closed"
                  :key="'p3h-'+index"
                  :class="['tileDiv', { 'hand-discard-gap': tile === HAND_DISCARD_GAP }]"
                  :data-hand-gap-seat="tile === HAND_DISCARD_GAP ? westView.seat : undefined"
                ><img v-if="tile !== HAND_DISCARD_GAP" :src="tileImageSrc(tile)" class="tileImg" :alt="tileFaceLabel(tile)" /></div>
                <span v-if="westDisplayHandParts.drawn" class="draw-gap draw-gap-p3"></span>
                <div
                  v-if="westDisplayHandParts.drawn"
                  :class="['tileDiv', 'is-drawn', { 'hand-discard-gap': westDisplayHandParts.drawn === HAND_DISCARD_GAP }]"
                  :data-hand-gap-seat="westDisplayHandParts.drawn === HAND_DISCARD_GAP ? westView.seat : undefined"
                ><img v-if="westDisplayHandParts.drawn !== HAND_DISCARD_GAP" :src="tileImageSrc(westDisplayHandParts.drawn)" class="tileImg" :alt="tileFaceLabel(westDisplayHandParts.drawn)" /></div>
                <div class="tileDiv narrow" v-if="westView.hand.length < 13" style="opacity:0"><img :src="tileImageSrc('?')" class="tileImg" /></div>
              </span>
              <span class="pov-p3 hand-calls-p3" v-if="westView.melds.length">
                <template v-for="(meld, mi) in westView.melds.slice().reverse()" :key="'p3m-'+mi">
                  <div v-for="(item, ti) in meldDisplayTiles(meld, westView.seat)" :key="'p3mt-'+ti" class="tileDiv">
                    <img :class="['tileImg', item.tileClass, { 'history-jump-target': canJumpToHistoricalNode(meldNodeId(westView.seat, westView.melds.length - 1 - mi)) }]" :src="item.isBack ? tileImageSrc('?') : tileImageSrc(item.tile)" :alt="tileFaceLabel(item.tile)" :title="historicalJumpTitle(meldNodeId(westView.seat, westView.melds.length - 1 - mi), item.isKakan ? t('history.ponTile') : t('history.meld'))" @dblclick.stop="jumpToHistoricalNode(meldNodeId(westView.seat, westView.melds.length - 1 - mi))" />
                    <img v-if="item.isKakan" :class="['tileImg', item.tileClass, 'kakan-stack', { 'history-jump-target': canJumpToHistoricalNode(meldNodeId(westView.seat, westView.melds.length - 1 - mi, 'kakan')) }]" :src="item.isBack ? tileImageSrc('?') : tileImageSrc(item.tile)" :alt="tileFaceLabel(item.tile)" :title="historicalJumpTitle(meldNodeId(westView.seat, westView.melds.length - 1 - mi, 'kakan'), t('history.kakanTile'))" @dblclick.stop="jumpToHistoricalNode(meldNodeId(westView.seat, westView.melds.length - 1 - mi, 'kakan'))" />
                  </div>
                </template>
              </span>
            </span>

            <!-- Rivers -->
            <span class="grid-discard pov-p0 grid-discard-p0" v-if="southView">
              <span v-for="(row, rowIndex) in riverDisplayRows(southView)" :key="`river-${southView.seat}-${rowIndex}`" class="river-row">
                <div
                  v-for="slot in row"
                  :key="slot.key"
                  :class="['tileDiv', slot.isPending ? 'tileDivPending' : '', slot.isRiichiDiscard ? 'river-riichi' : '', { 'history-jump-target': canJumpToHistoricalNode(slot.sourceNodeId) }]"
                  :data-pending-discard-seat="slot.isPending ? southView.seat : undefined"
                  :title="historicalJumpTitle(slot.sourceNodeId, t('history.discard'))"
                  @dblclick.stop="jumpToHistoricalNode(slot.sourceNodeId)"
                >
                  <img
                    :src="tileImageSrc(slot.tile)"
                    :class="['tileImg', slot.isClaimed ? 'river-claimed called' : (slot.isTsumogiri && showTsumogiriTone ? 'river-tsumogiri' : ''), slot.isPending ? 'last-discard' : '', slot.isRiichiDiscard ? 'river-riichi' : '']"
                    :alt="tileFaceLabel(slot.tile)"
                  />
                </div>
              </span>
            </span>
            <span class="grid-discard pov-p3 grid-discard-p3" v-if="westView">
              <span v-for="(row, rowIndex) in riverDisplayRows(westView)" :key="`river-${westView.seat}-${rowIndex}`" class="river-row">
                <div
                  v-for="slot in row"
                  :key="slot.key"
                  :class="['tileDiv', slot.isPending ? 'tileDivPending' : '', slot.isRiichiDiscard ? 'river-riichi' : '', { 'history-jump-target': canJumpToHistoricalNode(slot.sourceNodeId) }]"
                  :data-pending-discard-seat="slot.isPending ? westView.seat : undefined"
                  :title="historicalJumpTitle(slot.sourceNodeId, t('history.discard'))"
                  @dblclick.stop="jumpToHistoricalNode(slot.sourceNodeId)"
                >
                  <img
                    :src="tileImageSrc(slot.tile)"
                    :class="['tileImg', slot.isClaimed ? 'river-claimed called' : (slot.isTsumogiri && showTsumogiriTone ? 'river-tsumogiri' : ''), slot.isPending ? 'last-discard' : '', slot.isRiichiDiscard ? 'river-riichi' : '']"
                    :alt="tileFaceLabel(slot.tile)"
                  />
                </div>
              </span>
            </span>
            <span class="grid-discard pov-p2 grid-discard-p2" v-if="northView">
              <span v-for="(row, rowIndex) in riverDisplayRows(northView)" :key="`river-${northView.seat}-${rowIndex}`" class="river-row">
                <div
                  v-for="slot in row"
                  :key="slot.key"
                  :class="['tileDiv', slot.isPending ? 'tileDivPending' : '', slot.isRiichiDiscard ? 'river-riichi' : '', { 'history-jump-target': canJumpToHistoricalNode(slot.sourceNodeId) }]"
                  :data-pending-discard-seat="slot.isPending ? northView.seat : undefined"
                  :title="historicalJumpTitle(slot.sourceNodeId, t('history.discard'))"
                  @dblclick.stop="jumpToHistoricalNode(slot.sourceNodeId)"
                >
                  <img
                    :src="tileImageSrc(slot.tile)"
                    :class="['tileImg', slot.isClaimed ? 'river-claimed called' : (slot.isTsumogiri && showTsumogiriTone ? 'river-tsumogiri' : ''), slot.isPending ? 'last-discard' : '', slot.isRiichiDiscard ? 'river-riichi' : '']"
                    :alt="tileFaceLabel(slot.tile)"
                  />
                </div>
              </span>
            </span>
            <span class="grid-discard pov-p1 grid-discard-p1" v-if="eastView">
              <span v-for="(row, rowIndex) in riverDisplayRows(eastView)" :key="`river-${eastView.seat}-${rowIndex}`" class="river-row">
                <div
                  v-for="slot in row"
                  :key="slot.key"
                  :class="['tileDiv', slot.isPending ? 'tileDivPending' : '', slot.isRiichiDiscard ? 'river-riichi' : '', { 'history-jump-target': canJumpToHistoricalNode(slot.sourceNodeId) }]"
                  :data-pending-discard-seat="slot.isPending ? eastView.seat : undefined"
                  :title="historicalJumpTitle(slot.sourceNodeId, t('history.discard'))"
                  @dblclick.stop="jumpToHistoricalNode(slot.sourceNodeId)"
                >
                  <img
                    :src="tileImageSrc(slot.tile)"
                    :class="['tileImg', slot.isClaimed ? 'river-claimed called' : (slot.isTsumogiri && showTsumogiriTone ? 'river-tsumogiri' : ''), slot.isPending ? 'last-discard' : '', slot.isRiichiDiscard ? 'river-riichi' : '']"
                    :alt="tileFaceLabel(slot.tile)"
                  />
                </div>
              </span>
            </span>

            <!-- Center info hub -->
            <div class="grid-info">
              <button class="info-round" @click.stop="toggleRoundMapOverlay">{{ roundLabel }}</button>
              <span class="info-tiles-left" v-if="gameView.table">x{{ gameView.table.wallRemaining }}</span>
              <span class="info-doras" v-if="gameView.table">
                <div v-for="(tile, index) in centerDoraSlots" :key="'dora-'+index" class="tileDiv">
                  <img :src="tileImageSrc(tile)" class="tileImg" :alt="tileFaceLabel(tile)" />
                </div>
              </span>
              <span v-if="gameView.table" class="gi-player-anchor gi-p0-anchor"><span class="gi-p0-outer" :class="{ 'is-actor': isCurrentActorSeat(southView.seat), 'is-east': southView.seat === gameView.table.dealer }"><span class="gi-seat">{{ seatWindLabel(southView.seat) }}</span><span class="gi-score">{{ gameView.table?.scores?.[southView.seat] ?? 0 }}</span><span class="gi-riichi-bet" :class="{ on: southView.riichiAccepted }">-1000</span></span></span>
              <span v-if="gameView.table" class="gi-player-anchor gi-p1-anchor"><span class="gi-p1-outer" :class="{ 'is-actor': isCurrentActorSeat(eastView.seat), 'is-east': eastView.seat === gameView.table.dealer }"><span class="gi-seat">{{ seatWindLabel(eastView.seat) }}</span><span class="gi-score">{{ gameView.table?.scores?.[eastView.seat] ?? 0 }}</span><span class="gi-riichi-bet" :class="{ on: eastView.riichiAccepted }">-1000</span></span></span>
              <span v-if="gameView.table" class="gi-player-anchor gi-p2-anchor"><span class="gi-p2-outer" :class="{ 'is-actor': isCurrentActorSeat(northView.seat), 'is-east': northView.seat === gameView.table.dealer }"><span class="gi-seat">{{ seatWindLabel(northView.seat) }}</span><span class="gi-score">{{ gameView.table?.scores?.[northView.seat] ?? 0 }}</span><span class="gi-riichi-bet" :class="{ on: northView.riichiAccepted }">-1000</span></span></span>
              <span v-if="gameView.table" class="gi-player-anchor gi-p3-anchor"><span class="gi-p3-outer" :class="{ 'is-actor': isCurrentActorSeat(westView.seat), 'is-east': westView.seat === gameView.table.dealer }"><span class="gi-seat">{{ seatWindLabel(westView.seat) }}</span><span class="gi-score">{{ gameView.table?.scores?.[westView.seat] ?? 0 }}</span><span class="gi-riichi-bet" :class="{ on: westView.riichiAccepted }">-1000</span></span></span>
            </div>
            <div v-if="actionAnnouncement.visible" :key="actionAnnouncement.key" :class="['table-callout', `is-${actionAnnouncement.position}`]">
              {{ actionAnnouncement.text }}
            </div>
            <div
              v-if="gameView.table?.resultInfo"
              class="result-overlay"
              @contextmenu.stop.prevent="continueFromResult"
            >
            <div class="result-overlay-card">
              <div class="result-overlay-header">
                <h3>{{ localizedResultTitle(gameView.table.resultInfo.title) }}</h3>
                <div v-if="resultHasHora" class="result-overlay-indicators">
                  <div class="result-indicator-group">
                    <span class="result-indicator-tiles">
                      <img
                        v-for="(tile, index) in resultDoraSlots"
                        :key="`result-dora-${index}`"
                        class="tileImg result-indicator-tile"
                        :src="tileImageSrc(tile)"
                        :alt="tile === '?' ? t('result.unrevealedDora') : t('result.doraIndicator', { tile: tileFaceLabel(tile) })"
                      />
                    </span>
                  </div>
                  <div class="result-indicator-group">
                    <span class="result-indicator-tiles">
                      <img
                        v-for="(tile, index) in resultUraSlots"
                        :key="`result-ura-${index}`"
                        class="tileImg result-indicator-tile"
                        :src="tileImageSrc(tile)"
                        :alt="tile === '?' ? t('result.unrevealedUra') : t('result.uraIndicator', { tile: tileFaceLabel(tile) })"
                      />
                    </span>
                  </div>
                </div>
              </div>
              <div v-if="resultYakuItems.length" class="result-overlay-yaku">
                <span v-for="(yaku, index) in resultYakuItems" :key="`${yaku.name}-${index}`" class="result-yaku-item">
                  <span class="result-yaku-name">{{ yaku.label }}</span>
                  <strong v-if="formatResultYakuValue(yaku)">{{ formatResultYakuValue(yaku) }}</strong>
                </span>
              </div>
              <div v-if="resultHanFuLabel || resultPointsLabel || resultHandLabel" class="result-overlay-hand-value">
                <span v-if="resultHanFuLabel" class="result-hanfu">{{ resultHanFuLabel }}</span>
                <strong v-if="resultPointsLabel" class="result-points">{{ resultPointsLabel }}</strong>
                <span v-if="resultHandLabel" class="result-hand-label">{{ resultHandLabel }}</span>
              </div>
              <div class="result-score-map">
                <div
                  v-for="entry in resultScoreLayout"
                  :key="`result-score-${entry.seat}`"
                  :class="['result-score-card', `is-${entry.position}`]"
                  role="group"
                  :aria-label="t('result.scoreAria', { player: entry.label, rank: entry.rank, before: entry.before, delta: formatDelta(entry.delta), after: entry.after })"
                >
                  <span class="result-score-heading">
                    <strong class="result-score-seat">{{ entry.label }}</strong>
                    <span class="result-score-rank">{{ entry.rank }}</span>
                  </span>
                  <strong v-if="resultIsMatchEnd" class="result-final-score">{{ entry.after }}</strong>
                  <span v-else class="result-score-values">
                    <span>{{ entry.before }}</span>
                    <span :class="{ positive: entry.delta > 0, negative: entry.delta < 0 }">{{ entry.delta === 0 ? '' : formatDelta(entry.delta) }}</span>
                    <strong>{{ entry.after }}</strong>
                  </span>
                </div>
              </div>
              <button v-if="!resultIsMatchEnd" class="result-dismiss-btn" @click="advanceGame" :aria-disabled="isReadOnlyRecord || status.mode !== 'play'">
                {{ isReadOnlyRecord ? t('common.readOnly') : t('common.continue') }}
              </button>
              <button v-else class="result-dismiss-btn" @click="showRoundMapInResearchMode">
                {{ t('roundMap.title') }}
              </button>
            </div>
          </div>
        </div>
        </div>
      </section>

      <section
        v-if="showAnalysisDock"
        class="panel dock-module analysis-dock"
        :class="{
          'reset-without-motion': suppressOpponentAnalysisTransitions,
          'is-dragging': draggingDockPanel === 'analysis',
        }"
        :style="[
          { '--floating-panel-scale': uiScale, order: workspaceItemOrder('analysis') },
          colorSchemeCssVariables,
        ]"
        :aria-label="t('analysis.title')"
      >
        <div class="dock-module-header analysis-dock-header">
          <div
            class="dock-module-drag-handle"
            :title="t('workspace.dragPanel', { panel: t('analysis.title') })"
            @pointerdown="startDockPanelPointerDrag('analysis', $event)"
          >
            <h2>{{ t('analysis.title') }}</h2>
          </div>
          <button
            v-if="hasOpponentGroundTruth"
            class="analysis-dock-mode"
            @click="shantenViewMode = shantenViewMode === 'predictions' ? 'ground_truth' : 'predictions'"
          >
            {{ shantenViewMode === 'predictions' ? t('analysis.predictions') : t('analysis.groundTruth') }}
          </button>
        </div>
        <div class="analysis-dock-body">
          <p v-if="opponentAnalysisIsLoading" class="shanten-panel-state">{{ t('common.loading') }}</p>
          <template v-else>
            <p v-if="opponentAnalysisLoadError" class="shanten-panel-state is-error">{{ opponentAnalysisLoadError }}</p>
            <AnalysisPanel
              v-else
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
            />
          </template>
        </div>
      </section>

      <aside
        v-if="showConsoleDock"
        class="panel dock-module side-panel console-dock"
        :class="{ 'is-dragging': draggingDockPanel === 'console' }"
        :style="{ order: workspaceItemOrder('console') }"
      >
        <div class="dock-module-header panel-header">
          <div
            class="dock-module-drag-handle"
            :title="t('workspace.dragPanel', { panel: t('console.title') })"
            @pointerdown="startDockPanelPointerDrag('console', $event)"
          >
            <h2>{{ t('console.title') }}</h2>
          </div>
        </div>
        <div class="console-dock-body">
        <div v-if="status.mode === 'research'" class="settings-preview auto-analysis-panel">
          <div class="auto-analysis-row">
            <button
              class="auto-analysis-button"
              :class="{ running: autoAnalysisRunning }"
              :disabled="!status.gameLoaded || autoAnalysisRequestInFlight"
              @click="toggleAutoAnalysis"
            >
              {{ autoAnalysisRunning ? t('console.stop') : t('console.autoAnalysis') }}
            </button>
            <div
              class="auto-analysis-progress"
              role="progressbar"
              :aria-valuemin="0"
              :aria-valuemax="100"
              :aria-valuenow="autoAnalysisPercent"
              :aria-label="autoAnalysisLabel"
            >
              <canvas ref="autoAnalysisCanvasEl" class="auto-analysis-progress-canvas" aria-hidden="true"></canvas>
              <small>{{ autoAnalysisLabel }}</small>
            </div>
          </div>
        </div>
        <div class="settings-preview quick-training-panel" :class="{ collapsed: quickSettingsCollapsed }">
          <button class="panel-section-toggle" @click="quickSettingsCollapsed = !quickSettingsCollapsed">
            <h3>{{ t('console.options') }}</h3>
            <span>{{ quickSettingsCollapsed ? t('console.expand') : t('console.collapse') }}</span>
          </button>
          <div v-if="!quickSettingsCollapsed" class="quick-training-content">
            <div class="quick-audio-block quick-time-block">
              <div class="quick-time-header">
                <span>{{ t('console.volume') }}</span>
                <strong>{{ quickAudioVolumeLabel }}</strong>
              </div>
              <div class="quick-time-slider-wrap">
                <div class="quick-time-track">
                  <span class="quick-time-track-bg"></span>
                  <span class="quick-time-track-fill" :style="{ width: `${quickAudioVolumePercent}%` }"></span>
                  <span class="quick-time-thumb" :style="{ left: `${quickAudioVolumePercent}%` }"></span>
                </div>
                <input
                  class="quick-time-range"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  :value="quickAudioVolumeValue"
                  @input="onQuickAudioVolumeInput"
                  @change="commitQuickAudioVolume"
                />
              </div>
            </div>
            <div v-if="status.mode === 'research'" class="quick-seat-block">
              <span class="seat-switch-label">{{ t('console.switchSeat') }}</span>
              <div class="seat-buttons seat-buttons-compact">
                <button
                  v-for="option in relativeSeatOptions"
                  :key="option.label"
                  :disabled="!status.gameLoaded || seatSwitchInFlight || status.controlledSeat === option.seat"
                  :class="{
                    active: status.controlledSeat === option.seat,
                    'is-pending': seatSwitchInFlight && pendingSeatSwitchLabel === option.label,
                  }"
                  @click="switchSeat(option.seat, option.label)"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
            <div v-if="status.mode === 'play'" class="quick-subsection">
              <span class="quick-subsection-label">{{ t('console.reviewMode') }}</span>
            <div class="quick-training-mode-row">
              <button
                v-for="option in quickTrainingModes"
                :key="option.value"
                class="quick-mode-btn"
                :class="{ active: currentTrainingMode === option.value }"
                @click="setQuickTrainingMode(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
            </div>
            <div v-if="status.mode === 'play'" class="quick-time-block">
              <div class="quick-time-header">
                <span>{{ t('console.thinkingDelay') }}</span>
                <strong>{{ quickMaxThinkingLabel }}</strong>
              </div>
              <div class="quick-time-slider-wrap">
                <div class="quick-time-track">
                  <span class="quick-time-track-bg"></span>
                  <span class="quick-time-track-fill" :style="{ width: `${quickMaxThinkingPercent}%` }"></span>
                  <span class="quick-time-marker quick-time-marker-min" :style="{ left: `${quickMinThinkingPercent}%` }" :title="t('console.minimumThinkingTime')"></span>
                  <span class="quick-time-marker quick-time-marker-auto" :style="{ left: `${quickAutoAdvancePercent}%` }" :title="t('console.autoAdvanceUnit')"></span>
                  <span class="quick-time-thumb" :style="{ left: `${quickMaxThinkingPercent}%` }"></span>
                </div>
                <input
                  class="quick-time-range"
                  type="range"
                  min="0"
                  max="4"
                  step="0.05"
                  :value="quickThinkingMaxValue"
                  @input="onQuickThinkingTimeInput"
                  @change="commitQuickThinkingTime"
                />
              </div>
              <div class="quick-time-legend">
                <span>{{ t('console.minimumShort', { value: quickMinThinkingLabel }) }}</span>
                <span>{{ t('console.advanceShort', { value: quickAutoAdvanceLabel }) }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="settings-preview settings-preview-tree" :class="{ collapsed: treePanelCollapsed }">
          <button class="panel-section-toggle" @click="treePanelCollapsed = !treePanelCollapsed">
            <h3>{{ t('tree.title') }}</h3>
            <span>{{ treePanelCollapsed ? t('console.expand') : t('console.collapse') }}</span>
          </button>
          <template v-if="!treePanelCollapsed">
            <div class="tree-actions">
              <button @click="setCurrentNodeAsMainBranch" :disabled="!canSetCurrentNodeAsMainBranch || nodeMutationRequestInFlight">{{ t('tree.setMain') }}</button>
              <button
                class="tree-delete-button"
                :class="{ 'confirm-delete': deleteNodeConfirmationPending }"
                :disabled="!canDeleteCurrentNode || nodeMutationRequestInFlight"
                @click="deleteCurrentNode"
              >
                {{ deleteNodeConfirmationPending ? t('common.confirmDelete') : t('tree.deleteNode') }}
              </button>
              <button :disabled="!gameView.currentNodeId" @click="openCustomTenhouExport">{{ t('common.export') }}</button>
            </div>
            <div
              v-if="treeDots.length"
              ref="treeScrollEl"
              class="tree-scroll tree-scroll-svg"
              @pointerenter="suspendTreeAutoFollow"
              @pointerleave="resumeTreeAutoFollow"
              @scroll="onTreeScroll"
            >
              <div class="tree-canvas" :style="treeCanvasStyle">
                <div class="tree-axis" :style="{ height: `${treeSvgH}px` }">
                  <span class="tree-axis-sizer" aria-hidden="true">
                    <span v-for="label in treeRowActionLabels" :key="label">{{ label }}</span>
                  </span>
                  <button
                    v-for="row in visibleTreeRows"
                    :key="row.depth"
                    type="button"
                    class="tree-axis-label"
                    :class="{ 'is-controlled': row.isControlledAction }"
                    :style="{ top: `${row.y}px` }"
                    :title="row.label"
                    @click="jumpToNode(row.nodeId)"
                  >
                    {{ row.label }}
                  </button>
                </div>
                <svg class="tree-svg" :width="treeSvgW" :height="treeSvgH">
                  <line
                    :x1="treeBaseX"
                    y1="0"
                    :x2="treeBaseX"
                    :y2="treeSvgH"
                    stroke="rgba(159,213,200,0.22)"
                    stroke-width="1"
                  />
                  <path
                    v-for="edge in visibleTreeEdges"
                    :key="`${edge.from}-${edge.to}`"
                    :d="edge.d"
                    fill="none"
                    :stroke="treeEdgeStroke(edge)"
                    :stroke-width="treeEdgeWidth(edge)"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <rect
                    v-for="region in visibleTreeHitRegions"
                    :key="`tree-hit-${region.dot.id}`"
                    :x="region.x"
                    :y="region.y"
                    :width="region.width"
                    :height="region.height"
                    class="tree-hit-region"
                    @mouseenter="treeHoveredNodeId = region.dot.id"
                    @mouseleave="treeHoveredNodeId = null"
                    @click="jumpToNode(region.dot.id)"
                  />
                  <template v-for="dot in visibleTreeDots" :key="dot.id">
                    <rect
                      v-if="dot.shape === 'square'"
                      :x="dot.x - treeSquareRadius(dot)"
                      :y="dot.y - treeSquareRadius(dot)"
                      :width="treeSquareRadius(dot) * 2"
                      :height="treeSquareRadius(dot) * 2"
                      :rx="treeSquareCornerRadius"
                      :ry="treeSquareCornerRadius"
                      :class="['tree-dot', 'is-square', isCurrentTreeDot(dot) ? 'is-current' : '', dot.isMainline ? 'is-mainline' : '', treeHoveredNodeId === dot.id ? 'is-hovered' : '']"
                      :fill="dot.fill"
                      :stroke="isCurrentTreeDot(dot) ? 'white' : (dot.isMainline ? 'rgba(220,244,240,0.45)' : 'none')"
                      :stroke-width="treeDotStrokeWidth(dot)"
                    />
                    <circle
                      v-else
                      :cx="dot.x"
                      :cy="dot.y"
                      :r="treeDotRadius(dot)"
                      :class="['tree-dot', isCurrentTreeDot(dot) ? 'is-current' : '', dot.isMainline ? 'is-mainline' : '', treeHoveredNodeId === dot.id ? 'is-hovered' : '']"
                      :fill="dot.fill"
                      :stroke="isCurrentTreeDot(dot) ? 'white' : (dot.isMainline ? 'rgba(220,244,240,0.45)' : 'none')"
                      :stroke-width="treeDotStrokeWidth(dot)"
                    />
                  </template>
                </svg>
              </div>
            </div>
            <p v-else class="empty-copy">—</p>
            <textarea
              v-if="gameView.currentNodeId"
              ref="nodeCommentEl"
              v-model="nodeCommentDraft"
              class="node-comment"
              rows="1"
              maxlength="20000"
              :placeholder="t('tree.commentPlaceholder')"
              :aria-label="t('tree.currentComment')"
              @input="onNodeCommentInput"
              @blur="flushNodeCommentInBackground"
            />
          </template>
        </div>


        <div class="settings-preview" :class="{ collapsed: analysisPanelCollapsed }">
          <button class="panel-section-toggle" @click="analysisPanelCollapsed = !analysisPanelCollapsed">
            <h3>{{ t('evaluation.title') }}</h3>
            <span>{{ analysisPanelCollapsed ? t('console.expand') : t('console.collapse') }}</span>
          </button>
          <template v-if="!analysisPanelCollapsed">
            <p v-if="!effectiveDecisionRecommendationsEnabled" class="empty-copy">{{ t('evaluation.hidden') }}</p>
            <p v-else-if="!showTrainingRecommendations" class="empty-copy">—</p>
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
                      :title="localizedEngineText(metric.description, '')"
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
                      :title="localizedEngineText(metric.description, '')"
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
        </div>
      </aside>

      <div
        v-if="draggingDockPanel"
        class="dock-drop-overlay"
        :style="{ gridTemplateColumns: `repeat(${dockDropZones.length}, minmax(0, 1fr))` }"
      >
        <div
          v-for="zone in dockDropZones"
          :key="zone.position"
          class="dock-drop-zone"
          :class="{ active: activeDockDropPosition === zone.position }"
        >
          <span>{{ t(zone.labelKey) }}</span>
        </div>
      </div>
    </main>

    <footer class="footer">
      <div class="footer-model-status">
        <span class="footer-model-dots">
          <span
            v-for="item in engineStatusItems"
            :key="item.id"
            class="footer-model-dot"
            :class="{ active: item.state === 'running', loading: item.state === 'loading', error: item.state === 'error' }"
            :aria-label="item.label"
            role="img"
            tabindex="0"
            @mouseenter="hoveredModelStatusId = item.id"
            @mouseleave="hoveredModelStatusId = null"
            @focus="hoveredModelStatusId = item.id"
            @blur="hoveredModelStatusId = null"
          />
        </span>
        <span class="footer-model-label">{{ hoveredModelStatusLabel }}</span>
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
        <div id="runtime-memory-detail" class="footer-memory-tooltip" role="tooltip">
          <div v-for="row in runtimeMemoryRows" :key="row.label" class="footer-memory-tooltip-row">
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

    <div v-if="showSettingsPanel" class="settings-modal-backdrop">
      <section class="settings-modal">
        <div class="settings-modal-header">
          <h2>{{ t('settings.title') }}</h2>
          <div class="settings-modal-actions">
            <button class="settings-btn-secondary" @click="closeSettingsPanel">{{ t('common.close') }}</button>
            <button class="settings-btn-primary" @click="saveSettingsPanel">{{ t('settings.save') }}</button>
          </div>
        </div>
        <div class="settings-subsection">
          <h3>{{ t('settings.interface') }}</h3>
          <label>
            <span>{{ t('settings.language') }}</span>
            <select v-model="settingsDraft.display.language">
              <option value="system">{{ t('settings.language.system') }}</option>
              <option value="zh-CN">{{ t('settings.language.zh-CN') }}</option>
              <option value="ja-JP">{{ t('settings.language.ja-JP') }}</option>
              <option value="en-US">{{ t('settings.language.en-US') }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('settings.textSize') }}</span>
            <select v-model.number="settingsDraft.display.uiScale">
              <option v-for="scale in uiScaleOptions" :key="scale" :value="scale">{{ Math.round(scale * 100) }}%</option>
            </select>
          </label>
          <label>
            <span>{{ t('settings.colorScheme') }}</span>
            <select v-model="settingsDraft.display.colorScheme">
              <option value="default">{{ t('common.default') }}</option>
              <option value="killerducky">killerducky</option>
            </select>
          </label>
          <label>
            <span>{{ t('settings.tablePosition') }}</span>
            <select v-model="settingsDraft.display.tablePosition">
              <option value="center">{{ t('settings.tablePosition.center') }}</option>
              <option value="left">{{ t('settings.tablePosition.left') }}</option>
              <option value="right">{{ t('settings.tablePosition.right') }}</option>
            </select>
          </label>
          <label class="settings-checkbox">
            <input v-model="settingsDraft.display.reduceMotion" type="checkbox" />
            <span class="settings-checkbox-control" aria-hidden="true"></span>
            <span class="settings-checkbox-label">{{ t('settings.reduceMotion') }}</span>
          </label>
          <label class="settings-checkbox">
            <input v-model="settingsDraft.display.showTsumogiriInPlay" type="checkbox" />
            <span class="settings-checkbox-control" aria-hidden="true"></span>
            <span class="settings-checkbox-label">{{ t('settings.showTsumogiri') }}</span>
          </label>
        </div>
        <div class="settings-subsection">
          <h3>{{ t('settings.sound') }}</h3>
          <label>
            <span>{{ t('settings.soundPack') }}</span>
            <select v-model="settingsDraft.audio.soundPackId">
              <option value="">{{ t('common.none') }}</option>
              <option v-for="pack in settings.runtime?.soundPackCatalog.packs || []" :key="pack.id" :value="pack.id">
                {{ pack.name }}
              </option>
            </select>
          </label>
        </div>
        <div class="settings-subsection">
          <h3>{{ t('settings.game') }}</h3>
          <label>
            <span>{{ t('settings.mistakeThreshold') }}</span>
            <input v-model.number="mistakeThresholdDisplay" type="number" min="0" max="100" step="1" />
          </label>
        </div>
        <div class="settings-subsection">
          <h3>{{ t('settings.records') }}</h3>
          <label class="settings-checkbox settings-checkbox-with-description">
            <input v-model="settingsDraft.records.saveRecoveryOnExit" type="checkbox" />
            <span class="settings-checkbox-control" aria-hidden="true"></span>
            <span class="settings-checkbox-copy">
              <span class="settings-checkbox-label">{{ t('settings.keepRecovery') }}</span>
              <span class="settings-checkbox-description">{{ t('settings.keepRecovery.description') }}</span>
            </span>
          </label>
        </div>
      </section>
    </div>

    <section
      v-if="roundMapOverlayOpen"
      class="analysis-float-panel round-map-window"
      :style="{ '--floating-panel-scale': uiScale, zIndex: floatingPanelZ.roundMap }"
      @mousedown="focusFloatingPanel('roundMap')"
      @focusin="focusFloatingPanel('roundMap')"
    >
      <div class="floating-panel-header" @mousedown="startDragFloatingPanel">
        <span>{{ t('roundMap.title') }}</span>
        <div class="floating-panel-header-actions">
          <button class="floating-panel-close" :aria-label="t('roundMap.close')" @click="closeRoundMapOverlay">&times;</button>
        </div>
      </div>
      <div class="round-map-panel-body">
        <div class="round-map-body">
          <div v-if="roundMapDots.length" class="round-map-scroll" @wheel.stop>
            <div class="round-map-canvas">
              <div v-if="roundMapRows.length" class="round-map-axis" :style="{ height: `${roundMapSvgH}px` }">
                <div
                  v-for="row in roundMapRows"
                  :key="row.key"
                  class="round-map-axis-label"
                  :style="{ top: `${row.y}px` }"
                >
                  {{ row.label }}
                </div>
              </div>
              <svg class="round-map-svg" :width="roundMapSvgW" :height="roundMapSvgH">
                <line
                  :x1="ROUND_BASE_X.value"
                  y1="0"
                  :x2="ROUND_BASE_X.value"
                  :y2="roundMapSvgH"
                  stroke="rgba(159,213,200,0.18)"
                  stroke-width="1"
                />
                <path
                  v-for="edge in roundMapEdges"
                  :key="`${edge.from}-${edge.to}`"
                  :d="edge.d"
                  fill="none"
                  :stroke="edge.stroke"
                  :stroke-width="edge.width"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
                <rect
                  v-for="region in roundMapHitRegions"
                  :key="`round-map-hit-${region.dot.id}`"
                  :x="region.x"
                  :y="region.y"
                  :width="region.width"
                  :height="region.height"
                  class="round-map-hit-region"
                  @mouseenter="roundMapHoveredRoundId = region.dot.id"
                  @mouseleave="roundMapHoveredRoundId = null"
                  @click="jumpToRoundRoot(region.dot.id)"
                />
                <circle
                  v-for="dot in roundMapDots"
                  :key="dot.id"
                  :cx="dot.x"
                  :cy="dot.y"
                  :r="roundMapDotRadius(dot)"
                  :class="['round-map-dot', dot.isCurrent ? 'is-current' : '', dot.isMainline ? 'is-mainline' : '', roundMapHoveredRoundId === dot.id ? 'is-hovered' : '']"
                  :fill="dot.fill"
                  :stroke="dot.isCurrent ? 'white' : (dot.isMainline ? 'rgba(220,244,240,0.4)' : 'none')"
                  :stroke-width="roundMapDotStrokeWidth(dot)"
                />
              </svg>
            </div>
          </div>
          <p v-else class="empty-copy">—</p>
        </div>
        <div class="round-map-settlement">
          <div class="round-map-settlement-heading">
            <span>{{ roundMapSettlementRoundLabel }}</span>
            <strong>{{ roundMapSettlementTitle }}</strong>
          </div>
          <div class="result-score-map round-map-score-map">
            <div
              v-for="entry in roundMapSettlementLayout"
              :key="`round-map-score-${entry.seat}`"
              :class="['result-score-card', `is-${entry.position}`, { 'is-empty': !entry.hasScores }]"
              role="group"
              :aria-label="entry.showDelta ? t('result.scoreAria', { player: entry.label, rank: entry.rank, before: entry.before, delta: formatDelta(entry.delta), after: entry.after }) : (entry.hasScores ? t('result.scoreOnlyAria', { player: entry.label, score: entry.after }) : entry.label)"
            >
              <span class="result-score-heading">
                <strong class="result-score-seat">{{ entry.label }}</strong>
                <span v-if="entry.rank !== null" class="result-score-rank">{{ entry.rank }}</span>
              </span>
              <span v-if="entry.showDelta" class="result-score-values">
                <span>{{ entry.before }}</span>
                <span :class="{ positive: entry.delta > 0, negative: entry.delta < 0 }">{{ entry.delta === 0 ? '' : formatDelta(entry.delta) }}</span>
                <strong>{{ entry.after }}</strong>
              </span>
              <strong v-else-if="entry.hasScores" class="round-map-score-current">{{ entry.after }}</strong>
              <span v-else class="round-map-score-empty">—</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section
      v-if="showWallView"
      class="analysis-float-panel wall-window"
      :style="{ '--floating-panel-scale': uiScale, zIndex: floatingPanelZ.wall }"
      @mousedown="focusFloatingPanel('wall')"
      @focusin="focusFloatingPanel('wall')"
    >
      <div class="floating-panel-header" @mousedown="startDragFloatingPanel">
        <span>{{ t('wall.title') }}</span>
        <div class="floating-panel-header-actions">
          <button v-if="wallViewComplete" class="floating-panel-action" @click="copyWallToClipboard" :disabled="!wallTiles.length">{{ t('common.copy') }}</button>
          <button v-if="wallViewComplete && !isReadOnlyRecord" class="floating-panel-action" @click="importWallFromClipboard">{{ t('common.import') }}</button>
          <button class="floating-panel-close" :aria-label="t('wall.close')" @click="showWallView = false">&times;</button>
        </div>
      </div>
      <p v-if="wallClipboardMessage" class="wall-clipboard-message">{{ wallClipboardMessage }}</p>
      <p v-if="wallLoading" class="wall-loading-state" role="status">{{ t('wall.loading') }}</p>
      <template v-else>
        <div v-if="wallOrigin !== 'generated' || wallSeed !== null || wallSourceUrl" class="wall-metadata">
          <p v-if="wallOrigin !== 'generated'">
            <span>{{ t('wall.source') }}</span><strong>{{ wallOrigin === 'reconstructed' ? t('wall.source.reconstructed') : t('wall.source.imported') }}</strong>
          </p>
          <p v-if="wallSeed !== null"><span>{{ t('wall.seed') }}</span><code>{{ wallSeed }}</code></p>
          <p v-if="wallSourceUrl"><span>{{ t('wall.importUrl') }}</span><code>{{ wallSourceUrl }}</code></p>
        </div>
        <div v-if="wallCanReconstruct && !wallViewComplete" class="wall-reconstruction">
          <button class="floating-panel-action" :disabled="wallReconstructing" @click="reconstructImportedWalls">
            {{ wallReconstructing ? t('wall.reconstructing') : t('wall.reconstruct') }}
          </button>
          <p>{{ t('wall.reconstruct.description') }}</p>
          <label>
            <span>{{ t('wall.seedOptional') }}</span>
            <input v-model.trim="wallReconstructionSeed" type="text" inputmode="numeric" :placeholder="t('wall.seedPlaceholder')" />
          </label>
        </div>
      </template>
      <div v-if="!wallLoading && wallViewComplete" class="wall-grid">
        <div v-for="(row, ri) in wallTileRows" :key="'wr-'+ri" class="wall-row">
          <div v-for="(group, gi) in row" :key="'wg-'+gi" class="wall-group">
            <div
              v-for="tile in group"
              :key="tile.index"
              class="wall-tile"
              :class="'wall-' + tile.status"
            >
              <img
                :src="tileImageSrc(tile.tile)"
                :class="[
                  'tileImg',
                  'wall-tile-img',
                  {
                    tsumogiri: tile.status === 'drawn' || tile.status === 'rinshan_drawn',
                    'river-claimed': ['dealt', 'kan_consumed', 'dora_unrevealed', 'ura_unrevealed'].includes(tile.status),
                  },
                ]"
                :alt="tileFaceLabel(tile.tile)"
              />
              <span class="wall-tile-idx">{{ tile.index + 1 }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <CustomTenhouExportPanel
      v-if="showCustomTenhouExport"
      :scale="uiScale"
      :z-index="floatingPanelZ.customExport"
      :refresh-key="customTenhouExportRefreshKey"
      @close="showCustomTenhouExport = false"
      @focus="focusFloatingPanel('customExport')"
      @start-drag="startDragFloatingPanel"
    />

    <section
      v-if="showEngineWindow"
      class="analysis-float-panel engine-window"
      :style="{ '--floating-panel-scale': uiScale, zIndex: floatingPanelZ.engine }"
      @mousedown="focusFloatingPanel('engine')"
      @focusin="focusFloatingPanel('engine')"
    >
      <div class="floating-panel-header" @mousedown="startDragFloatingPanel">
        <span>{{ t('engine.title') }}</span>
        <div class="floating-panel-header-actions">
          <button class="floating-panel-close" :aria-label="t('engine.close')" @click="closeEngineWindow">&times;</button>
        </div>
      </div>
      <div class="engine-manager-body">
        <div class="engine-profile-column">
          <div class="engine-output-filters" :aria-label="t('engine.filterByOutput')">
            <button
              v-for="output in SUPPORTED_ENGINE_OUTPUTS"
              :key="output.id"
              class="engine-output-filter"
              :class="{
                assigned: Boolean(settingsDraft.engines.outputAssignments[output.id]),
                loaded: engineOutputAssignmentIsLoaded(output.id),
                loading: engineOutputAssignmentIsLoading(output.id),
                error: engineOutputAssignmentHasError(output.id),
                selected: engineOutputFilter === output.id,
              }"
              :aria-pressed="engineOutputFilter === output.id"
              @click="toggleEngineOutputFilter(output.id)"
            >
              {{ output.label }}
            </button>
          </div>
          <div
            v-for="profile in filteredEngineProfiles"
            :key="profile.id"
            class="engine-profile-item"
            :class="engineProfileClasses(profile)"
            @click="selectEngineProfile(profile.id)"
          >
            <span>{{ profile.name || t('common.unnamedEngine') }}</span>
            <small>{{ engineProfileSubtitle(profile) }}</small>
            <button
              v-if="shouldShowEngineActionButton(profile)"
              class="engine-load-button"
              :class="{ unload: profileIsLoaded(profile) }"
              :disabled="Boolean(loadingEngineProfileId || unloadingEngineProfileId)"
              @click.stop="handleEngineProfileAction(profile)"
            >
              {{ profileIsLoaded(profile) ? t('engine.unload') : t('engine.load') }}
            </button>
          </div>
          <div class="engine-list-actions">
            <button @click="moveEngineProfile(-1)" :disabled="activeEngineProfileIndex <= 0">{{ t('engine.moveUp') }}</button>
            <button @click="moveEngineProfile(1)" :disabled="activeEngineProfileIndex < 0 || activeEngineProfileIndex >= activeEngineProfiles.length - 1">{{ t('engine.moveDown') }}</button>
            <button @click="duplicateEngineProfile" :disabled="!activeEngineProfile">{{ t('engine.duplicate') }}</button>
            <button
              :class="{ danger: deleteEngineConfirmationId === activeEngineProfile?.id }"
              @click="deleteEngineProfile"
              :disabled="!activeEngineProfile || activeEngineProfile.builtIn || profileAssignedOutputs(activeEngineProfile).length > 0"
            >
              {{ deleteEngineConfirmationId === activeEngineProfile?.id ? t('common.confirmDelete') : t('common.delete') }}
            </button>
          </div>
          <button class="engine-add-button" @click="addEngineProfile">{{ t('engine.add') }}</button>
        </div>
        <div v-if="activeEngineProfile" class="engine-profile-detail">
          <label>
            <span>{{ t('engine.displayName') }}</span>
            <input
              :value="activeEngineProfile.name"
              :placeholder="suggestedEngineProfileName(activeEngineProfile)"
              :disabled="profileConfigurationLocked(activeEngineProfile)"
              type="text"
              @input="setEngineProfileName"
            />
          </label>
          <div class="engine-weight-field">
            <span>{{ t('engine.executable') }}</span>
            <div>
              <input :value="activeEngineProfile.enginePath" :disabled="profileConfigurationLocked(activeEngineProfile)" readonly type="text" :placeholder="t('engine.selectExecutable')" />
              <button :disabled="profileConfigurationLocked(activeEngineProfile)" @click="chooseEngineFile">{{ t('common.select') }}</button>
            </div>
          </div>
          <div class="engine-weight-field">
            <span>{{ t('engine.output') }}</span>
            <div class="engine-output-options">
              <label
                v-for="output in activeSupportedOutputs"
                :key="output.id"
                class="settings-checkbox engine-output-assignment"
              >
                <input
                  type="checkbox"
                  :checked="settingsDraft.engines.outputAssignments[output.id] === activeEngineProfile.id"
                  :disabled="profileConfigurationLocked(activeEngineProfile)"
                  @change="setEngineOutputAssignment(output.id, $event)"
                />
                <span class="settings-checkbox-control" aria-hidden="true"></span>
                <span class="settings-checkbox-label">{{ output.label }}</span>
              </label>
              <small v-if="activeEngineProfile.enginePath && !activeSupportedOutputs.length && !describingEngineIds.has(engineDescriptionKey(activeEngineProfile))">{{ t('engine.unsupportedOutputs') }}</small>
            </div>
          </div>
          <div
            v-for="slot in activeEngineWeightSlots"
            :key="slot.id"
            class="engine-weight-field"
          >
            <span>{{ localizedEngineText(slot.title, slot.id) }}</span>
            <div>
              <input :value="engineWeight(activeEngineProfile, slot.id)?.path || ''" :disabled="profileConfigurationLocked(activeEngineProfile)" readonly type="text" :placeholder="t('engine.selectWeight')" />
              <button :disabled="!activeEngineProfile.enginePath || profileConfigurationLocked(activeEngineProfile)" @click="chooseEngineWeight(slot.id)">{{ t('common.select') }}</button>
            </div>
          </div>
          <label v-if="activeEngineDevices.length">
            <span>{{ t('engine.runtimeDevice') }}</span>
            <select
              :value="activeEngineProfile.device"
              :disabled="profileConfigurationLocked(activeEngineProfile)"
              @change="setEngineDevice"
            >
              <option v-for="device in activeEngineDevices" :key="device.type" :value="device.type">
                {{ localizedEngineText(device.title, device.type) }}
              </option>
            </select>
          </label>
          <div
            v-if="activeCatalogEngine && (activeCatalogEngine.licenses.length || activeCatalogEngine.notices.length)"
            class="engine-legal-field"
          >
            <span>{{ t('engine.licenses') }}</span>
            <div class="engine-legal-actions">
              <button
                v-for="(license, index) in activeCatalogEngine.licenses"
                :key="`license:${index}`"
                :disabled="!license.available"
                @click="openEngineLegalDocument('license', index)"
              >
                {{ license.name }}
              </button>
              <button
                v-for="(notice, index) in activeCatalogEngine.notices"
                :key="`notice:${index}`"
                :disabled="!notice.available"
                @click="openEngineLegalDocument('notice', index)"
              >
                {{ notice.name }}
              </button>
              <button
                v-if="activeCatalogEngine.sourceUrl"
                @click="openExternalLink(activeCatalogEngine.sourceUrl)"
              >
                {{ t('engine.viewSource') }}
              </button>
            </div>
          </div>
          <p
            v-if="activeEngineProfile.enginePath && describingEngineIds.has(engineDescriptionKey(activeEngineProfile))"
            class="engine-inline-status"
          >
            {{ t('engine.readingOptions') }}
          </p>
          <label v-for="option in activeEngineOptionEntries" :key="option.key">
            <span>{{ option.label }}</span>
            <select
              v-if="option.enumValues"
              :value="activeEngineProfile.options[option.key] ?? ''"
              :disabled="profileConfigurationLocked(activeEngineProfile)"
              @change="setEngineOptionFromEvent(option, $event)"
            >
              <option value="">{{ t('engine.defaultOption', { value: formatEngineOptionDefault(option.defaultValue) }) }}</option>
              <option v-for="value in option.enumValues" :key="String(value)" :value="value">
                {{ value }}
              </option>
            </select>
            <select
              v-else-if="option.type === 'boolean'"
              :value="activeEngineProfile.options[option.key] === undefined ? '' : String(activeEngineProfile.options[option.key])"
              :disabled="profileConfigurationLocked(activeEngineProfile)"
              @change="setEngineOptionFromEvent(option, $event)"
            >
              <option value="">{{ t('engine.defaultOption', { value: formatEngineOptionDefault(option.defaultValue) }) }}</option>
              <option value="true">{{ t('common.yes') }}</option>
              <option value="false">{{ t('common.no') }}</option>
            </select>
            <input
              v-else
              :value="activeEngineProfile.options[option.key] ?? ''"
              :placeholder="String(option.defaultValue ?? '')"
              :inputmode="engineOptionInputMode(option)"
              :disabled="profileConfigurationLocked(activeEngineProfile)"
              type="text"
              @change="setEngineOptionFromEvent(option, $event)"
            />
          </label>
          <p v-if="engineDescribeErrors[engineDescriptionKey(activeEngineProfile)]" class="engine-diagnostic">
            {{ t('engine.optionsFailed', { message: engineDescribeErrors[engineDescriptionKey(activeEngineProfile)] }) }}
          </p>
          <p v-if="engineCatalogDiagnostics.length" class="engine-diagnostic">
            {{ t('engine.packageDiagnostic', { message: engineCatalogDiagnostics[0].message }) }}
          </p>
        </div>
      </div>
      <p class="engine-save-message">{{ engineFooterMessage }}</p>
    </section>

    <div v-if="showMjaiDebug" class="settings-modal-backdrop" @click.self="showMjaiDebug = false">
      <section class="wall-view-panel mjai-debug-panel">
        <div class="settings-modal-header">
          <h2>{{ t('debug.title') }}</h2>
          <div class="settings-modal-actions">
            <button
              class="settings-btn-secondary"
              :disabled="!status.gameLoaded || clearingAnalysisCaches"
              @click="clearLoadedAnalysisCaches"
            >
              {{ clearingAnalysisCaches ? t('debug.clearingCache') : t('debug.clearCache') }}
            </button>
            <button class="settings-btn-secondary" @click="showMjaiDebug = false">{{ t('debug.close') }}</button>
          </div>
        </div>
        <p v-if="analysisCacheClearMessage" class="mjai-cache-clear-message">{{ analysisCacheClearMessage }}</p>
        <div class="mjai-debug-info">
          <span v-if="mjaiDebugData.caller">{{ t('debug.caller', { value: String(mjaiDebugData.caller) }) }}</span>
          <span v-if="mjaiDebugData.seat != null">{{ t('debug.seat', { value: String(mjaiDebugData.seat) }) }}</span>
          <span v-if="mjaiDebugData.phase">{{ t('debug.phase', { value: String(mjaiDebugData.phase) }) }}</span>
          <span v-if="mjaiDebugData.eventCount != null">{{ t('debug.eventCount', { value: String(mjaiDebugData.eventCount) }) }}</span>
          <span v-if="mjaiDebugData.responseType">{{ t('debug.response', { value: String(mjaiDebugData.responseType) }) }}</span>
        </div>
        <pre class="mjai-debug-pre">{{ mjaiDebugJson }}</pre>
        <div class="mjai-debug-section-label">{{ t('debug.shantenModel') }}</div>
        <pre class="mjai-debug-pre">{{ shantenMjaiJson }}</pre>
        <div class="mjai-debug-status">{{ shantenStatus }}</div>
        <pre class="mjai-debug-pre" v-if="shantenRawData.kamicha">{{ shantenRawJson }}</pre>
      </section>
    </div>

    <AboutDialog v-if="showAboutPanel" @close="showAboutPanel = false" />
  </div>

</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, watchEffect } from 'vue'
import AnalysisPanel from './components/AnalysisPanel.vue'
import AboutDialog from './components/AboutDialog.vue'
import CustomTenhouExportPanel from './components/CustomTenhouExportPanel.vue'
import RecordImportDialog from './components/RecordImportDialog.vue'
import { normalizeLanguagePreference, setLanguagePreference, useI18n } from './i18n'
import { buildTableActionNodeIndex } from './tableHistoryNavigation'
import { getUiMotionDurationMs, getUiMotionEasing } from './uiMotion'

const { locale, numberLocale, t } = useI18n()

const seats = [0, 1, 2, 3]
type ColorSchemeId = TrainerSettings['display']['colorScheme']
type TablePosition = TrainerSettings['display']['tablePosition']
type WorkspaceItemId = TrainerSettings['display']['workspaceLayout']['order'][number]
type DockPanelId = Exclude<WorkspaceItemId, 'table'>
type DockDropPosition = 0 | 1 | 2

const DEFAULT_WORKSPACE_ORDER: WorkspaceItemId[] = ['table', 'analysis', 'console']

const DEFAULT_SHANTEN_COLORS = [
  '#4CAF50',
  '#2B8CBE',
  '#1476B0',
  '#0868AC',
  '#08589E',
  '#084081',
  '#062B5C',
  '#4E6263',
]
const COLOR_SCHEMES: Record<ColorSchemeId, {
  decisionRecommendation: string
  ronWait: { kamicha: string; toimen: string; shimocha: string }
  shanten: string[]
}> = {
  default: {
    decisionRecommendation: '#1a931a',
    ronWait: { kamicha: '#2196F3', toimen: '#FF9800', shimocha: '#4CAF50' },
    shanten: DEFAULT_SHANTEN_COLORS,
  },
  killerducky: {
    decisionRecommendation: '#1a931a',
    ronWait: { kamicha: '#b34d4d', toimen: '#4db3b3', shimocha: '#804db3' },
    shanten: DEFAULT_SHANTEN_COLORS,
  },
}

function normalizeColorScheme(value: unknown): ColorSchemeId {
  return value === 'killerducky' ? 'killerducky' : 'default'
}

function normalizeTablePosition(value: unknown): TablePosition {
  return value === 'left' || value === 'right' ? value : 'center'
}

function normalizeWorkspaceOrder(value: unknown): WorkspaceItemId[] {
  const validItems: WorkspaceItemId[] = ['analysis', 'table', 'console']
  const requested = Array.isArray(value) ? value : []
  const order = requested.filter((item): item is WorkspaceItemId => (
    typeof item === 'string' && validItems.includes(item as WorkspaceItemId)
  )).filter((item, index, items) => items.indexOf(item) === index)
  for (const item of DEFAULT_WORKSPACE_ORDER) {
    if (!order.includes(item)) order.push(item)
  }
  return order
}

function normalizeWorkspaceLayout(value: unknown): TrainerSettings['display']['workspaceLayout'] {
  const source = value && typeof value === 'object'
    ? value as Partial<TrainerSettings['display']['workspaceLayout']>
    : {}
  return {
    order: normalizeWorkspaceOrder(source.order),
    analysisVisible: source.analysisVisible === true,
    consoleVisible: source.consoleVisible !== false,
  }
}

const settings = reactive<TrainerSettings>({
  configPath: '',
  runtime: {
    releaseMode: false,
    builtInRuntimeLabel: '',
    builtInModelLabel: '',
    opponentAnalysisInputModes: ['public'],
    engineCatalog: {
      schemaVersion: 2,
      engines: [],
      diagnostics: [],
    },
    soundPackCatalog: {
      schemaVersion: 1,
      packs: [],
      diagnostics: [],
    },
  },
  training: {
    mode: 'threshold_review',
    mistakeThreshold: 0.25,
    thinkingTimeMinS: 0.25,
    thinkingTimeMaxS: 1,
  },
  modeDefaults: {
    autoAdvanceDelayMs: 250,
  },
  display: {
    language: 'system',
    colorScheme: 'default',
    reduceMotion: false,
    uiScale: 1,
    showTsumogiriInPlay: true,
    tablePosition: 'center',
    workspaceLayout: normalizeWorkspaceLayout(null),
  },
  records: {
    saveRecoveryOnExit: true,
  },
  audio: {
    volume: 50,
    soundPackId: '',
  },
  engines: {
    schemaVersion: 2,
    profiles: [],
    loadedProfileIds: [],
    outputAssignments: {
      'action-recommendation': '',
      'opponent-shanten': '',
      'opponent-deal-in-probability': '',
      'opponent-concealed-tile-count': '',
      'wall-tile-count': '',
      'opponent-dora-count': '',
      'opponent-score': '',
      'kyoku-outcome': '',
      'kyoku-score-delta': '',
      'match-placement': '',
      'match-score': '',
    },
  },
})
const reduceMotionEnabled = computed(() => Boolean(settings.display.reduceMotion))
const activeColorScheme = computed(() => COLOR_SCHEMES[normalizeColorScheme(settings.display.colorScheme)])
const colorSchemeCssVariables = computed(() => ({
  '--decision-recommendation-color': activeColorScheme.value.decisionRecommendation,
  '--ron-kamicha-color': activeColorScheme.value.ronWait.kamicha,
  '--ron-toimen-color': activeColorScheme.value.ronWait.toimen,
  '--ron-shimocha-color': activeColorScheme.value.ronWait.shimocha,
}))
const shantenColors = computed(() => activeColorScheme.value.shanten)
const UI_SCALE_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

function normalizeUiScale(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return Math.round(Math.max(0.5, Math.min(2, numeric)) * 100) / 100
}

const uiScale = computed(() => normalizeUiScale(settings.display.uiScale))
const tablePosition = computed(() => normalizeTablePosition(settings.display.tablePosition))

watchEffect(() => {
  document.documentElement.classList.toggle('reduce-motion', reduceMotionEnabled.value)
})

const settingsDraft = reactive<TrainerSettings>(JSON.parse(JSON.stringify(settings)))
const mistakeThresholdDisplay = computed({
  get: () => Math.round(Math.max(0, Math.min(1, settingsDraft.training.mistakeThreshold)) * 100),
  set: (value: number) => {
    const percentage = Number(value)
    if (!Number.isFinite(percentage)) return
    settingsDraft.training.mistakeThreshold = Math.max(0, Math.min(100, percentage)) / 100
  },
})
const uiScaleOptions = computed(() => {
  const values = new Set([...UI_SCALE_STEPS, normalizeUiScale(settingsDraft.display.uiScale)])
  return [...values].sort((a, b) => a - b)
})
const showSettingsPanel = ref(false)
const showEngineWindow = ref(false)
const showAboutPanel = ref(false)
const showRecordImportPanel = ref(false)
const showCustomTenhouExport = ref(false)
const customTenhouExportRefreshKey = ref(0)
const showWallView = ref(false)
const wallTiles = ref<Array<{ index: number; tile: string; status: string }>>([])
const wallLoading = ref(false)
const wallViewComplete = ref(false)
const wallCanReconstruct = ref(false)
const wallSeed = ref<number | null>(null)
const wallOrigin = ref<'generated' | 'imported' | 'reconstructed'>('generated')
const wallSourceUrl = ref('')
const wallReconstructionSeed = ref('')
const wallReconstructing = ref(false)
let wallRefreshGeneration = 0
const showMjaiDebug = ref(false)
const mjaiDebugData = ref<Record<string, unknown>>({})
const mjaiDebugJson = computed(() => JSON.stringify(mjaiDebugData.value, null, 2))
const shantenMjaiData = ref<Record<string, unknown>>({})
const shantenMjaiJson = computed(() => JSON.stringify(shantenMjaiData.value, null, 2))
const clearingAnalysisCaches = ref(false)
const analysisCacheClearMessage = ref('')

watchEffect(() => {
  setLanguagePreference(showSettingsPanel.value
    ? settingsDraft.display.language
    : settings.display.language)
})

// --- 工作区与分析 ---
const workspaceLayout = computed(() => normalizeWorkspaceLayout(settings.display.workspaceLayout))
let workspaceLayoutSaveGeneration = 0

function workspaceItemOrder(item: WorkspaceItemId): number {
  return workspaceLayout.value.order.indexOf(item) + 1
}

function updateWorkspaceLayout(nextLayout: TrainerSettings['display']['workspaceLayout']) {
  const normalized = normalizeWorkspaceLayout(nextLayout)
  settings.display.workspaceLayout = normalized
  if (showSettingsPanel.value) settingsDraft.display.workspaceLayout = JSON.parse(JSON.stringify(normalized))
  void nextTick(() => scheduleTableZoomRecalc())
  const generation = ++workspaceLayoutSaveGeneration
  void window.trainerAPI?.saveSettings({
    display: {
      ...settings.display,
      workspaceLayout: JSON.parse(JSON.stringify(normalized)),
    },
  }).then((saved) => {
    if (generation !== workspaceLayoutSaveGeneration) return
    applySettings(saved)
  }).catch((error) => {
    console.warn('Failed to save workspace layout:', error)
  })
}

const showAnalysisDock = computed({
  get: () => workspaceLayout.value.analysisVisible && Boolean(gameView.table),
  set: (visible: boolean) => updateWorkspaceLayout({
    ...workspaceLayout.value,
    analysisVisible: visible,
  }),
})
const showConsoleDock = computed({
  get: () => workspaceLayout.value.consoleVisible,
  set: (visible: boolean) => updateWorkspaceLayout({
    ...workspaceLayout.value,
    consoleVisible: visible,
  }),
})
const workspaceRoot = ref<HTMLElement | null>(null)
const draggingDockPanel = ref<DockPanelId | null>(null)
const activeDockDropPosition = ref<DockDropPosition | null>(null)
let dockDragPointerId: number | null = null
const dockDropZones = computed<Array<{ position: DockDropPosition; labelKey: string }>>(() => {
  const visiblePanelCount = Number(showAnalysisDock.value) + Number(showConsoleDock.value)
  if (visiblePanelCount < 2) {
    return [
      { position: 0, labelKey: 'workspace.dockLeft' },
      { position: 2, labelKey: 'workspace.dockRight' },
    ]
  }
  return [
    { position: 0, labelKey: 'workspace.dockLeft' },
    { position: 1, labelKey: 'workspace.dockCenter' },
    { position: 2, labelKey: 'workspace.dockRight' },
  ]
})

function dockDropPositionAt(clientX: number): DockDropPosition {
  const bounds = workspaceRoot.value?.getBoundingClientRect()
  if (!bounds || bounds.width <= 0) return 1
  const ratio = Math.max(0, Math.min(0.999, (clientX - bounds.left) / bounds.width))
  const zones = dockDropZones.value
  return zones[Math.floor(ratio * zones.length)]?.position ?? zones[0]?.position ?? 0
}

function handleDockPanelPointerMove(event: PointerEvent) {
  if (event.pointerId !== dockDragPointerId || !draggingDockPanel.value) return
  activeDockDropPosition.value = dockDropPositionAt(event.clientX)
}

function finishDockPanelPointerDrag(event: PointerEvent) {
  if (event.pointerId !== dockDragPointerId) return
  const position = activeDockDropPosition.value
  removeDockPanelPointerListeners()
  if (position !== null) dropDockPanel(position)
  else endDockPanelDrag()
}

function cancelDockPanelPointerDrag(event: PointerEvent) {
  if (event.pointerId !== dockDragPointerId) return
  removeDockPanelPointerListeners()
  endDockPanelDrag()
}

function removeDockPanelPointerListeners() {
  window.removeEventListener('pointermove', handleDockPanelPointerMove)
  window.removeEventListener('pointerup', finishDockPanelPointerDrag)
  window.removeEventListener('pointercancel', cancelDockPanelPointerDrag)
  dockDragPointerId = null
}

function startDockPanelPointerDrag(panel: DockPanelId, event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  dockDragPointerId = event.pointerId
  draggingDockPanel.value = panel
  activeDockDropPosition.value = dockDropPositionAt(event.clientX)
  window.addEventListener('pointermove', handleDockPanelPointerMove)
  window.addEventListener('pointerup', finishDockPanelPointerDrag)
  window.addEventListener('pointercancel', cancelDockPanelPointerDrag)
}

function endDockPanelDrag() {
  draggingDockPanel.value = null
  activeDockDropPosition.value = null
}

function dropDockPanel(position: DockDropPosition) {
  const panel = draggingDockPanel.value
  if (!panel) return
  const order = workspaceLayout.value.order.filter((item) => item !== panel)
  order.splice(position, 0, panel)
  updateWorkspaceLayout({ ...workspaceLayout.value, order })
  endDockPanelDrag()
}

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
  showAnalysisDock.value = !showAnalysisDock.value
}
function toggleConsoleDock() {
  showConsoleDock.value = !showConsoleDock.value
}
type EngineRuntimeKind = 'decision' | 'opponent'
type SupportedEngineOutputId =
  | 'action-recommendation'
  | 'opponent-shanten'
  | 'opponent-deal-in-probability'
  | 'opponent-concealed-tile-count'
  | 'wall-tile-count'
  | 'opponent-dora-count'
  | 'opponent-score'
  | 'kyoku-outcome'
  | 'kyoku-score-delta'
  | 'match-placement'
  | 'match-score'
const SUPPORTED_ENGINE_OUTPUT_DEFINITIONS: Array<{ id: SupportedEngineOutputId; version: number; labelKey: string }> = [
  { id: 'action-recommendation', version: 1, labelKey: 'analysis.output.action' },
  { id: 'opponent-shanten', version: 1, labelKey: 'analysis.output.shanten' },
  { id: 'opponent-deal-in-probability', version: 1, labelKey: 'analysis.output.dealIn' },
  { id: 'opponent-concealed-tile-count', version: 1, labelKey: 'analysis.output.concealedTiles' },
  { id: 'wall-tile-count', version: 1, labelKey: 'analysis.output.wallTiles' },
  { id: 'opponent-dora-count', version: 1, labelKey: 'analysis.output.dora' },
  { id: 'opponent-score', version: 1, labelKey: 'analysis.output.score' },
  { id: 'kyoku-outcome', version: 1, labelKey: 'analysis.output.kyokuOutcome' },
  { id: 'kyoku-score-delta', version: 1, labelKey: 'analysis.output.kyokuDelta' },
  { id: 'match-placement', version: 1, labelKey: 'analysis.output.matchPlacement' },
  { id: 'match-score', version: 1, labelKey: 'analysis.output.matchScore' },
]
const SUPPORTED_ENGINE_OUTPUTS = computed(() => SUPPORTED_ENGINE_OUTPUT_DEFINITIONS.map((output) => ({
  id: output.id,
  version: output.version,
  label: t(output.labelKey),
})))
const OPPONENT_ENGINE_OUTPUT_IDS = SUPPORTED_ENGINE_OUTPUTS
  .value.map((output) => output.id)
  .filter((outputId): outputId is Exclude<SupportedEngineOutputId, 'action-recommendation'> => (
    outputId !== 'action-recommendation'
  ))
const engineSaveMessage = ref('')
const loadingEngineProfileId = ref('')
const unloadingEngineProfileId = ref('')
const deleteEngineConfirmationId = ref('')
const DELETE_CONFIRMATION_TIMEOUT_MS = 3000
let deleteEngineConfirmationTimer: number | null = null
const describingEngineIds = reactive(new Set<string>())
const engineOutputFilter = ref<SupportedEngineOutputId | null>(null)
const editingEngineProfileId = ref('')
const runtimeEngineProfiles = reactive<Record<string, TrainerEngineProfile>>({})
const engineDescriptions = reactive<Record<string, TrainerEngineDescription>>({})
const engineDescribeErrors = reactive<Record<string, string>>({})
const engineLoadErrors = reactive<Record<string, string>>({})
const ENGINE_AUTOSAVE_DELAY_MS = 250
let engineDraftRevision = 0
let engineSavedRevision = 0
let engineAutosaveTimer: number | null = null
let engineAutosavePromise: Promise<boolean> | null = null
let suppressEngineAutosave = false
let engineAutosaveEnabled = false
const activeEngineProfiles = computed(() => settingsDraft.engines.profiles)
const filteredEngineProfiles = computed(() => {
  const outputId = engineOutputFilter.value
  if (!outputId) return activeEngineProfiles.value
  return activeEngineProfiles.value.filter((profile) => engineProfileSupportsOutput(profile, outputId))
})
const activeEngineProfile = computed(() => (
  filteredEngineProfiles.value.find((profile) => profile.id === editingEngineProfileId.value)
  || filteredEngineProfiles.value[0]
  || null
))
const activeEngineProfileIndex = computed(() => (
  activeEngineProfiles.value.findIndex((profile) => profile.id === activeEngineProfile.value?.id)
))
const engineCatalogDiagnostics = computed(() => settings.runtime?.engineCatalog?.diagnostics || [])
const activeCatalogEngine = computed(() => (
  settings.runtime?.engineCatalog?.engines.find(
    (engine) => engine.id === activeEngineProfile.value?.engineId,
  ) || null
))
const activeEngineDescription = computed(() => (
  engineDescriptions[engineDescriptionKey(activeEngineProfile.value)] || null
))
function supportedOutputsForProfile(profile: TrainerEngineProfile) {
  const contracts = engineDescriptions[engineDescriptionKey(profile)]?.outputContracts || []
  return SUPPORTED_ENGINE_OUTPUTS.value.filter((supported) => contracts.some((contract) => (
    contract.id === supported.id && contract.version === supported.version
  )))
}
const activeSupportedOutputs = computed(() => {
  const profile = activeEngineProfile.value
  return profile ? supportedOutputsForProfile(profile) : []
})
function weightSlotsForProfile(profile: TrainerEngineProfile) {
  const description = engineDescriptions[engineDescriptionKey(profile)]
  const supportedKeys = new Set(supportedOutputsForProfile(profile).map((output) => `${output.id}:${output.version}`))
  return (description?.weightSlots || []).filter((slot) => (
    slot.requiredForOutputs?.some((output) => supportedKeys.has(`${output.id}:${output.version}`)) === true
  ))
}
const activeEngineWeightSlots = computed(() => {
  const profile = activeEngineProfile.value
  return profile ? weightSlotsForProfile(profile) : []
})
const activeEngineDevices = computed(() => activeEngineDescription.value?.devices || [])
const activeEngineOptionEntries = computed(() => {
  const properties = activeEngineDescription.value?.optionsSchema?.properties || {}
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
})
function openEngineWindow() {
  cancelEngineAutosaveTimer()
  if (!engineAutosavePromise && engineSavedRevision >= engineDraftRevision) {
    replaceEngineDraft(settings.engines)
    engineDraftRevision = 0
    engineSavedRevision = 0
  }
  engineAutosaveEnabled = true
  showSettingsPanel.value = false
  showEngineWindow.value = true
  engineSaveMessage.value = ''
  deleteEngineConfirmationId.value = ''
  if (!settingsDraft.engines.profiles.some((profile) => profile.id === editingEngineProfileId.value)) {
    editingEngineProfileId.value = settingsDraft.engines.profiles[0]?.id || ''
  }
  for (const profile of activeEngineProfiles.value) {
    void describeEngineProfile(profile)
  }
  focusFloatingPanel('engine')
}

function closeEngineWindow() {
  showEngineWindow.value = false
  void flushEngineAutosave()
}

function selectEngineProfile(profileId: string) {
  editingEngineProfileId.value = profileId
  deleteEngineConfirmationId.value = ''
  const profile = activeEngineProfiles.value.find((item) => item.id === profileId) || null
  void describeEngineProfile(profile)
}

function toggleEngineOutputFilter(outputId: SupportedEngineOutputId) {
  engineOutputFilter.value = engineOutputFilter.value === outputId ? null : outputId
}

watch(deleteEngineConfirmationId, (profileId) => {
  if (deleteEngineConfirmationTimer !== null) {
    window.clearTimeout(deleteEngineConfirmationTimer)
    deleteEngineConfirmationTimer = null
  }
  if (!profileId) return
  deleteEngineConfirmationTimer = window.setTimeout(() => {
    if (deleteEngineConfirmationId.value === profileId) {
      deleteEngineConfirmationId.value = ''
    }
  }, DELETE_CONFIRMATION_TIMEOUT_MS)
})

function catalogEngineForProfile(profile: TrainerEngineProfile | null) {
  return settings.runtime?.engineCatalog?.engines.find((engine) => (
    engine.id === profile?.engineId
    || engine.enginePath.toLowerCase() === String(profile?.enginePath || '').toLowerCase()
  )) || null
}

function engineDescriptionKey(profile: TrainerEngineProfile | null): string {
  return String(profile?.enginePath || profile?.engineId || '')
}

function engineProfileSupportsOutput(
  profile: TrainerEngineProfile,
  outputId: SupportedEngineOutputId,
): boolean {
  const description = engineDescriptions[engineDescriptionKey(profile)]
  const supported = SUPPORTED_ENGINE_OUTPUTS.value.find((output) => output.id === outputId)
  return Boolean(supported && description?.outputContracts.some((contract) => (
    contract.id === supported.id && contract.version === supported.version
  )))
}

function engineOutputAssignmentProfile(outputId: SupportedEngineOutputId): TrainerEngineProfile | null {
  const profileId = settingsDraft.engines.outputAssignments[outputId]
  return activeEngineProfiles.value.find((profile) => profile.id === profileId) || null
}

function engineOutputRuntimeKind(outputId: SupportedEngineOutputId): EngineRuntimeKind {
  return outputId === 'action-recommendation' ? 'decision' : 'opponent'
}

function engineOutputAssignmentIsLoaded(outputId: SupportedEngineOutputId): boolean {
  const profile = engineOutputAssignmentProfile(outputId)
  return Boolean(profile && profileRuntimeState(profile, engineOutputRuntimeKind(outputId))?.ready)
}

function engineOutputAssignmentIsLoading(outputId: SupportedEngineOutputId): boolean {
  const profile = engineOutputAssignmentProfile(outputId)
  if (!profile || engineOutputAssignmentIsLoaded(outputId) || engineOutputAssignmentHasError(outputId)) return false
  if (loadingEngineProfileId.value === profile.id) return true
  const runtime = profileRuntimeState(profile, engineOutputRuntimeKind(outputId))
  return Boolean(runtime && !runtime.ready && !runtime.unloaded)
}

function engineOutputAssignmentHasError(outputId: SupportedEngineOutputId): boolean {
  const profile = engineOutputAssignmentProfile(outputId)
  if (!profile) return false
  const kind = engineOutputRuntimeKind(outputId)
  return Boolean(engineLoadErrors[profile.id])
    || (profileMatchesRuntime(profile, kind) && Boolean(runtimeEngineError(kind)))
}

async function describeEngineProfile(
  profile: TrainerEngineProfile | null,
) {
  const key = engineDescriptionKey(profile)
  if (!profile?.enginePath || engineDescriptions[key] || describingEngineIds.has(key)) return
  if (!window.trainerAPI?.describeEngine) return
  describingEngineIds.add(key)
  delete engineDescribeErrors[key]
  try {
    const description = await window.trainerAPI.describeEngine({
      engineId: profile.engineId || undefined,
      engineVersion: profile.engineVersion || undefined,
      enginePath: profile.enginePath,
      engineCommand: Array.isArray(profile.engineCommand)
        ? profile.engineCommand.map(String)
        : [],
      engineCwd: profile.engineCwd,
    })
    engineDescriptions[key] = description
    if (profileConfigurationLocked(profile)) return
    profile.engineId = description.engine.id
    profile.engineVersion = description.engine.version
    if (!profile.device || !description.devices.some((device) => device.type === profile.device)) {
      profile.device = description.devices[0]?.type || ''
    }
  } catch (error) {
    engineDescribeErrors[key] = error instanceof Error ? error.message : String(error)
  } finally {
    describingEngineIds.delete(key)
  }
}

function runtimeEngineError(kind: EngineRuntimeKind): string {
  if (kind === 'opponent') {
    return String(status.modelActivity?.errors?.opponentAnalysis || '')
  }
  return (status.modelActivity?.errors?.decision || []).find(Boolean) || ''
}

function runtimeEngineState(kind: EngineRuntimeKind): TrainerModelRuntimeState {
  return kind === 'opponent'
    ? status.modelRuntime.opponentAnalysis
    : status.modelRuntime.decision
}

function runtimeFields(profile: TrainerEngineProfile): string {
  return JSON.stringify({
    engineId: profile.engineId,
    engineVersion: profile.engineVersion,
    enginePath: profile.enginePath,
    engineCommand: profile.engineCommand || [],
    engineCwd: profile.engineCwd || '',
    weights: profile.weights || [],
    device: profile.device || '',
    options: profile.options || {},
  })
}

function captureRuntimeEngineProfile(
  kind: EngineRuntimeKind,
  engines: TrainerEngineSettings,
) {
  const outputIds: SupportedEngineOutputId[] = kind === 'decision'
    ? ['action-recommendation']
    : OPPONENT_ENGINE_OUTPUT_IDS
  for (const outputId of outputIds) {
    const profileId = engines.outputAssignments[outputId]
    const profile = engines.profiles.find((item) => item.id === profileId)
    if (profile) {
      runtimeEngineProfiles[profile.id] = JSON.parse(JSON.stringify(profile)) as TrainerEngineProfile
    }
  }
}

function markConfiguredEngineStarting(
  kind: EngineRuntimeKind,
  engines: TrainerEngineSettings,
) {
  const runtime = runtimeEngineState(kind)
  if (runtime.ready || runtime.unloaded || runtimeEngineError(kind)) return

  const profileId = kind === 'decision'
    ? engines.outputAssignments['action-recommendation']
    : OPPONENT_ENGINE_OUTPUT_IDS
      .map((outputId) => engines.outputAssignments[outputId])
      .find(Boolean) || ''
  const profile = engines.profiles.find((item) => item.id === profileId)
  if (!profile?.enginePath || !(profile.weights || []).every((weight) => weight.path)) return
  if (runtime.profileId && runtime.profileId !== profileId) return

  Object.assign(runtime, {
    profileId,
    ready: false,
    unloaded: false,
  })
  if (kind === 'decision') {
    status.modelActivity.decision = ['loading', 'idle', 'idle', 'idle']
  } else {
    status.modelActivity.opponentAnalysis = 'loading'
  }
}

function runtimeProfileChanged(profile: TrainerEngineProfile, kind: EngineRuntimeKind): boolean {
  void kind
  const runtimeProfile = runtimeEngineProfiles[profile.id]
  return !runtimeProfile
    || profile.id !== runtimeProfile.id
    || runtimeFields(profile) !== runtimeFields(runtimeProfile)
}

function profileMatchesRuntime(profile: TrainerEngineProfile, kind: EngineRuntimeKind): boolean {
  return profileRuntimeState(profile, kind) !== null
}

function profileRuntimeState(
  profile: TrainerEngineProfile,
  kind: EngineRuntimeKind,
): { ready: boolean; unloaded: boolean } | null {
  const runtime = runtimeEngineState(kind)
  if (runtimeProfileChanged(profile, kind)) return null
  const specific = runtime.profiles?.[profile.id]
  if (specific) return specific
  if (runtime.profileId === profile.id || runtime.profileIds?.includes(profile.id) === true) {
    return runtime
  }
  return null
}

function profileRuntimeKinds(profile: TrainerEngineProfile): EngineRuntimeKind[] {
  const outputs = profileAssignedOutputs(profile)
  const runtimeGroups: EngineRuntimeKind[] = []
  if (outputs.includes('action-recommendation')) runtimeGroups.push('decision')
  if (outputs.some((output) => output !== 'action-recommendation')) runtimeGroups.push('opponent')
  return runtimeGroups
}

function profileIsLoaded(profile: TrainerEngineProfile): boolean {
  const runtimeGroups = profileRuntimeKinds(profile)
  return runtimeGroups.length > 0 && runtimeGroups.every((kind) => (
    profileRuntimeState(profile, kind)?.ready === true
  ))
}

function profileIsLoading(profile: TrainerEngineProfile): boolean {
  if (engineLoadErrors[profile.id]) return false
  if (profile.id === loadingEngineProfileId.value) return true
  return profileRuntimeKinds(profile).some((kind) => {
    const runtime = profileRuntimeState(profile, kind)
    return runtime !== null
      && !runtime.ready
      && !runtime.unloaded
      && !runtimeEngineError(kind)
  })
}

function profileConfigurationLocked(profile: TrainerEngineProfile): boolean {
  return profileIsLoaded(profile) || profileIsLoading(profile)
}

function engineProfileClasses(profile: TrainerEngineProfile) {
  const runtimeGroups = profileRuntimeKinds(profile)
  const loaded = profileIsLoaded(profile)
  const matchesRuntime = runtimeGroups.some((kind) => profileMatchesRuntime(profile, kind))
  return {
    selected: profile.id === activeEngineProfile.value?.id,
    loaded,
    loading: profileIsLoading(profile),
    unloaded: matchesRuntime && runtimeGroups.every((kind) => (
      profileRuntimeState(profile, kind)?.unloaded === true
    )),
    error: Boolean(engineLoadErrors[profile.id])
      || runtimeGroups.some((kind) => profileMatchesRuntime(profile, kind) && Boolean(runtimeEngineError(kind))),
    unavailable: !profile.enginePath || profileAssignedOutputs(profile).length === 0,
  }
}

function engineProfileSubtitle(profile: TrainerEngineProfile): string {
  if (profile.id === loadingEngineProfileId.value) return t('engine.status.loading')
  if (engineLoadErrors[profile.id]) return t('engine.status.failed')
  const runtimeGroups = profileRuntimeKinds(profile)
  if (!runtimeGroups.some((kind) => profileMatchesRuntime(profile, kind))) return ''
  if (runtimeGroups.some((kind) => runtimeEngineError(kind))) return t('engine.status.failed')
  if (runtimeGroups.every((kind) => profileRuntimeState(profile, kind)?.unloaded === true)) return t('engine.status.notLoaded')
  if (!profileIsLoaded(profile)) return t('engine.status.loading')
  return t('engine.status.loaded')
}

const engineFooterMessage = computed(() => {
  const profile = activeEngineProfile.value
  const runtimeError = profile
    ? profileRuntimeKinds(profile)
      .filter((kind) => profileMatchesRuntime(profile, kind))
      .map(runtimeEngineError)
      .find(Boolean)
    : ''
  return runtimeError || engineSaveMessage.value
})

function shouldShowEngineActionButton(profile: TrainerEngineProfile): boolean {
  return profileIsLoaded(profile)
    || (
      !profileIsLoading(profile)
      && Boolean(profile.enginePath && profileAssignedOutputs(profile).length)
      && requiredWeightsReady(profile)
      && !profileIsLoaded(profile)
    )
}

function handleEngineProfileAction(profile: TrainerEngineProfile) {
  if (profileIsLoaded(profile)) {
    void unloadEngineProfile(profile.id)
  } else {
    void loadEngineProfile(profile.id)
  }
}

function moveEngineProfile(offset: number) {
  const profiles = activeEngineProfiles.value
  const from = activeEngineProfileIndex.value
  const to = from + offset
  if (from < 0 || to < 0 || to >= profiles.length) return
  const [profile] = profiles.splice(from, 1)
  profiles.splice(to, 0, profile)
}

function duplicateEngineProfile() {
  const source = activeEngineProfile.value
  if (!source) return
  const copyProfile: TrainerEngineProfile = JSON.parse(JSON.stringify(source))
  copyProfile.id = `profile.user.${Date.now().toString(36)}`
  copyProfile.name = t('engine.copySuffix', { name: source.name })
  copyProfile.builtIn = false
  copyProfile.autoName = false
  activeEngineProfiles.value.splice(activeEngineProfileIndex.value + 1, 0, copyProfile)
  selectEngineProfile(copyProfile.id)
}

function deleteEngineProfile() {
  const profile = activeEngineProfile.value
  const index = activeEngineProfileIndex.value
  if (!profile || profile.builtIn || profileAssignedOutputs(profile).length > 0 || index < 0) return
  if (deleteEngineConfirmationId.value !== profile.id) {
    deleteEngineConfirmationId.value = profile.id
    return
  }
  activeEngineProfiles.value.splice(index, 1)
  const next = activeEngineProfiles.value[Math.min(index, activeEngineProfiles.value.length - 1)]
  if (next) selectEngineProfile(next.id)
  deleteEngineConfirmationId.value = ''
}

function addEngineProfile() {
  engineOutputFilter.value = null
  const profile: TrainerEngineProfile = {
    id: `profile.user.${Date.now().toString(36)}`,
    name: '',
    engineId: '',
    enginePath: '',
    builtIn: false,
    available: false,
    autoName: true,
    weights: [],
    device: '',
    options: {},
  }
  activeEngineProfiles.value.push(profile)
  selectEngineProfile(profile.id)
}

function fileNameFromPath(value: string): string {
  return String(value || '').split(/[\\/]/).pop() || ''
}

function suggestedEngineProfileName(profile: TrainerEngineProfile): string {
  const engineName = engineDescriptions[engineDescriptionKey(profile)]?.engine.name
    || catalogEngineForProfile(profile)?.name
    || fileNameFromPath(profile.enginePath).replace(/\.[^.]+$/, '')
  const weightNames = (profile.weights || [])
    .map((weight) => fileNameFromPath(weight.path).replace(/\.[^.]+$/, ''))
    .filter(Boolean)
  return [engineName, ...weightNames].filter(Boolean).join(' + ')
}

function refreshAutomaticEngineName(profile: TrainerEngineProfile) {
  if (profile.autoName !== false && !profile.builtIn) {
    profile.name = suggestedEngineProfileName(profile)
  }
}

function setEngineProfileName(event: Event) {
  const profile = activeEngineProfile.value
  if (!profile || profileConfigurationLocked(profile)) return
  const value = (event.target as HTMLInputElement).value
  profile.name = value
  profile.autoName = !value.trim()
  if (profile.autoName) refreshAutomaticEngineName(profile)
}

async function chooseEngineFile() {
  const profile = activeEngineProfile.value
  if (!profile || profileConfigurationLocked(profile) || !window.trainerAPI?.chooseEngineFile) return
  const selectedPath = await window.trainerAPI.chooseEngineFile()
  if (!selectedPath || profileConfigurationLocked(profile)) return
  profile.enginePath = selectedPath
  profile.engineCommand = [selectedPath]
  profile.engineCwd = ''
  profile.engineId = ''
  profile.engineVersion = ''
  profile.weights = []
  profile.device = ''
  profile.options = {}
  profile.available = false
  delete engineLoadErrors[profile.id]
  refreshAutomaticEngineName(profile)
  await describeEngineProfile(profile)
  refreshAutomaticEngineName(profile)
}

async function chooseEngineWeight(slotId: string) {
  const profile = activeEngineProfile.value
  if (!profile || profileConfigurationLocked(profile) || !window.trainerAPI?.chooseEngineWeight) return
  const selectedPath = await window.trainerAPI.chooseEngineWeight()
  if (!selectedPath || profileConfigurationLocked(profile)) return
  const slot = activeEngineWeightSlots.value.find((item) => item.id === slotId)
  if (!slot) return
  const extension = selectedPath.match(/\.[^.\\/]+$/)?.[0]?.toLowerCase() || ''
  const format = slot.formats.find((item) => (
    Array.isArray(item.extensions)
    && item.extensions.map((value) => String(value).toLowerCase()).includes(extension)
  )) || slot.formats[0]
  const weights = profile.weights || (profile.weights = [])
  const next = { slotId, format: String(format?.id || ''), path: selectedPath }
  const index = weights.findIndex((weight) => weight.slotId === slotId)
  if (index >= 0) weights.splice(index, 1, next)
  else weights.push(next)
  profile.available = true
  delete engineLoadErrors[profile.id]
  refreshAutomaticEngineName(profile)
}

function localizedEngineText(value: string | Record<string, string> | undefined, fallback: string): string {
  if (typeof value === 'string') return value
  const language = locale.value.split('-')[0]
  return value?.[locale.value]
    || value?.[language]
    || value?.['en-US']
    || value?.en
    || value?.default
    || value?.['zh-CN']
    || fallback
}

function profileAssignedOutputs(profile: TrainerEngineProfile): SupportedEngineOutputId[] {
  return SUPPORTED_ENGINE_OUTPUTS.value
    .map((output) => output.id)
    .filter((outputId) => settingsDraft.engines.outputAssignments[outputId] === profile.id)
}

function setEngineOutputAssignment(outputId: SupportedEngineOutputId, event: Event) {
  const profile = activeEngineProfile.value
  if (!profile || profileConfigurationLocked(profile)) return
  const checked = (event.target as HTMLInputElement).checked
  settingsDraft.engines.outputAssignments[outputId] = checked ? profile.id : ''
}

function engineWeight(profile: TrainerEngineProfile, slotId: string) {
  return (profile.weights || []).find((weight) => weight.slotId === slotId)
}

function weightSlotIsActive(slot: TrainerEngineDescription['weightSlots'][number], profile: TrainerEngineProfile): boolean {
  const required = slot.requiredForOutputs || []
  if (!required.length) return true
  const assigned = new Set(profileAssignedOutputs(profile))
  return required.some((output) => output.version === 1 && assigned.has(output.id as SupportedEngineOutputId))
}

function requiredWeightsReady(profile: TrainerEngineProfile): boolean {
  return weightSlotsForProfile(profile)
    .filter((slot) => weightSlotIsActive(slot, profile))
    .every((slot) => {
      const weight = engineWeight(profile, slot.id)
      return Boolean(weight?.path && weight.format)
    })
}

function setEngineDevice(event: Event) {
  const profile = activeEngineProfile.value
  if (!profile || profileConfigurationLocked(profile)) return
  profile.device = (event.target as HTMLSelectElement).value
}

function formatEngineOptionDefault(value: unknown): string {
  if (value === true) return t('common.yes')
  if (value === false) return t('common.no')
  return value == null ? t('engine.settingFallback') : String(value)
}

function engineOptionInputMode(option: typeof activeEngineOptionEntries.value[number]) {
  if (option.type === 'integer') return 'numeric'
  if (option.type === 'number') return 'decimal'
  return undefined
}

function setEngineOptionFromEvent(option: typeof activeEngineOptionEntries.value[number], event: Event) {
  const profile = activeEngineProfile.value
  if (!profile || profileConfigurationLocked(profile)) return
  const target = event.target as HTMLInputElement | HTMLSelectElement
  const raw = target.value
  if (raw === '') {
    delete profile.options[option.key]
    engineSaveMessage.value = ''
    return
  }
  if (option.type === 'boolean') profile.options[option.key] = raw === 'true'
  else if (option.type === 'number' || option.type === 'integer') {
    const value = Number(raw)
    const invalid = !Number.isFinite(value)
      || (option.type === 'integer' && !Number.isInteger(value))
      || (option.minimum !== undefined && value < option.minimum)
      || (option.maximum !== undefined && value > option.maximum)
    if (invalid) {
      target.value = String(profile.options[option.key] ?? '')
      engineSaveMessage.value = t('engine.optionInvalid', { label: option.label })
      return
    }
    profile.options[option.key] = value
  } else {
    profile.options[option.key] = raw
  }
}

function replaceEngineDraft(engines: TrainerEngineSettings) {
  suppressEngineAutosave = true
  try {
    Object.assign(settingsDraft.engines, JSON.parse(JSON.stringify(engines)))
  } finally {
    suppressEngineAutosave = false
  }
}

function cancelEngineAutosaveTimer() {
  if (engineAutosaveTimer === null) return
  window.clearTimeout(engineAutosaveTimer)
  engineAutosaveTimer = null
}

function scheduleEngineAutosave(delay = ENGINE_AUTOSAVE_DELAY_MS) {
  cancelEngineAutosaveTimer()
  if (loadingEngineProfileId.value) return
  engineAutosaveTimer = window.setTimeout(() => {
    engineAutosaveTimer = null
    void flushEngineAutosave()
  }, delay)
}

watch(
  () => settingsDraft.engines,
  () => {
    if (suppressEngineAutosave || !engineAutosaveEnabled) return
    engineDraftRevision += 1
    engineSaveMessage.value = ''
    scheduleEngineAutosave()
  },
  { deep: true, flush: 'sync' },
)

async function saveEngineDraftSnapshot(
  snapshot: TrainerEngineSettings,
  revision: number,
): Promise<boolean> {
  if (!window.trainerAPI) return false
  try {
    const saved = await window.trainerAPI.saveSettings({
      engines: snapshot,
    })
    applySettings(saved)
    engineSavedRevision = Math.max(engineSavedRevision, revision)
    if (engineDraftRevision === revision) replaceEngineDraft(saved.engines)
    return true
  } catch (error) {
    engineSaveMessage.value = t('engine.saveFailed', { message: error instanceof Error ? error.message : String(error) })
    return false
  }
}

async function flushEngineAutosave(): Promise<boolean> {
  cancelEngineAutosaveTimer()
  while (engineSavedRevision < engineDraftRevision) {
    if (engineAutosavePromise) {
      if (!await engineAutosavePromise) return false
      continue
    }
    const revision = engineDraftRevision
    const snapshot = JSON.parse(JSON.stringify(settingsDraft.engines)) as TrainerEngineSettings
    const request = saveEngineDraftSnapshot(snapshot, revision)
    engineAutosavePromise = request
    const saved = await request
    if (engineAutosavePromise === request) engineAutosavePromise = null
    if (!saved) return false
  }
  return true
}

async function loadEngineProfile(profileId: string) {
  if (!window.trainerAPI?.activateEngine || loadingEngineProfileId.value || unloadingEngineProfileId.value) return
  loadingEngineProfileId.value = profileId
  engineSaveMessage.value = ''
  delete engineLoadErrors[profileId]
  try {
    if (!await flushEngineAutosave()) return
    const activationRevision = engineDraftRevision
    const engines = JSON.parse(JSON.stringify(settingsDraft.engines)) as TrainerEngineSettings
    const loaded = await window.trainerAPI.activateEngine({
      profileId,
      engines,
    })
    applySettings(loaded)
    applyStatus(await window.trainerAPI.getStatus())
    captureRuntimeEngineProfile('decision', loaded.engines)
    captureRuntimeEngineProfile('opponent', loaded.engines)
    engineSavedRevision = Math.max(engineSavedRevision, activationRevision)
    if (engineDraftRevision === activationRevision) {
      replaceEngineDraft(loaded.engines)
    }
    engineSaveMessage.value = t('engine.loaded')
  } catch (error) {
    try {
      const failedSettings = await window.trainerAPI.getSettings()
      applySettings(failedSettings)
      applyStatus(await window.trainerAPI.getStatus())
      captureRuntimeEngineProfile('decision', failedSettings.engines)
      captureRuntimeEngineProfile('opponent', failedSettings.engines)
    } catch {
      // Keep the original load error when status synchronization also fails.
    }
    engineLoadErrors[profileId] = error instanceof Error ? error.message : String(error)
    engineSaveMessage.value = t('engine.loadFailed', { message: engineLoadErrors[profileId] })
  } finally {
    loadingEngineProfileId.value = ''
    if (engineSavedRevision < engineDraftRevision) scheduleEngineAutosave(0)
  }
}

async function unloadEngineProfile(profileId: string) {
  if (!window.trainerAPI?.unloadEngine || loadingEngineProfileId.value || unloadingEngineProfileId.value) return
  if (activeEngineProfile.value?.id !== profileId || !profileIsLoaded(activeEngineProfile.value)) return
  unloadingEngineProfileId.value = profileId
  engineSaveMessage.value = ''
  try {
    const unloaded = await window.trainerAPI.unloadEngine({ profileId })
    applyStatus(unloaded.state)
    applySettings(unloaded.settings)
    replaceEngineDraft(unloaded.settings.engines)
    if (profileAssignedOutputs(activeEngineProfile.value).some((output) => output !== 'action-recommendation')) {
      if (!shantenResultHasRows(gameView.opponentAnalysis)) {
        clearOpponentAnalysisWithoutMotion()
      }
      void fetchShantenOnce()
    }
    engineSaveMessage.value = t('engine.unloaded')
  } catch (error) {
    engineSaveMessage.value = t('engine.unloadFailed', { message: error instanceof Error ? error.message : String(error) })
  } finally {
    unloadingEngineProfileId.value = ''
  }
}
const decisionRecommendationsEnabled = ref(true)
type DecisionAnalysis = NonNullable<TrainerGameView['analysis']>
const decisionAnalysisEventCache = new Map<string, DecisionAnalysis>()
const ronWaitPredData = ref<Record<string, number[]>>({})
const ronWaitGTData = ref<Record<string, number[]>>({})
const shantenPredData = ref<Record<string, number[]>>({})
const shantenGTData = ref<Record<string, number[]>>({})
const shantenViewMode = ref<'predictions' | 'ground_truth'>('predictions')
const shantenHoverText = ref('')
const suppressOpponentAnalysisTransitions = ref(false)
let opponentAnalysisResetGeneration = 0
let deferredShantenResult: Record<string, unknown> | null = null

const shantenData = computed(() => (
  shantenViewMode.value === 'ground_truth' ? shantenGTData.value : shantenPredData.value
))
const ronWaitData = computed(() => (
  shantenViewMode.value === 'ground_truth' ? ronWaitGTData.value : ronWaitPredData.value
))
const EMPTY_RON_WAIT_VALUES = Array.from({ length: 34 }, () => 0)
const displayedRonWaitData = computed(() => ({
  kamicha: ronWaitData.value.kamicha || EMPTY_RON_WAIT_VALUES,
  toimen: ronWaitData.value.toimen || EMPTY_RON_WAIT_VALUES,
  shimocha: ronWaitData.value.shimocha || EMPTY_RON_WAIT_VALUES,
}))
const shantenRawData = ref<Record<string, Record<string, unknown>>>({})
const shantenRawJson = computed(() => JSON.stringify(shantenRawData.value, null, 2))
const shantenStatus = ref('—')
const SHANTEN_LABELS = computed(() => [
  t('shanten.tenpai'),
  t('shanten.one'),
  t('shanten.two'),
  t('shanten.three'),
  t('shanten.four'),
  t('shanten.five'),
  t('shanten.six'),
  t('shanten.furiten'),
])
const SHANTEN_SHORT_LABELS = ['0','1','2','3','4','5','6','X']
const RON_TILE_ROWS = [
  ['1m','2m','3m','4m','5m','6m','7m','8m','9m'],
  ['1p','2p','3p','4p','5p','6p','7p','8p','9p'],
  ['1s','2s','3s','4s','5s','6s','7s','8s','9s'],
  ['E','S','W','N','P','F','C'],
]
const ronWaitTileRows = RON_TILE_ROWS
const TILE_IDX_MAP: Record<string, number> = {'m':0,'p':9,'s':18,'E':27,'S':28,'W':29,'N':30,'P':31,'F':32,'C':33}
function tileIdx(tile: string): number {
  const normalized = tile.replace('r', '')
  const ch = normalized.slice(-1)
  const rank = parseInt(normalized) || 0
  return (TILE_IDX_MAP[ch] || 0) + (rank > 0 ? rank - 1 : 0)
}
const RON_BAR_ADAPTIVE_MIN = 0.20
const RON_BAR_TICK_STEP = 0.05
const RON_WAIT_OPPONENT_KEYS = ['kamicha', 'toimen', 'shimocha'] as const
function resolveRonBarAdaptiveMaxFromValues(values: number[]): number {
  const maxProbability = values.reduce(
    (currentMax, value) => Math.max(currentMax, displayedRonProbability(value)),
    0,
  )
  return Math.max(RON_BAR_ADAPTIVE_MIN, maxProbability)
}
function resolveRonBarAdaptiveMax(data: Record<string, number[]>): number {
  return resolveRonBarAdaptiveMaxFromValues(
    RON_WAIT_OPPONENT_KEYS.flatMap((key) => data[key] || []),
  )
}
const ronBarAdaptiveMax = computed(() => resolveRonBarAdaptiveMax(ronWaitData.value))
const showRonAdaptiveThreshold = computed(() => (
  shantenViewMode.value === 'predictions'
  && ronBarAdaptiveMax.value > RON_BAR_ADAPTIVE_MIN
))
const ronWaitScaleTicks = computed(() => {
  if (shantenViewMode.value === 'ground_truth') {
    return [
      { value: 0, label: '0%' },
      { value: 1, label: '100%' },
    ]
  }
  const stepCount = Math.floor(
    (ronBarAdaptiveMax.value + Number.EPSILON) / RON_BAR_TICK_STEP,
  )
  return Array.from({ length: stepCount + 1 }, (_, index) => ({
    value: index * RON_BAR_TICK_STEP,
    label: index % 2 === 0 ? `${index * 5}%` : '',
  }))
})
function displayedRonProbability(prob: number): number {
  return Math.max(0, Math.min(1, Number(prob) || 0))
}
function ronBarHeightAtScale(prob: number, scaleMax: number): string {
  return `${(ronBarScaleAtScale(prob, scaleMax) * 100).toFixed(1)}%`
}
function ronBarScaleAtScale(prob: number, scaleMax: number): number {
  return Math.min(1, displayedRonProbability(prob) / scaleMax)
}
function ronBarHeight(prob: number): string {
  return ronBarHeightAtScale(prob, ronBarAdaptiveMax.value)
}
function ronBarScale(prob: number): number {
  return ronBarScaleAtScale(prob, ronBarAdaptiveMax.value)
}
function southRonRiskBarHeight(prob: number): string {
  return ronBarHeightAtScale(prob, southRonRiskAdaptiveMax.value)
}
function southRonRiskBarScale(prob: number): number {
  return ronBarScaleAtScale(prob, southRonRiskAdaptiveMax.value)
}
function formatHoverProbability(prob: number): string {
  const value = Math.max(0, Math.min(1, Number(prob) || 0))
  const percentage = value * 100
  if (percentage === 0) return '0%'
  if (percentage < 0.01) return '<0.01%'
  return `${percentage.toFixed(2)}%`
}
function showRonHover(opponentLabel: string, tile: string, probability: number) {
  shantenHoverText.value = `${opponentLabel} - ${tileFaceLabel(tile)} - ${formatHoverProbability(displayedRonProbability(probability))}`
}
function showShantenHover(opponentLabel: string, label: string, probability: number) {
  shantenHoverText.value = `${opponentLabel} - ${label} - ${formatHoverProbability(probability)}`
}
function clearShantenHover() {
  shantenHoverText.value = ''
}
let _shantenTimer: number | null = null
let _analysisVisibilityGeneration = 0

function hasShantenRows(group: Record<string, number[]> | undefined): group is Record<string, number[]> {
  return Boolean(group && Object.values(group).some((values) => Array.isArray(values) && values.length > 0))
}

function shantenResultHasRows(result: Record<string, unknown> | null | undefined): boolean {
  if (!result) return false
  const predictions = result.predictions as Record<string, unknown> | undefined
  const groundTruth = result.ground_truth as Record<string, unknown> | undefined
  const outputs = result.outputs as Record<string, unknown> | undefined
  return Boolean(outputs && Object.keys(outputs).length) || [predictions, groundTruth].some((section) => (
    hasShantenRows(section?.opponents as Record<string, number[]> | undefined)
    || hasShantenRows(section?.ron_wait as Record<string, number[]> | undefined)
  ))
}

const hasOpponentGroundTruth = computed(() => (
  hasShantenRows(shantenGTData.value) || hasShantenRows(ronWaitGTData.value)
))

function shantenResultMatchesCurrentPosition(result: Record<string, unknown>): boolean {
  const context = result.context as Record<string, unknown> | undefined
  if (!context) return false
  return context.gameId === gameView.gameId
    && context.nodeId === gameView.currentNodeId
    && Number(context.seat) === status.controlledSeat
}

function suppressOpponentAnalysisMotion() {
  const resetGeneration = ++opponentAnalysisResetGeneration
  suppressOpponentAnalysisTransitions.value = true
  deferredShantenResult = null

  // Keep transitions disabled until the replacement values have reached the screen.
  void nextTick(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (resetGeneration !== opponentAnalysisResetGeneration) return
        suppressOpponentAnalysisTransitions.value = false
        const deferredResult = deferredShantenResult
        deferredShantenResult = null
        if (deferredResult) applyShantenResult(deferredResult)
      })
    })
  })
}

function clearOpponentAnalysisWithoutMotion() {
  suppressOpponentAnalysisMotion()
  shantenPredData.value = {}
  shantenGTData.value = {}
  ronWaitPredData.value = {}
  ronWaitGTData.value = {}
  shantenRawData.value = {}
  shantenHoverText.value = ''
  shantenStatus.value = '—'
}

function applyShantenResult(
  result: Record<string, unknown>,
  options: { withoutMotion?: boolean; clearWhenEmpty?: boolean } = {},
): boolean {
  if (!shantenResultMatchesCurrentPosition(result)) return false
  gameView.opponentAnalysis = result
  if (suppressOpponentAnalysisTransitions.value && !options.withoutMotion) {
    deferredShantenResult = result
    return true
  }

  const raw = result.raw as Record<string, unknown> | undefined
  shantenStatus.value = String(result.status || '?')
  shantenRawData.value = raw
    ? raw as Record<string, Record<string, unknown>>
    : {}

  const predictions = result.predictions as Record<string, unknown> | undefined
  const groundTruth = result.ground_truth as Record<string, unknown> | undefined
  const predOpponents = predictions?.opponents as Record<string, number[]> | undefined
  const predRonWait = predictions?.ron_wait as Record<string, number[]> | undefined
  const gtOpponents = groundTruth?.opponents as Record<string, number[]> | undefined
  const gtRonWait = groundTruth?.ron_wait as Record<string, number[]> | undefined
  const hasPredOpponents = hasShantenRows(predOpponents)
  const hasPredRonWait = hasShantenRows(predRonWait)
  const hasGtOpponents = hasShantenRows(gtOpponents)
  const hasGtRonWait = hasShantenRows(gtRonWait)
  const protocolOutputs = result.outputs as Record<string, unknown> | undefined
  const hasResult = hasPredOpponents || hasPredRonWait || hasGtOpponents || hasGtRonWait
    || Boolean(protocolOutputs && Object.keys(protocolOutputs).length)

  if (!hasResult) {
    if (options.clearWhenEmpty) clearOpponentAnalysisWithoutMotion()
    return true
  }

  if (options.withoutMotion) suppressOpponentAnalysisMotion()
  shantenPredData.value = hasPredOpponents ? { ...predOpponents } : {}
  ronWaitPredData.value = hasPredRonWait ? { ...predRonWait } : {}
  shantenGTData.value = hasGtOpponents ? { ...gtOpponents } : {}
  ronWaitGTData.value = hasGtRonWait ? { ...gtRonWait } : {}
  return true
}

async function fetchShantenOnce() {
  if (!opponentAnalysisNeeded.value || !gameView.table || !window.trainerAPI?.getShanten) return
  try {
    applyShantenResult(await window.trainerAPI.getShanten(), {
      clearWhenEmpty: opponentAnalysisPermanentlyUnavailable.value,
    })
  } catch (e: unknown) {
    shantenStatus.value = 'err: ' + String(e)
  }
}

async function pollShanten() {
  if (!showAnalysisDock.value) return
  await fetchShantenOnce()
  if (showAnalysisDock.value) {
    _shantenTimer = window.setTimeout(pollShanten, 2000)
  }
}

watch(showAnalysisDock, async (open) => {
  if (_shantenTimer !== null) {
    window.clearTimeout(_shantenTimer)
    _shantenTimer = null
  }
  await nextTick()
  scheduleTableZoomRecalc()
  if (!open) {
    shantenHoverText.value = ''
    await syncAnalysisVisibilityToBackend()
    return
  }
  if (await syncAnalysisVisibilityToBackend()) void pollShanten()
})

async function toggleDecisionRecommendations(event?: Event) {
  if (status.mode !== 'research') return
  event?.preventDefault()
  event?.stopPropagation()
  const enabled = !decisionRecommendationsEnabled.value
  decisionRecommendationsEnabled.value = enabled
  if (!enabled) {
    decisionAnalysisEventCache.clear()
    gameView.analysis = null
  }
  if (await syncAnalysisVisibilityToBackend(true)) {
    if (opponentAnalysisNeeded.value) void fetchShantenOnce()
  } else {
    decisionRecommendationsEnabled.value = !enabled
  }
}

async function syncAnalysisVisibilityToBackend(refreshView = false): Promise<boolean> {
  if (!window.trainerAPI?.setAnalysisVisibility) return false
  const generation = ++_analysisVisibilityGeneration
  try {
    const response = await window.trainerAPI.setAnalysisVisibility({
      decisionRecommendations: effectiveDecisionRecommendationsEnabled.value,
      opponentAnalysis: opponentAnalysisNeeded.value,
    })
    if (generation !== _analysisVisibilityGeneration) return true
    applyStatus(response.state)
    if (refreshView) applyGameView(response.view)
    return true
  } catch {
    return generation !== _analysisVisibilityGeneration
  }
}

const shantenOpponents = computed(() => {
  const c = status.controlledSeat
  const opponents = [
    { key: 'kamicha', seat: (c + 3) % 4, label: t('seat.kamicha') },
    { key: 'toimen', seat: (c + 2) % 4, label: t('seat.toimen') },
    { key: 'shimocha', seat: (c + 1) % 4, label: t('seat.shimocha') },
  ]
  return opponents.map((opp) => ({
    ...opp,
    probabilities: shantenData.value[opp.key] || [],
  }))
})
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
const wallClipboardMessage = ref('')
const quickTrainingModes = computed(() => [
  { value: 'no_review', label: t('mode.noReview') },
  { value: 'threshold_review', label: t('mode.difference') },
  { value: 'always_review', label: t('mode.all') },
  { value: 'preview_before_click', label: t('mode.preview') },
] as const)
const wallTileRows = computed(() => {
  const rows: Array<Array<Array<{ index: number; tile: string; status: string }>>> = []
  const sectionEnds = [53, 122, wallTiles.value.length]
  let sectionStart = 0
  for (const sectionEnd of sectionEnds) {
    if (sectionEnd <= sectionStart) continue
    const groups: Array<Array<{ index: number; tile: string; status: string }>> = []
    for (let i = sectionStart; i < sectionEnd; i += 4) {
      groups.push(wallTiles.value.slice(i, Math.min(i + 4, sectionEnd)))
    }
    for (let i = 0; i < groups.length; i += 4) {
      rows.push(groups.slice(i, i + 4))
    }
    sectionStart = sectionEnd
  }
  return rows
})
const quickSettingsCollapsed = ref(false)
const treePanelCollapsed = ref(false)
const analysisPanelCollapsed = ref(false)

const status = reactive<TrainerStatusSnapshot>({
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
const runtimeMetrics = ref<TrainerRuntimeMetrics | null>(null)
let runtimeMetricsTimer: number | null = null
let runtimeMetricsRequestInFlight = false

function formatMemorySize(value: number | null | undefined) {
  if (value === null || value === undefined) return '—'
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const gibibytes = bytes / (1024 ** 3)
  if (gibibytes >= 1) return `${gibibytes.toFixed(gibibytes < 10 ? 2 : 1)} GB`
  const mebibytes = bytes / (1024 ** 2)
  return `${Math.round(mebibytes)} MB`
}

const runtimeMemoryRows = computed(() => {
  const metrics = runtimeMetrics.value
  if (!metrics) return [{ label: t('status.memoryInfo'), value: t('status.reading') }]
  const engineCount = metrics.engineProcessCount === null
    ? ''
    : t('status.engineProcesses', { count: metrics.engineProcessCount })
  return [
    { label: 'Electron', value: formatMemorySize(metrics.electronBytes) },
    { label: t('status.pythonBackend'), value: formatMemorySize(metrics.backendBytes) },
    { label: t('status.engines', { count: engineCount }), value: formatMemorySize(metrics.engineBytes) },
    { label: t('status.systemTotal'), value: formatMemorySize(metrics.systemTotalBytes) },
  ]
})

const runtimeMemoryDetail = computed(() => (
  runtimeMemoryRows.value.map((row) => `${row.label}：${row.value}`).join('\n')
))

async function refreshRuntimeMetrics() {
  if (!window.trainerAPI?.getRuntimeMetrics || runtimeMetricsRequestInFlight) return
  runtimeMetricsRequestInFlight = true
  try {
    runtimeMetrics.value = await window.trainerAPI.getRuntimeMetrics()
  } catch {
    // Keep the last successful sample while the backend or application is restarting.
  } finally {
    runtimeMetricsRequestInFlight = false
  }
}
const showTsumogiriTone = computed(() => (
  status.mode !== 'play' || settings.display.showTsumogiriInPlay !== false
))

const autoAnalysisRequestInFlight = ref(false)
const seatSwitchInFlight = ref(false)
const pendingSeatSwitchLabel = ref('')
const autoAnalysisCanvasEl = ref<HTMLCanvasElement | null>(null)
let autoAnalysisCanvasRaf = 0
let autoAnalysisResizeObserver: ResizeObserver | null = null
watch(showConsoleDock, async (open) => {
  await nextTick()
  scheduleTableZoomRecalc()
  autoAnalysisResizeObserver?.disconnect()
  if (open && autoAnalysisCanvasEl.value) {
    autoAnalysisResizeObserver?.observe(autoAnalysisCanvasEl.value)
    scheduleAutoAnalysisCanvasDraw()
  }
})
const autoAnalysisRunning = computed(() => status.autoAnalysis.status === 'running')
const autoAnalysisTimeline = computed(() => status.autoAnalysis.timeline || '')
const autoAnalysisTimelineTotal = computed(() => autoAnalysisTimeline.value.length)
const autoAnalysisPercent = computed(() => {
  const total = autoAnalysisTimelineTotal.value
  const completed = Math.max(0, Number(status.autoAnalysis.timelineReady) || 0)
  if (!total) return status.autoAnalysis.status === 'completed' ? 100 : 0
  return Math.round(Math.min(1, completed / total) * 100)
})
const autoAnalysisLabel = computed(() => {
  const { status: state, failed } = status.autoAnalysis
  const completed = Math.max(0, Number(status.autoAnalysis.timelineReady) || 0)
  const total = autoAnalysisTimelineTotal.value
  if (!status.gameLoaded) return t('autoAnalysis.noRecord')
  if (state === 'running') return total ? `${completed} / ${total}` : t('autoAnalysis.scanning')
  if (state === 'completed') return failed
    ? t('autoAnalysis.failedCount', { completed, total, failed })
    : (total ? `${completed} / ${total}` : t('autoAnalysis.notNeeded'))
  if (state === 'canceled') return total
    ? t('autoAnalysis.stoppedProgress', { completed, total })
    : t('autoAnalysis.stopped')
  return total ? `${completed} / ${total}` : t('autoAnalysis.notStarted')
})
function prepareAutoAnalysisCanvas(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect()
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(rect.width * ratio))
  const height = Math.max(1, Math.round(rect.height * ratio))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  return { context: canvas.getContext('2d'), width, height }
}

function autoAnalysisLineColor(state: string) {
  if (state === 'r' || state === 's') return 'rgb(143 121 82)'
  if (state === 'M' || state === 'O') return 'rgb(77 102 107)'
  return null
}

function drawAutoAnalysisMainCanvas() {
  const canvas = autoAnalysisCanvasEl.value
  if (!canvas) return
  const { context, width, height } = prepareAutoAnalysisCanvas(canvas)
  if (!context) return
  context.clearRect(0, 0, width, height)
  const timeline = autoAnalysisTimeline.value
  if (!timeline.length) return

  const slotWidth = width / timeline.length
  if (slotWidth >= 1) {
    for (let index = 0; index < timeline.length; index += 1) {
      const x = Math.floor(index * slotWidth)
      const nextX = Math.floor((index + 1) * slotWidth)
      const color = autoAnalysisLineColor(timeline[index])
      if (!color) continue
      context.fillStyle = color
      context.fillRect(x, 0, Math.max(1, nextX - x), height)
    }
    return
  }

  for (let x = 0; x < width; x += 1) {
    const start = Math.floor((x * timeline.length) / width)
    const end = Math.max(start + 1, Math.floor(((x + 1) * timeline.length) / width))
    let ready = 0
    let active = false
    for (let index = start; index < Math.min(end, timeline.length); index += 1) {
      const state = timeline[index]
      if (state === 'M' || state === 'O') ready += 1
      if (state === 'r' || state === 's') active = true
    }
    if (active) {
      context.fillStyle = 'rgb(143 121 82)'
    } else {
      const density = ready / Math.max(1, end - start)
      if (density <= 0) continue
      context.fillStyle = `rgba(77, 102, 107, ${density})`
    }
    context.fillRect(x, 0, 1, height)
  }
}

function scheduleAutoAnalysisCanvasDraw() {
  if (autoAnalysisCanvasRaf) return
  autoAnalysisCanvasRaf = window.requestAnimationFrame(() => {
    autoAnalysisCanvasRaf = 0
    drawAutoAnalysisMainCanvas()
  })
}

watch(autoAnalysisTimeline, () => {
  scheduleAutoAnalysisCanvasDraw()
})

async function toggleAutoAnalysis() {
  if (!window.trainerAPI || !status.gameLoaded || autoAnalysisRequestInFlight.value) return
  autoAnalysisRequestInFlight.value = true
  try {
    const response = autoAnalysisRunning.value
      ? await window.trainerAPI.cancelAutoAnalysis()
      : await window.trainerAPI.startAutoAnalysis()
    applyStatus(response.state)
  } catch (error) {
    status.autoAnalysis = {
      ...status.autoAnalysis,
      status: 'canceled',
      currentNodeId: null,
      currentModel: null,
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    autoAnalysisRequestInFlight.value = false
  }
}

const gameView = reactive<TrainerGameView>({
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

watch(
  () => [gameView.gameId, gameView.currentNodeId, status.controlledSeat],
  () => { void fetchShantenOnce() },
)

const recordPath = ref('')
const recordHeaderTitle = computed(() => {
  if (!recordPath.value) return ''
  return fileNameFromPath(recordPath.value)
})
const recordDirty = ref(false)
const recoveryRecord = ref(false)
const gameFileOperation = ref<'create' | 'open' | 'save' | 'save-as' | 'close' | null>(null)
const closeRecordConfirmationPending = ref(false)
let closeRecordConfirmationTimer: number | null = null
const autoAdvanceTimer = ref<number | null>(null)
const actionRequestInFlight = ref(false)
const advanceRequestInFlight = ref(false)
let gameplayResponseGeneration = 0
const playPrefetchReady = ref(false)
const playPrefetchWaiting = ref(false)
const earlyPlayPrefetchReady = new Set<string>()
const hoveredModelStatusId = ref<string | null>(null)
function normalizeModelActivityState(value: unknown): TrainerModelActivityState {
  if (value === 'loading' || value === 'running' || value === 'error') return value
  return value === true ? 'running' : 'idle'
}

const hasOpponentAnalysisResult = computed(() => (
  hasShantenRows(shantenPredData.value)
  || hasShantenRows(ronWaitPredData.value)
  || hasShantenRows(shantenGTData.value)
  || hasShantenRows(ronWaitGTData.value)
))
const opponentAnalysisLoadError = computed(() => {
  const modelError = status.modelActivity?.errors?.opponentAnalysis
  if (modelError) return String(modelError)
  return shantenStatus.value.startsWith('err:') ? shantenStatus.value.slice(4).trim() : ''
})
const opponentAnalysisPermanentlyUnavailable = computed(() => (
  status.modelRuntime.opponentAnalysis.unloaded
  || normalizeModelActivityState(status.modelActivity?.opponentAnalysis) === 'error'
))
const opponentAnalysisIsLoading = computed(() => {
  const activity = normalizeModelActivityState(status.modelActivity?.opponentAnalysis)
  if (status.modelRuntime.opponentAnalysis.unloaded) return false
  if (activity === 'loading') return true
  if (activity === 'error' || opponentAnalysisLoadError.value) return false
  return !hasOpponentAnalysisResult.value
})

const engineStatusItems = computed(() => {
  const controlledSeat = status.controlledSeat
  const decision = (status.modelActivity?.decision || []).map(normalizeModelActivityState)
  const errors = status.modelActivity?.errors
  const performance = status.modelPerformance || {
    decision: [0, 0, 0, 0],
    opponentAnalysis: 0,
  }
  const statePriority: TrainerModelActivityState[] = ['error', 'loading', 'running', 'idle']
  const decisionState = statePriority.find((state) => decision.includes(state)) || 'idle'
  const relativeNames = [t('seat.self'), t('seat.shimocha'), t('seat.toimen'), t('seat.kamicha')]
  const activeRoles = relativeNames.filter((_, offset) => (
    decision[(controlledSeat + offset) % 4] === 'running'
    || decision[(controlledSeat + offset) % 4] === 'loading'
  ))
  const decisionErrors = [...new Set((errors?.decision || []).filter(Boolean))] as string[]
  const decisionTimings = (performance.decision || []).filter((value) => Number.isFinite(value) && value > 0)
  const decisionAverage = decisionTimings.length
    ? decisionTimings.reduce((sum, value) => sum + value, 0) / decisionTimings.length
    : 0
  return settings.engines.profiles.flatMap((profile) => {
    const decisionRuntime = profileRuntimeState(profile, 'decision')
    const opponentRuntime = profileRuntimeState(profile, 'opponent')
    const kinds = new Set<EngineRuntimeKind>()
    if (decisionRuntime && !decisionRuntime.unloaded) kinds.add('decision')
    if (opponentRuntime && !opponentRuntime.unloaded) kinds.add('opponent')
    if (loadingEngineProfileId.value === profile.id) {
      for (const kind of profileRuntimeKinds(profile)) kinds.add(kind)
    }
    const localError = engineLoadErrors[profile.id] || ''
    if (!kinds.size && !localError) return []

    const states: TrainerModelActivityState[] = []
    const timingValues: number[] = []
    const errorValues: string[] = localError ? [localError] : []
    if (kinds.has('decision')) {
      states.push(decisionState)
      if (decisionAverage > 0) timingValues.push(decisionAverage)
      errorValues.push(...decisionErrors)
    }
    if (kinds.has('opponent')) {
      states.push(normalizeModelActivityState(status.modelActivity?.opponentAnalysis))
      if (Number.isFinite(performance.opponentAnalysis) && performance.opponentAnalysis > 0) {
        timingValues.push(performance.opponentAnalysis)
      }
      if (errors?.opponentAnalysis) errorValues.push(String(errors.opponentAnalysis))
    }
    if (loadingEngineProfileId.value === profile.id) states.push('loading')
    if (errorValues.some(Boolean)) states.push('error')
    const state = statePriority.find((candidate) => states.includes(candidate)) || 'idle'
    const averageMs = timingValues.length
      ? timingValues.reduce((sum, value) => sum + value, 0) / timingValues.length
      : 0
    const roleLabel = kinds.has('decision') && activeRoles.length
      ? ` · ${activeRoles.join(t('common.listSeparator'))}`
      : ''
    const baseLabel = `${profile.name || t('common.unnamedEngine')}${roleLabel}`
    const uniqueErrors = [...new Set(errorValues.filter(Boolean))]
    return [{
      id: profile.id,
      label: state === 'error' && uniqueErrors.length
        ? `${baseLabel}：${uniqueErrors.join('；')}`
        : averageMs > 0
          ? t('status.recentAverage', { engine: baseLabel, value: averageMs.toFixed(1) })
          : baseLabel,
      state,
    }]
  })
})
const hoveredModelStatusLabel = computed(() => (
  engineStatusItems.value.find((item) => item.id === hoveredModelStatusId.value)?.label || ''
))
const quickThinkingDragValue = ref<number | null>(null)
const quickVolumeDragValue = ref<number | null>(null)
const currentTrainingMode = computed(() => normalizeTrainingMode(settings.training.mode))
const relativeSeatOptions = computed(() => ([
  { label: t('seat.kamicha'), seat: (status.controlledSeat + 3) % 4 },
  { label: t('seat.self'), seat: status.controlledSeat },
  { label: t('seat.shimocha'), seat: (status.controlledSeat + 1) % 4 },
  { label: t('seat.toimen'), seat: (status.controlledSeat + 2) % 4 },
]))
const quickThinkingMaxValue = computed(() => quickThinkingDragValue.value ?? settings.training.thinkingTimeMaxS)
const quickAudioVolumeValue = computed(() => quickVolumeDragValue.value ?? settings.audio.volume)
const quickMaxThinkingPercent = computed(() => Math.max(0, Math.min(100, (quickThinkingMaxValue.value / 4) * 100)))
const quickAudioVolumePercent = computed(() => Math.max(0, Math.min(100, quickAudioVolumeValue.value)))
const quickMinThinkingPercent = computed(() => Math.max(0, Math.min(100, (settings.training.thinkingTimeMinS / 4) * 100)))
const quickAutoAdvancePercent = computed(() => Math.max(0, Math.min(100, ((settings.modeDefaults.autoAdvanceDelayMs / 1000) / 4) * 100)))
const quickMaxThinkingLabel = computed(() => `${quickThinkingMaxValue.value.toFixed(2)}s`)
const quickAudioVolumeLabel = computed(() => `${Math.round(quickAudioVolumeValue.value)}`)
const quickMinThinkingLabel = computed(() => `${settings.training.thinkingTimeMinS.toFixed(2)}s`)
const quickAutoAdvanceLabel = computed(() => `${(settings.modeDefaults.autoAdvanceDelayMs / 1000).toFixed(2)}s`)
const actionAnnouncementTimer = ref<number | null>(null)
const actionAnnouncement = reactive({
  key: '',
  text: '',
  position: 'south',
  visible: false,
})
const bootstrapError = ref('')
const activeAudioPlayers = new Set<HTMLAudioElement>()

const isReadOnlyRecord = computed(() => Boolean(gameView.readOnly))
const READ_ONLY_RECORD_HINT = computed(() => t('mode.readOnlyHint'))

const modeButtonLabel = computed(() => {
  if (isReadOnlyRecord.value) return t('mode.readOnlyResearch')
  return status.mode === 'play' ? t('mode.enterResearch') : t('mode.enterPlay')
})

const visibleHandsToggleLabel = computed(() => (
  status.visibleHands ? t('mode.hideHands') : t('mode.showHands')
))


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

interface YakuDisplayMeta {
  closedHan: number
  openHan: number
  isYakuman?: boolean
}

interface ResultYakuItem {
  name: string
  label: string
  han: number
  isYakuman: boolean
}

const YAKU_DISPLAY_META: Record<string, YakuDisplayMeta> = {
  'Menzen Tsumo': { closedHan: 1, openHan: 0 },
  Riichi: { closedHan: 1, openHan: 0 },
  Ippatsu: { closedHan: 1, openHan: 0 },
  Pinfu: { closedHan: 1, openHan: 0 },
  Tanyao: { closedHan: 1, openHan: 1 },
  Iipeiko: { closedHan: 1, openHan: 0 },
  'Yakuhai (haku)': { closedHan: 1, openHan: 1 },
  'Yakuhai (hatsu)': { closedHan: 1, openHan: 1 },
  'Yakuhai (chun)': { closedHan: 1, openHan: 1 },
  'Yakuhai (seat wind east)': { closedHan: 1, openHan: 1 },
  'Yakuhai (seat wind south)': { closedHan: 1, openHan: 1 },
  'Yakuhai (seat wind west)': { closedHan: 1, openHan: 1 },
  'Yakuhai (seat wind north)': { closedHan: 1, openHan: 1 },
  'Yakuhai (round wind east)': { closedHan: 1, openHan: 1 },
  'Yakuhai (round wind south)': { closedHan: 1, openHan: 1 },
  'Yakuhai (round wind west)': { closedHan: 1, openHan: 1 },
  'Yakuhai (round wind north)': { closedHan: 1, openHan: 1 },
  'Rinshan Kaihou': { closedHan: 1, openHan: 1 },
  Chankan: { closedHan: 1, openHan: 1 },
  'Haitei Raoyue': { closedHan: 1, openHan: 1 },
  'Houtei Raoyui': { closedHan: 1, openHan: 1 },
  'Double Riichi': { closedHan: 2, openHan: 0 },
  'Open Riichi': { closedHan: 2, openHan: 0 },
  'Double Open Riichi': { closedHan: 3, openHan: 0 },
  Chiitoitsu: { closedHan: 2, openHan: 0 },
  Chantai: { closedHan: 2, openHan: 1 },
  Ittsu: { closedHan: 2, openHan: 1 },
  'Sanshoku Doujun': { closedHan: 2, openHan: 1 },
  'Sanshoku Doukou': { closedHan: 2, openHan: 2 },
  'San Ankou': { closedHan: 2, openHan: 2 },
  'San Kantsu': { closedHan: 2, openHan: 2 },
  Toitoi: { closedHan: 2, openHan: 2 },
  Honroutou: { closedHan: 2, openHan: 2 },
  'Shou Sangen': { closedHan: 2, openHan: 2 },
  Honitsu: { closedHan: 3, openHan: 2 },
  Junchan: { closedHan: 3, openHan: 2 },
  Ryanpeikou: { closedHan: 3, openHan: 0 },
  Chinitsu: { closedHan: 6, openHan: 5 },
  Renhou: { closedHan: 5, openHan: 0 },
  'Nagashi Mangan': { closedHan: 5, openHan: 5 },
  Dora: { closedHan: 0, openHan: 0 },
  'Aka Dora': { closedHan: 0, openHan: 0 },
  'Ura Dora': { closedHan: 0, openHan: 0 },
  'Kokushi Musou': { closedHan: 13, openHan: 0, isYakuman: true },
  'Suu Ankou': { closedHan: 13, openHan: 0, isYakuman: true },
  Daisangen: { closedHan: 13, openHan: 13, isYakuman: true },
  Shousuushii: { closedHan: 13, openHan: 13, isYakuman: true },
  Ryuuiisou: { closedHan: 13, openHan: 13, isYakuman: true },
  'Suu Kantsu': { closedHan: 13, openHan: 13, isYakuman: true },
  'Tsuu Iisou': { closedHan: 13, openHan: 13, isYakuman: true },
  Chinroutou: { closedHan: 13, openHan: 13, isYakuman: true },
  'Chuuren Poutou': { closedHan: 13, openHan: 0, isYakuman: true },
  Tenhou: { closedHan: 13, openHan: 0, isYakuman: true },
  Chiihou: { closedHan: 13, openHan: 0, isYakuman: true },
  Daisharin: { closedHan: 13, openHan: 0, isYakuman: true },
  Daichikurin: { closedHan: 13, openHan: 0, isYakuman: true },
  Daisuurin: { closedHan: 13, openHan: 0, isYakuman: true },
  Daichisei: { closedHan: 13, openHan: 0, isYakuman: true },
  Paarenchan: { closedHan: 13, openHan: 13, isYakuman: true },
  'Renhou (yakuman)': { closedHan: 13, openHan: 0, isYakuman: true },
  Sashikomi: { closedHan: 13, openHan: 13, isYakuman: true },
  'Kokushi Musou Juusanmen Matchi': { closedHan: 26, openHan: 0, isYakuman: true },
  'Suu Ankou Tanki': { closedHan: 26, openHan: 0, isYakuman: true },
  'Daburu Chuuren Poutou': { closedHan: 26, openHan: 0, isYakuman: true },
  'Dai Suushii': { closedHan: 26, openHan: 26, isYakuman: true },
}

function yakuMeta(name: string): YakuDisplayMeta | undefined {
  if (YAKU_DISPLAY_META[name]) return YAKU_DISPLAY_META[name]
  const countedBonus = name.match(/^(Dora|Aka Dora|Ura Dora)\s+(\d+)$/)
  if (!countedBonus) return undefined
  const base = YAKU_DISPLAY_META[countedBonus[1]]
  const han = Number(countedBonus[2])
  return base ? { ...base, closedHan: han, openHan: han } : undefined
}

function localizedYakuLabel(name: string, fallback: string): string {
  const baseName = name.replace(/^(Dora|Aka Dora|Ura Dora)\s+\d+$/, '$1')
  const key = `yaku.${baseName}`
  const translated = t(key)
  return translated === key ? fallback : translated
}

const resultIsOpenHand = computed(() => {
  const info = gameView.table?.resultInfo
  if (typeof info?.isOpenHand === 'boolean') return info.isOpenHand
  const actor = Number(info?.actor)
  if (!Number.isInteger(actor) || actor < 0 || actor > 3) return false
  return (gameView.table?.melds?.[actor] || []).some((meld) => String(meld.type || '') !== 'ankan')
})

const resultYakuItems = computed<ResultYakuItem[]>(() => {
  const info = gameView.table?.resultInfo
  if (!info) return []
  if (info.yakuDetails?.length) {
    return info.yakuDetails.map((item) => ({
      name: item.name,
      label: localizedYakuLabel(item.name, item.name),
      han: Number(item.han || 0),
      isYakuman: Boolean(item.isYakuman),
    }))
  }

  const items = (info.yaku || []).map((name) => {
    const meta = yakuMeta(name)
    return {
      name,
      label: localizedYakuLabel(name, name),
      han: resultIsOpenHand.value ? Number(meta?.openHan || 0) : Number(meta?.closedHan || 0),
      isYakuman: Boolean(meta?.isYakuman),
    }
  })
  const bonusItems = items.filter((item) => ['Dora', 'Aka Dora', 'Ura Dora'].includes(item.name))
  if (bonusItems.length === 1 && bonusItems[0].han === 0) {
    const knownHan = items.reduce((sum, item) => sum + item.han, 0)
    bonusItems[0].han = Math.max(0, Number(info.han || 0) - knownHan)
  }
  return items
})

const resultHasHora = computed(() => {
  const actor = Number(gameView.table?.resultInfo?.actor)
  return Number.isInteger(actor) && actor >= 0 && actor <= 3
})

function localizedResultTitle(value: unknown): string {
  const title = String(value || '').trim()
  const key = ({
    '终局': 'action.matchEnd',
    '終局': 'action.matchEnd',
    '进行中': 'result.inProgress',
    '進行中': 'result.inProgress',
    '流局': 'action.drawResult',
    '和牌': 'action.win',
    '和了': 'action.win',
  } as Record<string, string>)[title]
  return key ? t(key) : title
}

const resultIsMatchEnd = computed(() => (
  gameView.table?.resultInfo?.eventType === 'match_end'
))

const resultIsRiichiHora = computed(() => {
  const info = gameView.table?.resultInfo
  const actor = Number(info?.actor)
  if (!info || !Number.isInteger(actor) || actor < 0 || actor > 3) return false
  if (info.uraMarkers?.length) return true
  if (gameView.table?.riichiAccepted?.[actor]) return true
  return resultYakuItems.value.some((item) => (
    item.name === 'Riichi'
    || item.name === 'Double Riichi'
    || item.name === 'Open Riichi'
    || item.name === 'Double Open Riichi'
  ))
})

const resultDoraSlots = computed(() => {
  const indicators = gameView.table?.doraIndicators || []
  return Array.from({ length: 5 }, (_, index) => indicators[index] || '?')
})

const resultUraSlots = computed(() => {
  const info = gameView.table?.resultInfo
  const revealedDoraCount = Math.min(5, gameView.table?.doraIndicators?.length || 0)
  const indicators = info?.uraMarkers?.length
    ? info.uraMarkers
    : (gameView.table?.uraIndicators || [])
  return Array.from({ length: 5 }, (_, index) => (
    resultIsRiichiHora.value && index < revealedDoraCount
      ? indicators[index] || '?'
      : '?'
  ))
})

function formatResultYakuValue(yaku: ResultYakuItem): string {
  if (yaku.isYakuman) {
    const multiplier = Math.max(1, Math.round(yaku.han / 13))
    return multiplier > 1 ? t('result.multipleYakuman', { value: multiplier }) : t('result.yakuman')
  }
  return yaku.han > 0 ? t('result.han', { value: yaku.han }) : ''
}

const resultHanFuLabel = computed(() => {
  const info = gameView.table?.resultInfo
  if (!info || (!info.han && !info.fu)) return ''
  return t('result.hanFu', {
    han: Number(info.han || 0),
    fu: info.fu ? t('result.fu', { value: info.fu }) : '',
  })
})

function resultBasePoints(han: number, fu: number): number {
  if (han >= 13) return 8000 * Math.max(1, Math.floor(han / 13))
  if (han >= 11) return 6000
  if (han >= 8) return 4000
  if (han >= 6) return 3000
  if (han >= 5) return 2000
  const calculated = fu * (2 ** (han + 2))
  return Math.min(2000, (han === 4 && fu === 30) || (han === 3 && fu === 60) ? 2000 : calculated)
}

function ceilToHundred(value: number): number {
  return Math.ceil(value / 100) * 100
}

const resultPointsLabel = computed(() => {
  const info = gameView.table?.resultInfo
  if (!info) return ''
  const main = Number(info.cost?.main)
  const additional = Number(info.cost?.additional)
  if (Number.isFinite(main) && main > 0) {
    return String(Math.round(main + (Number.isFinite(additional) ? additional * 2 : 0)))
  }
  const actor = Number(info.actor)
  const target = Number(info.target)
  const han = Number(info.han || 0)
  const fu = Number(info.fu || 0)
  if (!Number.isInteger(actor) || actor < 0 || actor > 3 || han <= 0) return ''
  const basePoints = resultBasePoints(han, fu)
  const isDealer = actor === gameView.table?.dealer
  if (actor !== target) {
    return String(ceilToHundred(basePoints * (isDealer ? 6 : 4)))
  }
  const dealerPayment = ceilToHundred(basePoints * 2)
  const nonDealerPayment = ceilToHundred(basePoints)
  return String(isDealer ? dealerPayment * 3 : dealerPayment + nonDealerPayment * 2)
})

const RESULT_LEVEL_KEYS: Record<string, string> = {
  mangan: 'result.limit.mangan',
  'kiriage mangan': 'result.limit.mangan',
  'nagashi mangan': 'result.limit.nagashiMangan',
  haneman: 'result.limit.haneman',
  baiman: 'result.limit.baiman',
  sanbaiman: 'result.limit.sanbaiman',
  'kazoe sanbaiman': 'result.limit.kazoeSanbaiman',
  yakuman: 'result.yakuman',
  'kazoe yakuman': 'result.limit.kazoeYakuman',
  '2x yakuman': 'result.limit.doubleYakuman',
  '3x yakuman': 'result.limit.tripleYakuman',
  '4x yakuman': 'result.limit.fourYakuman',
  '5x yakuman': 'result.limit.fiveYakuman',
  '6x yakuman': 'result.limit.sixYakuman',
}

const resultHandLabel = computed(() => {
  const info = gameView.table?.resultInfo
  if (!info) return ''
  const level = String(info.cost?.yaku_level || '')
  if (level) return RESULT_LEVEL_KEYS[level] ? t(RESULT_LEVEL_KEYS[level]) : level
  const han = Number(info.han || 0)
  const fu = Number(info.fu || 0)
  if (han >= 13) return t('result.limit.kazoeYakuman')
  if (han >= 11) return t('result.limit.sanbaiman')
  if (han >= 8) return t('result.limit.baiman')
  if (han >= 6) return t('result.limit.haneman')
  if (resultBasePoints(han, fu) >= 2000) return t('result.limit.mangan')
  return ''
})

const resultScoreLayout = computed(() => {
  const info = gameView.table?.resultInfo
  const controlledSeat = status.controlledSeat
  const positions = [
    { position: 'toimen', offset: 2 },
    { position: 'kamicha', offset: 3 },
    { position: 'shimocha', offset: 1 },
    { position: 'self', offset: 0 },
  ] as const
  return positions.map(({ position, offset }) => {
    const seat = (controlledSeat + offset) % 4
    const after = Number(info?.scores?.[seat] ?? 0)
    const delta = Number(info?.deltas?.[seat] ?? 0)
    return {
      position,
      seat,
      label: relativeSeatLabel(seat),
      rank: Number(info?.ranks?.[seat] ?? seat + 1),
      before: after - delta,
      delta,
      after,
    }
  })
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

const tableSeatViews = computed(() => {
  const hands = gameView.table?.hands || []
  const rivers = gameView.table?.rivers || []
  const melds = gameView.table?.melds || []
  const pendingKan = gameView.table?.pendingKan || null
  const controlled = status.controlledSeat
  const order = [
    { seat: (controlled + 2) % 4, position: 'north' },
    { seat: (controlled + 3) % 4, position: 'west' },
    { seat: (controlled + 1) % 4, position: 'east' },
    { seat: controlled, position: 'south' },
  ]

  const displayMeldsForSeat = (seat: number, seatMelds: Array<Record<string, unknown>>) => {
    if (!pendingKan || pendingKan.source !== 'kakan' || Number(pendingKan.actor) !== seat) {
      return seatMelds
    }
    const targetPai = String(pendingKan.pai || '')
    let upgraded = false
    return seatMelds.map((meld) => {
      if (!upgraded && meld?.type === 'pon' && String(meld.pai || '') === targetPai) {
        upgraded = true
        return {
          ...meld,
          type: 'kakan',
          pai: targetPai,
        }
      }
      return meld
    })
  }

  return order.map((entry) => ({
    ...entry,
    hand: hands[entry.seat] || [],
    river: rivers[entry.seat] || [],
    melds: displayMeldsForSeat(entry.seat, (melds[entry.seat] || []) as Array<Record<string, unknown>>),
    riichiDeclared: gameView.table?.riichiDeclared?.[entry.seat] || false,
    riichiAccepted: gameView.table?.riichiAccepted?.[entry.seat] || false,
  }))
})

const southView = computed(() => tableSeatViews.value.find((sv) => sv.position === 'south'))
const northView = computed(() => tableSeatViews.value.find((sv) => sv.position === 'north'))
const eastView = computed(() => tableSeatViews.value.find((sv) => sv.position === 'east'))
const westView = computed(() => tableSeatViews.value.find((sv) => sv.position === 'west'))
interface HandParts {
  closed: string[]
  drawn: string | null
}

const HAND_DISCARD_GAP = '__hand_discard_gap__'
const HAND_SUIT_ORDER: Record<string, number> = { m: 0, p: 1, s: 2 }
const HAND_HONOR_ORDER: Record<string, number> = { E: 30, S: 31, W: 32, N: 33, P: 34, F: 35, C: 36 }

interface DiscardBarSlot {
  tile: string
  entry: TrainerGameView['analysis']['discardEntries'][number] | null
  isBest: boolean
  isDrawn: boolean
  isGap: boolean
}

const discardActions = computed(() => (
  gameView.legalActions.filter((action) => action.type === 'dahai')
))

const SPECIAL_ACTION_ORDER: Record<string, number> = {
  hora: 0,
  reach: 1,
  chi: 2,
  pon: 3,
  daiminkan: 4,
  ankan: 4,
  kakan: 4,
  ryukyoku: 5,
  none: Number.MAX_SAFE_INTEGER,
}

function chiSequenceStart(action: TrainerAction): number {
  const numbers = [action.pai, ...(action.consumed || [])]
    .filter((tile): tile is string => Boolean(tile))
    .map((tile) => Number(normalizeTileFamily(tile)[0]))
    .filter(Number.isFinite)
  return numbers.length ? Math.min(...numbers) : Number.MAX_SAFE_INTEGER
}

function compareSpecialActions(left: TrainerAction, right: TrainerAction): number {
  const typeOrder = (SPECIAL_ACTION_ORDER[left.type] ?? 6) - (SPECIAL_ACTION_ORDER[right.type] ?? 6)
  if (typeOrder !== 0) return typeOrder
  if (left.type === 'chi' && right.type === 'chi') {
    return chiSequenceStart(left) - chiSequenceStart(right)
  }
  return 0
}

const specialActions = computed(() => (
  gameView.legalActions.filter((action) => (
    action.type !== 'dahai'
    && !(action.type === 'reach' && gameView.table?.pendingRiichiSeat === status.controlledSeat)
  )).sort(compareSpecialActions)
))

const canToggleDecisionRecommendations = computed(() => status.mode === 'research')
const effectiveDecisionRecommendationsEnabled = computed(() => (
  status.mode === 'play' || decisionRecommendationsEnabled.value
))

const showTrainingRecommendations = computed(() => {
  if (!effectiveDecisionRecommendationsEnabled.value) return false
  if (status.mode === 'research') return true
  if (gameView.pendingReview) return true
  return normalizeTrainingMode(settings.training.mode) === 'preview_before_click'
})

const opponentAnalysisNeeded = computed(() => (
  showTrainingRecommendations.value || showAnalysisDock.value
))

watch(
  () => [showTrainingRecommendations.value, effectiveDecisionRecommendationsEnabled.value, status.mode] as const,
  async ([, decisionEnabled, mode], [, previousDecisionEnabled, previousMode]) => {
    const modeChanged = mode !== previousMode
    // The toggle performs its own view-refreshing sync; a second watcher request
    // would supersede that response and discard the restored cached analysis.
    if (decisionEnabled !== previousDecisionEnabled && !modeChanged) return
    if (await syncAnalysisVisibilityToBackend(modeChanged) && opponentAnalysisNeeded.value) {
      void fetchShantenOnce()
    }
  },
)

const showTreeComparisons = computed(() => (
  status.mode === 'research' || normalizeTrainingMode(settings.training.mode) !== 'no_review'
))

const centerDoraSlots = computed(() => {
  const indicators = gameView.table?.doraIndicators || []
  return Array.from({ length: 5 }, (_, index) => indicators[index] || '?')
})

const pendingDiscardEntry = computed(() => {
  const riichiDiscard = gameView.table?.pendingRiichiDiscard
  const pendingDiscard = gameView.table?.pendingDiscard
  return riichiDiscard || pendingDiscard || null
})

const pendingDiscardBySeat = computed<Record<number, { pai: string; tsumogiri: boolean; riichi: boolean } | null>>(() => {
  const result: Record<number, { pai: string; tsumogiri: boolean; riichi: boolean } | null> = { 0: null, 1: null, 2: null, 3: null }
  const pending = pendingDiscardEntry.value
  if (pending) {
    result[pending.actor] = { pai: pending.pai, tsumogiri: Boolean(pending.tsumogiri), riichi: Boolean(pending.riichi) }
  }
  return result
})

const southDiscardBarSlots = computed<DiscardBarSlot[]>(() => {
  const displayParts = southDisplayHandParts.value
  const visualSlots = [
    ...displayParts.closed.map((tile) => ({ tile, isDrawn: false })),
    ...(displayParts.drawn ? [{ tile: displayParts.drawn, isDrawn: true }] : []),
  ]
  const hand = visualSlots
    .filter(({ tile }) => tile !== HAND_DISCARD_GAP)
    .map(({ tile }) => tile)
  const handFamilyGroups = new Map<string, string[]>()
  hand.forEach((tile) => {
    const family = normalizeTileFamily(tile)
    const tiles = handFamilyGroups.get(family) || []
    tiles.push(tile)
    handFamilyGroups.set(family, tiles)
  })

  return visualSlots.map(({ tile, isDrawn }) => {
    const isGap = tile === HAND_DISCARD_GAP
    if (isGap) {
      return { tile, entry: null, isBest: false, isDrawn, isGap }
    }
    const familyTiles = handFamilyGroups.get(normalizeTileFamily(tile)) || [tile]
    const exactAction = discardActions.value.find((action) => (
      action.pai === tile && Boolean(action.tsumogiri) === isDrawn
    ))
    const familyAction = new Set(familyTiles).size === 1
      ? discardActions.value.find((action) => (
        normalizeTileFamily(action.pai || '') === normalizeTileFamily(tile)
        && Boolean(action.tsumogiri) === isDrawn
      ))
      : null
    const action = exactAction || familyAction || null
    const entry = action ? resolveDiscardEntry(action) : null
    const isBest = analysisEntryIsBest(entry)
    return { tile, entry, isBest, isDrawn, isGap }
  })
})

const southLaneStyle = computed(() => {
  const displayParts = southDisplayHandParts.value
  const count = displayParts.closed.length + (displayParts.drawn ? 1 : 0) || 13
  const drawnGap = displayParts.drawn ? 'calc(0.4 * var(--tile-w))' : '0px'
  return {
    '--south-hand-span': `calc(${count} * var(--tile-w) + ${drawnGap})`,
    '--south-base-span': `calc(${Math.max(count, 13)} * var(--tile-w) + ${drawnGap})`,
  }
})

interface TreeDotLayout {
  id: string
  x: number
  y: number
  fill: string
  isControlledAction: boolean
  isMainline: boolean
  shape: 'circle' | 'square'
}

interface TreeEdgeLayout {
  from: string
  to: string
  d: string
  isMainline: boolean
  minY: number
  maxY: number
}

interface GraphHitRegion<TDot> {
  dot: TDot
  x: number
  y: number
  width: number | '100%'
  height: number
}

function buildGraphHitRegions<TDot extends { id: string; x: number; y: number }>(
  dots: TDot[],
  rowHeight: number,
  horizontalRadius: (dot: TDot) => number,
): GraphHitRegion<TDot>[] {
  const dotsByRow = new Map<number, TDot[]>()
  dots.forEach((dot) => {
    const row = dotsByRow.get(dot.y) || []
    row.push(dot)
    dotsByRow.set(dot.y, row)
  })

  return Array.from(dotsByRow.entries())
    .sort(([yA], [yB]) => yA - yB)
    .flatMap(([, rowDots]) => {
      const ordered = rowDots.slice().sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))
      return ordered.map((dot, index) => {
        const nextDot = ordered[index + 1]
        const x = index === 0 ? 0 : Math.max(0, dot.x - horizontalRadius(dot))
        const nextX = nextDot ? Math.max(x, nextDot.x - horizontalRadius(nextDot)) : null
        return {
          dot,
          x,
          y: Math.max(0, dot.y - rowHeight / 2),
          width: nextX === null ? '100%' as const : nextX - x,
          height: rowHeight,
        }
      })
    })
}

function isControlledDecisionNode(node: TrainerTreeNode): boolean {
  return node.isDecision === true
    && Number(node.action?.actor ?? -1) === status.controlledSeat
}

const tableZoom = ref(1.0)
const treeUiScale = computed(() => uiScale.value)
const treeHoveredNodeId = ref<string | null>(null)
const TREE_COL_GAP = computed(() => 14 * treeUiScale.value)
const TREE_ROW_GAP = computed(() => 16 * treeUiScale.value)
const TREE_BASE_X = computed(() => 18 * treeUiScale.value)
const TREE_BASE_Y = computed(() => 14 * treeUiScale.value)
const ROUND_COL_GAP = computed(() => 18 * treeUiScale.value)
const ROUND_ROW_GAP = computed(() => 18 * treeUiScale.value)
const ROUND_BASE_X = computed(() => 18 * treeUiScale.value)
const ROUND_BASE_Y = computed(() => 12 * treeUiScale.value)
const treeBaseX = computed(() => TREE_BASE_X.value)

interface CachedTreeLayoutStatic {
  key: string
  dots: Array<{ id: string; x: number; y: number; col: number }>
  edges: Array<{ from: string; to: string; d: string; minY: number; maxY: number }>
}

const treeLayoutStaticCache = new Map<string, CachedTreeLayoutStatic>()

const treeNodeList = computed(() => {
  const rawNodes = gameView.tree?.nodes
  if (!rawNodes) return [] as TrainerTreeNode[]
  if (Array.isArray(rawNodes)) return rawNodes
  return Object.values(rawNodes)
})

const fullNodeMapById = computed(() => new Map(treeNodeList.value.map((node) => [node.id, node])))

const roundSummaryList = computed(() => gameView.tree?.rounds || [] as TrainerRoundSummary[])

const activeRoundRootId = computed(() => gameView.tree?.currentRoundRootId || null)

const roundTreeNodeList = computed(() => {
  const allowedIds = new Set(treeNodeList.value.map((node) => node.id))
  return treeNodeList.value
    .map((node) => ({
      ...node,
      parentId: node.parentId && allowedIds.has(node.parentId) ? node.parentId : null,
      children: node.children.filter((childId) => allowedIds.has(childId)),
      mainChildId: node.mainChildId && allowedIds.has(node.mainChildId) ? node.mainChildId : null,
    }))
    .sort((a, b) => (
      (a.roundDepth ?? a.depth) - (b.roundDepth ?? b.depth)
      || a.id.localeCompare(b.id)
    ))
})

const roundNodeMapById = computed(() => new Map(roundTreeNodeList.value.map((node) => [node.id, node])))

function getTreeLayoutCacheKey(nodes: TrainerTreeNode[], roundRootId: string) {
  const structure = nodes
    .map((node) => `${node.id}|${node.parentId || ''}|${node.mainChildId || ''}|${(node.children || []).join(',')}|${node.roundDepth ?? node.depth}`)
    .join(';')
  return `${roundRootId}::${treeUiScale.value.toFixed(3)}::${structure}`
}

function computeRoundTreeLayout(nodes: TrainerTreeNode[], roundRootId: string): CachedTreeLayoutStatic {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const rootNode = nodeMap.get(roundRootId)
  if (!rootNode) {
    return { key: `${roundRootId}::empty`, dots: [], edges: [] }
  }

  interface SideBranchSeed {
    childId: string
    parentNodeId: string
    encounterIndex: number
    siblingOrder: number
  }

  interface BranchPlacement {
    id: string
    startNodeId: string
    parentBranchId: string | null
    parentNodeId: string | null
    nodes: string[]
    startRow: number
    endRow: number
    actualStart: number
    reserveStart: number
    parentRow: number
    parentCol: number
    siblingOrder: number
    encounterIndex: number
    col: number
  }

  const branches: BranchPlacement[] = []
  const branchById = new Map<string, BranchPlacement>()
  const nodeBranchId = new Map<string, string>()
  let branchCounter = 0
  let encounterCounter = 0

  function collectBranchNodes(startNodeId: string, branchId: string) {
    const branchNodes: string[] = []
    let currentId = startNodeId
    while (currentId) {
      const node = nodeMap.get(currentId)
      if (!node) break
      branchNodes.push(node.id)
      nodeBranchId.set(node.id, branchId)
      currentId = node.mainChildId || ''
    }
    return branchNodes
  }

  function createBranch(startNodeId: string, parentBranchId: string, parentNodeId: string, encounterIndex: number, siblingOrder: number) {
    const startNode = nodeMap.get(startNodeId)
    if (!startNode) return

    const branchId = `branch-${branchCounter++}`
    const branchNodes = collectBranchNodes(startNodeId, branchId)
    const endDepth = nodeMap.get(branchNodes[branchNodes.length - 1])?.roundDepth ?? startNode.roundDepth ?? startNode.depth
    const parentNode = nodeMap.get(parentNodeId)
    const parentRow = parentNode ? (parentNode.roundDepth ?? parentNode.depth) : (startNode.roundDepth ?? startNode.depth)
    const startRow = startNode.roundDepth ?? startNode.depth

    const branch: BranchPlacement = {
      id: branchId,
      startNodeId,
      parentBranchId,
      parentNodeId,
      nodes: branchNodes,
      startRow,
      endRow: endDepth,
      actualStart: startRow,
      reserveStart: Math.max(1, startRow - 1),
      parentRow,
      parentCol: 0,
      siblingOrder,
      encounterIndex,
      col: -1,
    }

    branches.push(branch)
    branchById.set(branchId, branch)

    const sideSeeds: SideBranchSeed[] = []
    branchNodes.forEach((nodeId) => {
      const node = nodeMap.get(nodeId)
      if (!node) return
      const mainChildId = node.mainChildId
      node.children.forEach((childId, idx) => {
        if (childId !== mainChildId) {
          sideSeeds.push({
            childId,
            parentNodeId: node.id,
            encounterIndex: encounterCounter++,
            siblingOrder: idx,
          })
        }
      })
    })

    sideSeeds.forEach((seed) => {
      createBranch(seed.childId, branchId, seed.parentNodeId, seed.encounterIndex, seed.siblingOrder)
    })
  }

  const mainBranchId = 'branch-main'
  const mainBranchNodes = collectBranchNodes(roundRootId, mainBranchId)
  const mainStartRow = rootNode.roundDepth ?? rootNode.depth
  const mainEndRow = nodeMap.get(mainBranchNodes[mainBranchNodes.length - 1])?.roundDepth ?? mainStartRow
  const mainBranch: BranchPlacement = {
    id: mainBranchId,
    startNodeId: roundRootId,
    parentBranchId: null,
    parentNodeId: null,
    nodes: mainBranchNodes,
    startRow: mainStartRow,
    endRow: mainEndRow,
    actualStart: mainStartRow,
    reserveStart: Math.max(1, mainStartRow - 1),
    parentRow: mainStartRow,
    parentCol: 0,
    siblingOrder: -1,
    encounterIndex: -1,
    col: 0,
  }
  branches.push(mainBranch)
  branchById.set(mainBranchId, mainBranch)

  mainBranchNodes.forEach((nodeId) => {
    const node = nodeMap.get(nodeId)
    if (!node) return
    const mainChildId = node.mainChildId
    node.children.forEach((childId, idx) => {
      if (childId !== mainChildId) {
        createBranch(childId, mainBranchId, node.id, encounterCounter++, idx)
      }
    })
  })

  const nonMainBranches = branches
    .filter((branch) => branch.id !== mainBranchId)
    .sort((a, b) => (
      a.encounterIndex - b.encounterIndex
      || a.startRow - b.startRow
      || a.siblingOrder - b.siblingOrder
    ))

  interface HorizontalReservation {
    row: number
    colStart: number
    colEnd: number
  }

  const horizontalReservations: HorizontalReservation[] = []
  const assignedBranches: BranchPlacement[] = [mainBranch]

  function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
    return aStart <= bEnd && bStart <= aEnd
  }

  function isColumnLegal(branch: BranchPlacement, col: number) {
    for (const placed of assignedBranches) {
      if (placed.id === branch.id || placed.col !== col) continue
      if (intervalsOverlap(branch.reserveStart, branch.endRow, placed.reserveStart, placed.endRow)) {
        return false
      }
    }
    for (const horizontal of horizontalReservations) {
      if (horizontal.colStart <= col && col <= horizontal.colEnd) {
        if (branch.reserveStart <= horizontal.row && horizontal.row <= branch.endRow) {
          return false
        }
      }
    }
    return true
  }

  function isHorizontalLegal(branch: BranchPlacement, col: number) {
    for (const placed of assignedBranches) {
      if (placed.id === branch.id) continue
      if (placed.col <= branch.parentCol || placed.col > col) continue
      if (placed.actualStart <= branch.parentRow && branch.parentRow <= placed.endRow) {
        return false
      }
    }
    return true
  }

  function previousSiblingCol(branch: BranchPlacement) {
    let maxCol = branch.parentCol
    for (const placed of assignedBranches) {
      if (placed.parentNodeId !== branch.parentNodeId) continue
      if (placed.siblingOrder < branch.siblingOrder && placed.col > maxCol) {
        maxCol = placed.col
      }
    }
    return maxCol
  }

  function assignBranchColumns(index: number): boolean {
    if (index >= nonMainBranches.length) return true
    const branch = nonMainBranches[index]
    const parentBranch = branch.parentBranchId ? branchById.get(branch.parentBranchId) : mainBranch
    branch.parentCol = parentBranch?.col ?? 0
    const minCol = Math.max(branch.parentCol + 1, previousSiblingCol(branch) + 1)
    const maxCol = nonMainBranches.length + 1

    for (let col = minCol; col <= maxCol; col += 1) {
      if (!isColumnLegal(branch, col) || !isHorizontalLegal(branch, col)) continue
      branch.col = col
      assignedBranches.push(branch)
      horizontalReservations.push({
        row: branch.parentRow,
        colStart: branch.parentCol,
        colEnd: col,
      })
      if (assignBranchColumns(index + 1)) return true
      horizontalReservations.pop()
      assignedBranches.pop()
      branch.col = -1
    }
    return false
  }

  assignBranchColumns(0)

  const dots = nodes
    .sort((a, b) => (
      (a.roundDepth ?? a.depth) - (b.roundDepth ?? b.depth)
      || ((branchById.get(nodeBranchId.get(a.id) || '')?.col ?? 0) - (branchById.get(nodeBranchId.get(b.id) || '')?.col ?? 0))
      || a.id.localeCompare(b.id)
    ))
    .map((node) => {
      const col = branchById.get(nodeBranchId.get(node.id) || '')?.col ?? 0
      return {
        id: node.id,
        x: TREE_BASE_X.value + col * TREE_COL_GAP.value,
        y: TREE_BASE_Y.value + (((node.roundDepth ?? node.depth) - 1) * TREE_ROW_GAP.value),
        col,
      }
    })

  const placementMap = new Map(dots.map((dot) => [dot.id, dot]))
  const edges = nodes
    .map((node) => {
      if (!node.parentId || !placementMap.has(node.id) || !placementMap.has(node.parentId)) return null
      const parent = placementMap.get(node.parentId)!
      const child = placementMap.get(node.id)!
      return {
        from: node.parentId,
        to: node.id,
        d: parent.col === child.col
          ? `M ${parent.x} ${parent.y} L ${child.x} ${child.y}`
          : `M ${parent.x} ${parent.y} L ${child.x} ${parent.y} L ${child.x} ${child.y}`,
        minY: Math.min(parent.y, child.y),
        maxY: Math.max(parent.y, child.y),
      }
    })
    .filter(Boolean) as CachedTreeLayoutStatic['edges']

  return {
    key: getTreeLayoutCacheKey(nodes, roundRootId),
    dots,
    edges,
  }
}

const treeGraph = computed(() => {
  const nodes = roundTreeNodeList.value
  const roundRootId = activeRoundRootId.value
  if (!nodes.length || !roundRootId) {
    return { dots: [] as TreeDotLayout[], edges: [] as TreeEdgeLayout[] }
  }
  const cacheKey = getTreeLayoutCacheKey(nodes, roundRootId)
  let layout = treeLayoutStaticCache.get(cacheKey)
  if (!layout) {
    layout = computeRoundTreeLayout(nodes, roundRootId)
    treeLayoutStaticCache.set(cacheKey, layout)
    if (treeLayoutStaticCache.size > 12) {
      const firstKey = treeLayoutStaticCache.keys().next().value
      if (firstKey) treeLayoutStaticCache.delete(firstKey)
    }
  }

  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const placements = new Map(layout.dots.map((dot) => [dot.id, dot]))

  const mainlineIds = new Set<string>()
  let cursor = roundRootId
  while (cursor) {
    mainlineIds.add(cursor)
    const node = nodeMap.get(cursor)
    if (!node?.mainChildId) break
    cursor = node.mainChildId
  }

  const dots = nodes
    .map((node) => {
      const placement = placements.get(node.id)
      if (!placement) return null
      const isMainline = mainlineIds.has(node.id)
      const isRoundStart = node.id === roundRootId
      const isRoundTerminal = !!node.phase
        && ['round_result', 'match_end'].includes(node.phase)
        && !node.children.length
      const isControlledAction = isControlledDecisionNode(node)
      const threshold = settings.training.mistakeThreshold
      let fill = isControlledAction ? 'hsl(188, 35%, 44%)' : 'hsl(184, 8%, 46%)'
      if (isControlledAction && showTreeComparisons.value && node.comparison) {
        const c = node.comparison
        const bestP = c.bestProbability || 0
        const raw = bestP > 0
          ? Math.max(0, Math.min(1, c.chosenProbability / bestP))
          : (c.isBest ? 1 : 0)
        if (typeof raw === 'number' && isFinite(raw)) {
          const p = Math.max(0, Math.min(1, raw))
          if (p >= threshold) {
            const t = (p - threshold) / (1 - threshold || 0.001)
            const h = 60 + t * 60
            fill = `hsl(${h}, 70%, 45%)`
          } else {
            const t = p / (threshold || 0.001)
            const h = t * 60
            fill = `hsl(${h}, 75%, 48%)`
          }
        }
      }
      return {
        id: node.id,
        x: placement.x,
        y: placement.y,
        fill,
        isControlledAction,
        isMainline,
        shape: (isRoundStart || isRoundTerminal) ? 'square' : 'circle',
      }
    })
    .filter(Boolean) as TreeDotLayout[]

  const edges: TreeEdgeLayout[] = layout.edges.map((edge) => {
    const isMainlineEdge = mainlineIds.has(edge.to) && mainlineIds.has(edge.from)
    return {
      ...edge,
      isMainline: isMainlineEdge,
    }
  })

  return { dots, edges }
})

const treeDots = computed(() => treeGraph.value.dots)
const treeEdges = computed(() => treeGraph.value.edges)
const treeDotById = computed(() => new Map(treeDots.value.map((dot) => [dot.id, dot])))
const currentTreePathIds = computed(() => {
  const path = new Set<string>()
  let cursor = gameView.currentNodeId || activeRoundRootId.value || ''
  while (cursor) {
    const node = roundNodeMapById.value.get(cursor)
    if (!node) break
    path.add(cursor)
    cursor = node.parentId || ''
  }
  return path
})

const treeDisplayPathIds = computed(() => {
  const nodeMap = roundNodeMapById.value
  const hoveredId = treeHoveredNodeId.value
  const currentId = gameView.currentNodeId || activeRoundRootId.value || ''
  const anchorId = hoveredId && nodeMap.has(hoveredId) ? hoveredId : currentId
  const path = new Set<string>()
  const visited = new Set<string>()

  let cursor = anchorId
  while (cursor && !visited.has(cursor)) {
    const node = nodeMap.get(cursor)
    if (!node) break
    visited.add(cursor)
    path.add(cursor)
    cursor = node.parentId || ''
  }

  cursor = nodeMap.get(anchorId)?.mainChildId || ''
  while (cursor && !visited.has(cursor)) {
    const node = nodeMap.get(cursor)
    if (!node) break
    visited.add(cursor)
    path.add(cursor)
    cursor = node.mainChildId || ''
  }

  return path
})

interface TreeRowLayout {
  depth: number
  nodeId: string
  y: number
  label: string
  isControlledAction: boolean
}

function formatTreeRowAction(action?: Record<string, unknown> | null) {
  const label = formatTreeAction(action)
  const type = String(action?.type || '')
  return type === 'pon' || type === 'chi'
    ? label.replace(/\s+\([^)]*\)$/, '')
    : label
}

const treeRows = computed<TreeRowLayout[]>(() => {
  const displayPath = treeDisplayPathIds.value
  return roundTreeNodeList.value
    .filter((node) => displayPath.has(node.id))
    .map((node) => {
      const depth = node.roundDepth ?? node.depth
      const dot = treeDotById.value.get(node.id)
      return {
        depth,
        nodeId: node.id,
        y: dot?.y ?? TREE_BASE_Y.value + ((depth - 1) * TREE_ROW_GAP.value),
        label: formatTreeRowAction(node.action),
        isControlledAction: Boolean(dot?.isControlledAction),
      }
    })
    .sort((a, b) => a.depth - b.depth || a.nodeId.localeCompare(b.nodeId))
})

const treeRowActionLabels = computed(() => {
  const labels = Array.from(new Set(
    roundTreeNodeList.value.map((node) => formatTreeRowAction(node.action)),
  ))
  return labels.length ? labels : ['—']
})

const treeCanvasStyle = computed(() => ({
  '--tree-row-height': `${TREE_ROW_GAP.value}px`,
}))

function isCurrentTreeDot(dot: Pick<TreeDotLayout, 'id'>) {
  return dot.id === gameView.currentNodeId
}

function isCurrentTreeEdge(edge: Pick<TreeEdgeLayout, 'from' | 'to'>) {
  const path = currentTreePathIds.value
  return path.has(edge.from) && path.has(edge.to)
}

function treeEdgeStroke(edge: TreeEdgeLayout) {
  if (isCurrentTreeEdge(edge)) return 'rgba(232,246,243,0.88)'
  return edge.isMainline ? 'rgba(159,213,200,0.56)' : 'rgba(159,213,200,0.22)'
}

function treeEdgeWidth(edge: TreeEdgeLayout) {
  const base = isCurrentTreeEdge(edge) ? 2.2 : (edge.isMainline ? 1.5 : 1.2)
  return base * treeUiScale.value
}
const treeSvgW = computed(() => {
  const maxX = Math.max(36 * treeUiScale.value, ...treeDots.value.map((dot) => dot.x))
  return maxX + (20 * treeUiScale.value)
})
const treeSvgH = computed(() => {
  const maxY = Math.max(18 * treeUiScale.value, ...treeDots.value.map((dot) => dot.y))
  return maxY + (18 * treeUiScale.value)
})
const treeHitRegions = computed(() => buildGraphHitRegions(
  treeDots.value,
  TREE_ROW_GAP.value,
  treeDotHorizontalRadius,
))

const treeScrollEl = ref<HTMLElement | null>(null)
const treeViewport = reactive({
  top: 0,
  height: 0,
})
const TREE_RENDER_BUFFER_PX = 160
let treeViewportRaf = 0
let treeAutoFollowSuspended = false

function updateTreeViewport() {
  const el = treeScrollEl.value
  if (!el) {
    treeViewport.top = 0
    treeViewport.height = 0
    return
  }
  treeViewport.top = el.scrollTop
  treeViewport.height = el.clientHeight
}

function onTreeScroll() {
  treeHoveredNodeId.value = null
  if (treeViewportRaf) return
  treeViewportRaf = window.requestAnimationFrame(() => {
    treeViewportRaf = 0
    updateTreeViewport()
  })
}

function keepCurrentTreeDotVisible() {
  const container = treeScrollEl.value
  const currentDot = gameView.currentNodeId ? treeDotById.value.get(gameView.currentNodeId) : null
  if (!container || !currentDot) return
  const padding = 18
  const viewTop = container.scrollTop
  const viewBottom = viewTop + container.clientHeight
  const dotTop = currentDot.y - padding
  const dotBottom = currentDot.y + padding
  if (dotTop < viewTop) {
    container.scrollTop = Math.max(0, dotTop)
  } else if (dotBottom > viewBottom) {
    container.scrollTop = Math.max(0, dotBottom - container.clientHeight)
  }
}

function suspendTreeAutoFollow() {
  treeAutoFollowSuspended = true
}

async function resumeTreeAutoFollow() {
  treeAutoFollowSuspended = false
  await nextTick()
  if (treeAutoFollowSuspended) return
  updateTreeViewport()
  keepCurrentTreeDotVisible()
}

const visibleTreeRange = computed(() => {
  const top = Math.max(0, treeViewport.top - TREE_RENDER_BUFFER_PX)
  const bottom = treeViewport.top + Math.max(treeViewport.height, 0) + TREE_RENDER_BUFFER_PX
  return { top, bottom }
})

const visibleTreeDots = computed(() => {
  const { top, bottom } = visibleTreeRange.value
  return treeDots.value.filter((dot) => dot.y >= top && dot.y <= bottom)
})

const visibleTreeHitRegions = computed(() => {
  const { top, bottom } = visibleTreeRange.value
  return treeHitRegions.value.filter((region) => (
    region.y + region.height >= top && region.y <= bottom
  ))
})

const visibleTreeEdges = computed(() => {
  const { top, bottom } = visibleTreeRange.value
  return treeEdges.value.filter((edge) => edge.maxY >= top && edge.minY <= bottom)
})

const visibleTreeRows = computed(() => {
  const { top, bottom } = visibleTreeRange.value
  return treeRows.value.filter((row) => row.y >= top && row.y <= bottom)
})

interface RoundMapDotLayout {
  id: string
  x: number
  y: number
  fill: string
  isCurrent: boolean
  isMainline: boolean
}

interface RoundMapEdgeLayout {
  from: string
  to: string
  d: string
  stroke: string
  width: number
}

const roundMapOverlayOpen = ref(false)
const roundMapHoveredRoundId = ref<string | null>(null)

const roundRootNodeList = computed(() => (
  roundSummaryList.value
    .slice()
    .sort((a, b) => (
      (a.roundIndex ?? 0) - (b.roundIndex ?? 0)
      || (a.honba ?? 0) - (b.honba ?? 0)
      || a.depth - b.depth
      || a.id.localeCompare(b.id)
    ))
))

function roundSlotKey(node: TrainerTreeNode) {
  return `${node.roundIndex ?? -1}:${node.honba ?? 0}`
}

function roundNodeLabel(node: TrainerTreeNode) {
  const bakaze = roundWindLabel(node.bakaze || 'E')
  const kyoku = node.kyoku ?? 0
  const honba = node.honba ?? 0
  return honba > 0 ? `${bakaze}${kyoku}-${honba}` : `${bakaze}${kyoku}`
}

const roundMapRowMeta = computed(() => {
  const uniqueSlots = new Map<string, { key: string; label: string; roundIndex: number; honba: number }>()
  roundRootNodeList.value.forEach((node) => {
    const key = roundSlotKey(node)
    if (!uniqueSlots.has(key)) {
      uniqueSlots.set(key, {
        key,
        label: roundNodeLabel(node),
        roundIndex: node.roundIndex ?? 0,
        honba: node.honba ?? 0,
      })
    }
  })
  const ordered = Array.from(uniqueSlots.values()).sort((a, b) => (
    a.roundIndex - b.roundIndex
    || a.honba - b.honba
    || a.key.localeCompare(b.key)
  ))
  const rowByKey = new Map<string, number>()
  ordered.forEach((slot, index) => rowByKey.set(slot.key, index))
  return { ordered, rowByKey }
})

const roundRootById = computed(() => new Map(roundRootNodeList.value.map((node) => [node.id, node])))

const roundMapHoveredRound = computed(() => (
  roundMapHoveredRoundId.value
    ? roundRootById.value.get(roundMapHoveredRoundId.value) || null
    : null
))

const roundMapCurrentBranchTail = computed(() => {
  let currentId = activeRoundRootId.value
    || roundRootNodeList.value.find((round) => round.isCurrent)?.id
    || roundRootNodeList.value[0]?.id
    || null
  const visited = new Set<string>()
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const round = roundRootById.value.get(currentId)
    const nextId = round?.mainNextRoundId || null
    if (!nextId || !roundRootById.value.has(nextId)) return round || null
    currentId = nextId
  }
  return currentId ? roundRootById.value.get(currentId) || null : null
})

const roundMapSettlementRound = computed(() => (
  roundMapHoveredRound.value || roundMapCurrentBranchTail.value
))

const roundMapSettlementRoundLabel = computed(() => {
  const round = roundMapSettlementRound.value
  if (!round) return ''
  const kyotaku = Math.max(0, Number(round.kyotaku || 0)) * 1000
  const showKyotaku = Boolean(roundMapHoveredRound.value && round.resultInfo)
  return `${roundNodeLabel(round)}${showKyotaku && kyotaku > 0 ? `　+${kyotaku}` : ''}`
})

const roundMapSettlementTitle = computed(() => {
  const round = roundMapSettlementRound.value
  if (!round) return ''
  const isTerminal = Boolean(round.matchEndInfo) || round.tailPhase === 'match_end'
  if (!roundMapHoveredRound.value) {
    return isTerminal ? t('action.matchEnd') : t('result.inProgress')
  }
  return localizedResultTitle(round.resultInfo?.title)
    || (isTerminal ? t('action.matchEnd') : t('result.inProgress'))
})

const roundMapSettlementLayout = computed(() => {
  const round = roundMapSettlementRound.value
  const hoveringRound = Boolean(roundMapHoveredRound.value)
  const info = hoveringRound ? round?.resultInfo : round?.matchEndInfo
  const scores = info?.scores || round?.tailScores || round?.scores || []
  const hasScores = scores.length >= 4
  const showDelta = Boolean(hoveringRound && info)
  const controlledSeat = status.controlledSeat
  const positions = [
    { position: 'toimen', offset: 2 },
    { position: 'kamicha', offset: 3 },
    { position: 'shimocha', offset: 1 },
    { position: 'self', offset: 0 },
  ] as const
  return positions.map(({ position, offset }) => {
    const seat = (controlledSeat + offset) % 4
    const after = Number(scores[seat] ?? 0)
    const delta = Number(info?.deltas?.[seat] ?? 0)
    return {
      position,
      seat,
      label: relativeSeatLabel(seat),
      hasScores,
      showDelta,
      rank: info?.ranks?.[seat] === undefined ? null : Number(info.ranks[seat]),
      before: after - delta,
      delta,
      after,
    }
  })
})

const roundGraphMeta = computed(() => {
  if (!roundMapOverlayOpen.value) {
    return {
      childRoundIds: new Map<string, string[]>(),
      parentRoundId: new Map<string, string | null>(),
      mainNextRoundId: new Map<string, string | null>(),
      rootRoundId: null as string | null,
    }
  }
  const childRoundIds = new Map<string, string[]>()
  const parentRoundId = new Map<string, string | null>()
  const mainNextRoundId = new Map<string, string | null>()
  roundRootNodeList.value.forEach((roundRoot) => {
    const nextRoundIds = roundRoot.childRoundIds || []
    childRoundIds.set(roundRoot.id, nextRoundIds)
    nextRoundIds.forEach((childRoundId) => {
      if (!parentRoundId.has(childRoundId)) parentRoundId.set(childRoundId, roundRoot.id)
    })
    mainNextRoundId.set(roundRoot.id, roundRoot.mainNextRoundId || null)
  })

  const rootRoundId = roundRootNodeList.value.find((node) => !parentRoundId.has(node.id))?.id || roundRootNodeList.value[0]?.id || null
  return { childRoundIds, parentRoundId, mainNextRoundId, rootRoundId }
})

const roundMapGraph = computed(() => {
  if (!roundMapOverlayOpen.value) {
    return { dots: [] as RoundMapDotLayout[], edges: [] as RoundMapEdgeLayout[], rows: [] as Array<{ key: string; label: string; y: number }> }
  }
  const roundNodes = roundRootNodeList.value
  const { rowByKey, ordered } = roundMapRowMeta.value
  const { childRoundIds, parentRoundId, mainNextRoundId, rootRoundId } = roundGraphMeta.value
  if (!roundNodes.length || !rootRoundId) {
    return { dots: [] as RoundMapDotLayout[], edges: [] as RoundMapEdgeLayout[], rows: [] as Array<{ key: string; label: string; y: number }> }
  }

  const roundNodeMap = roundRootById.value

  interface RoundBranch {
    id: string
    startRoundId: string
    parentBranchId: string | null
    parentRoundId: string | null
    nodes: string[]
    startRow: number
    endRow: number
    reserveStart: number
    parentRow: number
    parentCol: number
    siblingOrder: number
    encounterIndex: number
    col: number
  }

  const branches: RoundBranch[] = []
  const branchById = new Map<string, RoundBranch>()
  const nodeBranchId = new Map<string, string>()
  let branchCounter = 0
  let encounterCounter = 0

  function nodeRow(roundNodeId: string) {
    const roundNode = roundNodeMap.get(roundNodeId)
    return (roundNode ? (rowByKey.get(roundSlotKey(roundNode)) ?? 0) : 0) + 1
  }

  function collectBranchNodes(startRoundId: string, branchId: string) {
    const branchNodes: string[] = []
    let cursorId: string | null = startRoundId
    while (cursorId && roundNodeMap.has(cursorId)) {
      branchNodes.push(cursorId)
      nodeBranchId.set(cursorId, branchId)
      const nextRoundId = mainNextRoundId.get(cursorId) || null
      if (!nextRoundId) break
      cursorId = nextRoundId
    }
    return branchNodes
  }

  function createBranch(startRoundId: string, parentBranchId: string, parentRoundId: string, encounterIndex: number, siblingOrder: number) {
    if (!roundNodeMap.has(startRoundId)) return
    const branchId = `round-branch-${branchCounter++}`
    const branchNodes = collectBranchNodes(startRoundId, branchId)
    const branch: RoundBranch = {
      id: branchId,
      startRoundId,
      parentBranchId,
      parentRoundId,
      nodes: branchNodes,
      startRow: nodeRow(startRoundId),
      endRow: nodeRow(branchNodes[branchNodes.length - 1]),
      reserveStart: Math.max(1, nodeRow(startRoundId) - 1),
      parentRow: nodeRow(parentRoundId),
      parentCol: 0,
      siblingOrder,
      encounterIndex,
      col: -1,
    }
    branches.push(branch)
    branchById.set(branchId, branch)

    branchNodes.forEach((roundId) => {
      const children = childRoundIds.get(roundId) || []
      const mainChild = mainNextRoundId.get(roundId) || null
      children.forEach((childId, idx) => {
        if (childId !== mainChild) createBranch(childId, branchId, roundId, encounterCounter++, idx)
      })
    })
  }

  const mainBranchId = 'round-branch-main'
  const mainBranchNodes = collectBranchNodes(rootRoundId, mainBranchId)
  const mainBranch: RoundBranch = {
    id: mainBranchId,
    startRoundId: rootRoundId,
    parentBranchId: null,
    parentRoundId: null,
    nodes: mainBranchNodes,
    startRow: nodeRow(rootRoundId),
    endRow: nodeRow(mainBranchNodes[mainBranchNodes.length - 1]),
    reserveStart: Math.max(1, nodeRow(rootRoundId) - 1),
    parentRow: nodeRow(rootRoundId),
    parentCol: 0,
    siblingOrder: -1,
    encounterIndex: -1,
    col: 0,
  }
  branches.push(mainBranch)
  branchById.set(mainBranchId, mainBranch)

  mainBranchNodes.forEach((roundId) => {
    const children = childRoundIds.get(roundId) || []
    const mainChild = mainNextRoundId.get(roundId) || null
    children.forEach((childId, idx) => {
      if (childId !== mainChild) createBranch(childId, mainBranchId, roundId, encounterCounter++, idx)
    })
  })

  const nonMainBranches = branches
    .filter((branch) => branch.id !== mainBranchId)
    .sort((a, b) => a.encounterIndex - b.encounterIndex || a.startRow - b.startRow || a.siblingOrder - b.siblingOrder)

  interface HorizontalReservation { row: number; colStart: number; colEnd: number }
  const horizontalReservations: HorizontalReservation[] = []
  const assignedBranches: RoundBranch[] = [mainBranch]

  function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
    return aStart <= bEnd && bStart <= aEnd
  }

  function isColumnLegal(branch: RoundBranch, col: number) {
    for (const placed of assignedBranches) {
      if (placed.id === branch.id || placed.col !== col) continue
      if (intervalsOverlap(branch.reserveStart, branch.endRow, placed.reserveStart, placed.endRow)) return false
    }
    for (const horizontal of horizontalReservations) {
      if (horizontal.colStart <= col && col <= horizontal.colEnd) {
        if (branch.reserveStart <= horizontal.row && horizontal.row <= branch.endRow) return false
      }
    }
    return true
  }

  function isHorizontalLegal(branch: RoundBranch, col: number) {
    for (const placed of assignedBranches) {
      if (placed.id === branch.id) continue
      if (placed.col <= branch.parentCol || placed.col > col) continue
      if (placed.startRow <= branch.parentRow && branch.parentRow <= placed.endRow) return false
    }
    return true
  }

  function previousSiblingCol(branch: RoundBranch) {
    let maxCol = branch.parentCol
    for (const placed of assignedBranches) {
      if (placed.parentRoundId !== branch.parentRoundId) continue
      if (placed.siblingOrder < branch.siblingOrder && placed.col > maxCol) maxCol = placed.col
    }
    return maxCol
  }

  function assignBranchColumns(index: number): boolean {
    if (index >= nonMainBranches.length) return true
    const branch = nonMainBranches[index]
    const parentBranch = branch.parentBranchId ? branchById.get(branch.parentBranchId) : mainBranch
    branch.parentCol = parentBranch?.col ?? 0
    const minCol = Math.max(branch.parentCol + 1, previousSiblingCol(branch) + 1)
    const maxCol = nonMainBranches.length + 1
    for (let col = minCol; col <= maxCol; col += 1) {
      if (!isColumnLegal(branch, col) || !isHorizontalLegal(branch, col)) continue
      branch.col = col
      assignedBranches.push(branch)
      horizontalReservations.push({ row: branch.parentRow, colStart: branch.parentCol, colEnd: col })
      if (assignBranchColumns(index + 1)) return true
      horizontalReservations.pop()
      assignedBranches.pop()
      branch.col = -1
    }
    return false
  }

  assignBranchColumns(0)

  const placements = new Map<string, { x: number; y: number; col: number }>()
  roundNodes.forEach((node) => {
    const col = branchById.get(nodeBranchId.get(node.id) || '')?.col ?? 0
    const row = rowByKey.get(roundSlotKey(node)) ?? 0
    placements.set(node.id, {
      x: ROUND_BASE_X.value + col * ROUND_COL_GAP.value,
      y: ROUND_BASE_Y.value + row * ROUND_ROW_GAP.value,
      col,
    })
  })

  const mainlineIds = new Set<string>()
  let cursor: string | null = rootRoundId
  while (cursor) {
    mainlineIds.add(cursor)
    cursor = mainNextRoundId.get(cursor) || null
  }

  const currentPathIds = new Set<string>()
  cursor = activeRoundRootId.value
  while (cursor) {
    currentPathIds.add(cursor)
    cursor = parentRoundId.get(cursor) || null
  }

  const dots = roundNodes.map((node) => {
    const placement = placements.get(node.id)!
    return {
      id: node.id,
      x: placement.x,
      y: placement.y,
      fill: 'hsl(188, 35%, 44%)',
      isCurrent: node.id === activeRoundRootId.value,
      isMainline: mainlineIds.has(node.id),
    }
  })

  const edges = roundNodes
    .map((node) => {
      const children = childRoundIds.get(node.id) || []
      return children.map((childId) => {
        const parent = placements.get(node.id)
        const child = placements.get(childId)
        if (!parent || !child) return null
        const isMainline = mainNextRoundId.get(node.id) === childId
        const isCurrentPath = currentPathIds.has(node.id) && currentPathIds.has(childId)
        return {
          from: node.id,
          to: childId,
          d: parent.col === child.col
            ? `M ${parent.x} ${parent.y} L ${child.x} ${child.y}`
            : `M ${parent.x} ${parent.y} L ${child.x} ${parent.y} L ${child.x} ${child.y}`,
          stroke: isCurrentPath
            ? 'rgba(232,246,243,0.88)'
            : (isMainline ? 'rgba(159,213,200,0.56)' : 'rgba(159,213,200,0.22)'),
          width: (isCurrentPath ? 2.2 : (isMainline ? 1.5 : 1.2)) * treeUiScale.value,
        }
      })
    })
    .flat()
    .filter(Boolean) as RoundMapEdgeLayout[]

  const rows = ordered.map((row, index) => ({
    ...row,
    y: ROUND_BASE_Y.value + index * ROUND_ROW_GAP.value,
  }))

  return { dots, edges, rows }
})

const roundMapDots = computed(() => roundMapGraph.value.dots)
const roundMapEdges = computed(() => roundMapGraph.value.edges)
const roundMapRows = computed(() => roundMapGraph.value.rows)
const roundMapSvgW = computed(() => Math.max(120 * treeUiScale.value, ...roundMapDots.value.map((dot) => dot.x)) + (24 * treeUiScale.value))
const roundMapSvgH = computed(() => Math.max(64 * treeUiScale.value, ...roundMapRows.value.map((row) => row.y)) + (16 * treeUiScale.value))
const roundMapHitRegions = computed(() => buildGraphHitRegions(
  roundMapDots.value,
  ROUND_ROW_GAP.value,
  roundMapDotRadius,
))

function treeDotRadius(dot: TreeDotLayout) {
  return (dot.isControlledAction ? 6 : 5) * treeUiScale.value
}

function treeSquareRadius(_dot: TreeDotLayout) {
  return 5 * treeUiScale.value
}

function treeDotHorizontalRadius(dot: TreeDotLayout) {
  return dot.shape === 'square' ? treeSquareRadius(dot) : treeDotRadius(dot)
}

const treeSquareCornerRadius = computed(() => 0.9 * treeUiScale.value)

function treeDotStrokeWidth(dot: TreeDotLayout) {
  const base = isCurrentTreeDot(dot) ? 1.5 : (dot.isMainline ? 0.8 : 0)
  return base * treeUiScale.value
}

function roundMapDotRadius(_dot: { isCurrent: boolean; isMainline: boolean }) {
  return 6 * treeUiScale.value
}

function roundMapDotStrokeWidth(dot: { isCurrent: boolean; isMainline: boolean }) {
  const base = dot.isCurrent ? 1.5 : (dot.isMainline ? 0.8 : 0)
  return base * treeUiScale.value
}

const nodeMapById = fullNodeMapById

interface NextMoveHint {
  type: 'dahai' | 'special'
  childNodeId: string
  isMainBranch: boolean
  pai?: string
  tsumogiri?: boolean
  actionType?: string
  actionVariant?: string
  consumed?: string[]
}

function normalizeSpecialActionVariant(actionType?: string, actionVariant?: string): string | undefined {
  if (actionVariant) return actionVariant
  return actionType === 'reach' ? 'declare' : undefined
}

const nextMoveHints = computed<NextMoveHint[]>(() => {
  const nodeId = gameView.currentNodeId
  if (!nodeId) return []
  const node = nodeMapById.value.get(nodeId)
  if (!node) return []
  const children = node.children || []
  if (!children.length) return []
  const mainChildId = node.mainChildId

  const hints: NextMoveHint[] = []
  for (const childId of children) {
    const child = nodeMapById.value.get(childId)
    if (!child || !child.action) continue
    const action = child.action as Record<string, unknown>
    const isMainBranch = childId === mainChildId

    if (action.type === 'dahai' && typeof action.pai === 'string' && Number(action.actor) === status.controlledSeat) {
      hints.push({
        type: 'dahai',
        childNodeId: childId,
        isMainBranch,
        pai: action.pai,
        tsumogiri: Boolean(action.tsumogiri),
      })
    } else if (
      typeof action.type === 'string'
      && Number(action.actor) === status.controlledSeat
    ) {
      hints.push({
        type: 'special',
        childNodeId: childId,
        isMainBranch,
        actionType: action.type,
        actionVariant: normalizeSpecialActionVariant(
          action.type,
          typeof action.variant === 'string' ? action.variant : undefined,
        ),
        consumed: Array.isArray(action.consumed) ? action.consumed.map(String) : [],
      })
    }
  }
  return hints
})

function getTileNextMoveHint(tile: string, fromDrawn: boolean): NextMoveHint | null {
  return nextMoveHints.value.find((hint) => (
    hint.type === 'dahai'
    && hint.pai === tile
    && Boolean(hint.tsumogiri) === fromDrawn
  )) || null
}

function getSpecialNextMoveHint(action: TrainerAction): NextMoveHint | null {
  const consumed = [...(action.consumed || [])].sort().join(',')
  return nextMoveHints.value.find(
    (hint) => (
      hint.type === 'special'
      && hint.actionType === action.type
      && hint.actionVariant === normalizeSpecialActionVariant(action.type, action.variant)
      && [...(hint.consumed || [])].sort().join(',') === consumed
    ),
  ) || null
}

function tileNextMoveClass(tile: string, fromDrawn: boolean): string {
  const hint = getTileNextMoveHint(tile, fromDrawn)
  if (!hint) return ''
  return hint.isMainBranch ? 'tile-next-main' : 'tile-next-side'
}

function specialNextMoveClass(action: TrainerAction): string {
  const hint = getSpecialNextMoveHint(action)
  if (!hint) return ''
  return hint.isMainBranch ? 'special-next-main' : 'special-next-side'
}

const branchReturnMap = ref<Record<string, string>>({})
const deleteNodeConfirmationId = ref<string | null>(null)
let deleteNodeConfirmationTimer: number | null = null
const nodeMutationRequestInFlight = ref(false)
const nodeCommentEl = ref<HTMLTextAreaElement | null>(null)
const nodeCommentDraft = ref('')
const nodeCommentLocalDrafts = new Map<string, string>()
const NODE_COMMENT_SAVE_DELAY_MS = 400
let nodeCommentSaveTimer: number | null = null
const pendingNodeComments = new Map<string, { key: string; nodeId: string; comment: string }>()
let nodeCommentSaveQueue: Promise<void> = Promise.resolve()
let wheelNavigationCursorNodeId: string | null = null
let wheelNavigationQueuedNodeId: string | null = null
let wheelNavigationQueuedDirection: GameViewTransitionDirection | null = null
let wheelNavigationRequestInFlight = false
let wheelNavigationGeneration = 0
let latestNavigationIntentId = 0

function cancelPendingWheelNavigation() {
  wheelNavigationQueuedNodeId = null
  wheelNavigationQueuedDirection = null
  wheelNavigationGeneration = 0
}

function nodeCommentKey(gameId: string | null | undefined, nodeId: string | null | undefined) {
  if (!gameId || !nodeId) return ''
  return `${gameId}\u0000${nodeId}`
}

function resizeNodeComment() {
  void nextTick(() => {
    const element = nodeCommentEl.value
    if (!element) return
    element.style.height = 'auto'
    const style = getComputedStyle(element)
    const maximum = Number.parseFloat(style.maxHeight)
    const borderHeight = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
    const naturalHeight = element.scrollHeight + borderHeight
    const height = Number.isFinite(maximum)
      ? Math.min(naturalHeight, maximum)
      : naturalHeight
    element.style.height = `${height}px`
    element.style.overflowY = Number.isFinite(maximum) && naturalHeight > maximum + 1
      ? 'auto'
      : 'hidden'
  })
}

function syncNodeCommentFromView(view: TrainerGameView) {
  const key = nodeCommentKey(view.gameId, view.currentNodeId)
  nodeCommentDraft.value = (key && nodeCommentLocalDrafts.has(key))
    ? nodeCommentLocalDrafts.get(key) || ''
    : String(view.nodeComment || '')
  resizeNodeComment()
}

function onNodeCommentInput() {
  const nodeId = gameView.currentNodeId
  const key = nodeCommentKey(gameView.gameId, nodeId)
  if (!nodeId || !key) return
  const comment = nodeCommentDraft.value
  nodeCommentLocalDrafts.set(key, comment)
  pendingNodeComments.set(key, { key, nodeId, comment })
  recordDirty.value = true
  resizeNodeComment()
  if (nodeCommentSaveTimer !== null) window.clearTimeout(nodeCommentSaveTimer)
  nodeCommentSaveTimer = window.setTimeout(() => {
    nodeCommentSaveTimer = null
    flushNodeCommentInBackground()
  }, NODE_COMMENT_SAVE_DELAY_MS)
}

function flushNodeComment(): Promise<void> {
  if (nodeCommentSaveTimer !== null) {
    window.clearTimeout(nodeCommentSaveTimer)
    nodeCommentSaveTimer = null
  }
  const updates = [...pendingNodeComments.values()]
  pendingNodeComments.clear()
  if (!updates.length || !window.trainerAPI?.setNodeComment) return nodeCommentSaveQueue

  const task = nodeCommentSaveQueue
    .catch(() => undefined)
    .then(async () => {
      for (let index = 0; index < updates.length; index += 1) {
        const update = updates[index]
        let response
        try {
          response = await window.trainerAPI!.setNodeComment(update.nodeId, update.comment)
        } catch (error) {
          for (const remaining of updates.slice(index)) {
            const current = nodeCommentLocalDrafts.get(remaining.key)
            if (current !== undefined) {
              pendingNodeComments.set(remaining.key, { ...remaining, comment: current })
            }
          }
          throw error
        }
        if (nodeCommentLocalDrafts.get(update.key) === update.comment) {
          nodeCommentLocalDrafts.delete(update.key)
        }
        if (
          gameView.currentNodeId === update.nodeId
          && nodeCommentKey(gameView.gameId, gameView.currentNodeId) === update.key
          && nodeCommentDraft.value === update.comment
        ) {
          nodeCommentDraft.value = response.comment
        }
      }
    })
  nodeCommentSaveQueue = task
  return task
}

function flushNodeCommentInBackground() {
  void flushNodeComment().catch((error) => {
    console.error('Failed to save node comment:', error)
  })
}

function discardNodeCommentDraft(nodeId: string) {
  const key = nodeCommentKey(gameView.gameId, nodeId)
  if (!key) return
  pendingNodeComments.delete(key)
  nodeCommentLocalDrafts.delete(key)
}

const canSetCurrentNodeAsMainBranch = computed(() => {
  if (isReadOnlyRecord.value) return false
  const nodeId = gameView.currentNodeId
  if (!nodeId) return false
  const node = nodeMapById.value.get(nodeId)
  return !!node && !!node.parentId
})

const canDeleteCurrentNode = computed(() => {
  if (isReadOnlyRecord.value) return false
  const nodeId = gameView.currentNodeId
  if (!nodeId) return false
  const node = nodeMapById.value.get(nodeId)
  return !!node?.parentId
})

const deleteNodeConfirmationPending = computed(() => {
  const nodeId = gameView.currentNodeId
  return Boolean(nodeId) && deleteNodeConfirmationId.value === nodeId
})

watch(() => gameView.currentNodeId, () => {
  deleteNodeConfirmationId.value = null
})

watch(deleteNodeConfirmationId, (nodeId) => {
  if (deleteNodeConfirmationTimer !== null) {
    window.clearTimeout(deleteNodeConfirmationTimer)
    deleteNodeConfirmationTimer = null
  }
  if (!nodeId) return
  deleteNodeConfirmationTimer = window.setTimeout(() => {
    if (deleteNodeConfirmationId.value === nodeId) {
      deleteNodeConfirmationId.value = null
    }
  }, DELETE_CONFIRMATION_TIMEOUT_MS)
})

async function setCurrentNodeAsMainBranch() {
  if (!window.trainerAPI || !gameView.currentNodeId || !canSetCurrentNodeAsMainBranch.value || nodeMutationRequestInFlight.value) return
  deleteNodeConfirmationId.value = null
  nodeMutationRequestInFlight.value = true
  try {
    const response = await window.trainerAPI.setMainBranch(gameView.currentNodeId)
    applyStatus(response.state)
    applyGameView(response.view)
  } finally {
    nodeMutationRequestInFlight.value = false
  }
}

async function deleteCurrentNode() {
  const nodeId = gameView.currentNodeId
  if (!window.trainerAPI || !nodeId || !canDeleteCurrentNode.value || nodeMutationRequestInFlight.value) return
  if (deleteNodeConfirmationId.value !== nodeId) {
    deleteNodeConfirmationId.value = nodeId
    return
  }

  nodeMutationRequestInFlight.value = true
  try {
    discardNodeCommentDraft(nodeId)
    const response = await window.trainerAPI.deleteNode(nodeId)
    cancelPendingWheelNavigation()
    branchReturnMap.value = {}
    applyStatus(response.state)
    applyGameView(response.view, 'backward')
  } finally {
    deleteNodeConfirmationId.value = null
    nodeMutationRequestInFlight.value = false
  }
}

function toggleRoundMapOverlay() {
  roundMapOverlayOpen.value = !roundMapOverlayOpen.value
  roundMapHoveredRoundId.value = null
  if (roundMapOverlayOpen.value) focusFloatingPanel('roundMap')
}

function closeRoundMapOverlay() {
  roundMapOverlayOpen.value = false
  roundMapHoveredRoundId.value = null
}

async function jumpToRoundRoot(roundRootId: string) {
  await jumpToNode(roundRootId)
}

function seatLabel(seat: number): string {
  return [t('seat.start.east'), t('seat.start.south'), t('seat.start.west'), t('seat.start.north')][seat]
    ?? t('seat.number', { seat })
}

function relativeSeatLabel(seat: number): string {
  const diff = (seat - status.controlledSeat + 4) % 4
  return [t('seat.self'), t('seat.shimocha'), t('seat.toimen'), t('seat.kamicha')][diff]
    ?? t('seat.number', { seat })
}

function seatWindLabel(seat: number): string {
  const dealer = gameView.table?.dealer ?? 0
  const windIndex = (seat - dealer + 4) % 4
  return [t('wind.east'), t('wind.south'), t('wind.west'), t('wind.north')][windIndex] ?? '?'
}

function isCurrentActorSeat(seat: number): boolean {
  if (['game_end', 'round_result', 'match_end'].includes(gameView.table?.phase || '')) return false
  return gameView.table?.currentActor === seat
}

function roundWindLabel(bakaze: string): string {
  return ({ E: t('wind.east'), S: t('wind.south'), W: t('wind.west'), N: t('wind.north') } as Record<string, string>)[bakaze] || bakaze
}

function tileFaceLabel(tile: string): string {
  if (!tile || tile === '?') return ' '
  const honorMap: Record<string, string> = {
    E: t('wind.east'), S: t('wind.south'), W: t('wind.west'), N: t('wind.north'),
    P: t('tile.white'), F: t('tile.green'), C: t('tile.red'),
  }
  if (honorMap[tile]) return honorMap[tile]
  const isRed = tile.endsWith('r')
  const base = isRed ? tile.slice(0, -1) : tile
  return isRed ? t('tile.redPrefix', { tile: base }) : base
}

function reactionTypeLabel(type: string): string {
  return {
    none: t('action.skip'),
    chi: t('action.chi'),
    chi_low: t('action.chi'),
    chi_mid: t('action.chi'),
    chi_high: t('action.chi'),
    pon: t('action.pon'),
    daiminkan: t('action.kan'),
    ankan: t('action.kan'),
    kakan: t('action.kan'),
    hora: t('action.ron'),
    reach: t('action.riichi'),
    reach_accepted: t('action.riichiAccepted'),
    dahai: t('action.discard'),
    tsumo: t('action.draw'),
    round_result: t('action.roundResult'),
    game_end: t('action.matchEnd'),
    match_end: t('action.matchEnd'),
    start_kyoku: t('action.roundStart'),
  }[type] || type
}

function ryukyokuActionLabel(action: Record<string, unknown>): string {
  const reason = String(action.reason || action.variant || '')
  const knownReasons: Record<string, string> = {
    exhaustive_draw: t('draw.exhaustive'),
    kyuushu_kyuuhai: t('draw.kyuushu'),
    suufon_renda: t('draw.suufon'),
    suukantsu: t('draw.suukantsu'),
    suucha_riichi: t('draw.suuchaRiichi'),
  }
  if (knownReasons[reason]) return knownReasons[reason]
  const reasonLabel = String(action.reasonLabel || '').trim()
  const knownLabels: Record<string, string> = {
    '': t('draw.exhaustive'),
    '流局': t('draw.exhaustive'),
    '荒牌流局': t('draw.exhaustive'),
    '九種九牌': t('draw.kyuushu'),
    '九种九牌': t('draw.kyuushu'),
    '四風連打': t('draw.suufon'),
    '四风连打': t('draw.suufon'),
    '四槓散了': t('draw.suukantsu'),
    '四杠散了': t('draw.suukantsu'),
    '四家立直': t('draw.suuchaRiichi'),
  }
  return knownLabels[reasonLabel] || reasonLabel
}

function specialActionLabel(action: TrainerAction): string {
  if (action.type === 'hora') {
    return action.variant === 'tsumo' ? t('action.tsumo') : t('action.ron')
  }
  if (action.type === 'ryukyoku') {
    return ryukyokuActionLabel(action as unknown as Record<string, unknown>)
  }
  if (action.type === 'reach') return t('action.riichi')
  if (action.type === 'none') return t('action.skip')
  if (action.type === 'chi') return t('action.chi')
  if (action.type === 'pon') return t('action.pon')
  if (action.type === 'daiminkan' || action.type === 'ankan' || action.type === 'kakan') return t('action.kan')
  return reactionTypeLabel(action.type)
}

function tileFaceClass(tile: string): string {
  if (!tile || tile === '?') return 'tile-back'
  if (['E', 'S', 'W', 'N', 'P', 'F', 'C'].includes(tile)) return `tile-honor tile-${tile}`
  const base = tile.replace('r', '')
  const suit = base[1]
  const red = tile.endsWith('r') ? ' tile-red' : ''
  return `tile-${suit}${red}`
}

function normalizeTileFamily(tile: string): string {
  return String(tile).replace('5mr', '5m').replace('5pr', '5p').replace('5sr', '5s').replace(/r$/, '')
}

function tileAssetName(tile: string): string {
  if (!tile || tile === '?') return 'back'
  const normalized = tile.replace('r', '')
  const honorMap: Record<string, string> = {
    E: '1z', S: '2z', W: '3z', N: '4z', P: '5z', F: '6z', C: '7z',
  }
  if (honorMap[normalized]) return honorMap[normalized]
  const rank = normalized[0]
  const suit = normalized[1]
  if (rank === '5' && tile.endsWith('r')) return `0${suit}`
  return `${rank}${suit}`
}

const tileAssetModules = import.meta.glob('./assets/tiles/Regular_shortnames/*.svg', {
  eager: true,
  import: 'default',
}) as Record<string, string>

const tileArtworkSources = Array.from(new Set(Object.values(tileAssetModules).filter(Boolean)))
let staticAssetsWarmupPromise: Promise<void> | null = null
const tileArtworkReady = ref(false)
const tileArtworkLoadedCount = ref(0)
const tileArtworkLoadingLabel = computed(() => (
  t('common.loadingProgress', { completed: tileArtworkLoadedCount.value, total: tileArtworkSources.length })
))
const preloadedTileImages: HTMLImageElement[] = []

function tileImageSrc(tile: string): string {
  const assetName = tileAssetName(tile)
  const assetPath = `./assets/tiles/Regular_shortnames/${assetName}.svg`
  return tileAssetModules[assetPath] || tileAssetModules['./assets/tiles/Regular_shortnames/back.svg']
}

const currentTableHistoryNodes = computed(() => {
  const nodes: TrainerTreeNode[] = []
  let cursor = gameView.currentNodeId || ''
  while (cursor) {
    const node = nodeMapById.value.get(cursor)
    if (!node) break
    nodes.push(node)
    cursor = node.parentId || ''
  }
  return nodes.reverse()
})

const tableActionNodeIndex = computed(() => buildTableActionNodeIndex(currentTableHistoryNodes.value))

function canJumpToHistoricalNode(nodeId: string | null | undefined): boolean {
  return status.mode === 'research' && Boolean(nodeId) && nodeId !== gameView.currentNodeId
}

function historicalJumpTitle(nodeId: string | null | undefined, _source: string): string | undefined {
  return canJumpToHistoricalNode(nodeId) ? t('action.doubleClickJump') : undefined
}

function jumpToHistoricalNode(nodeId: string | null | undefined) {
  if (!canJumpToHistoricalNode(nodeId) || !nodeId) return
  void jumpToNode(nodeId)
}

function meldNodeId(seat: number, meldIndex: number, layer: 'base' | 'kakan' = 'base'): string | null {
  const source = tableActionNodeIndex.value.meldNodeIdsBySeat[seat]?.[meldIndex]
  if (!source) return null
  return layer === 'kakan' ? source.kakanNodeId : source.baseNodeId
}

interface MeldDisplayTile { tile: string; isBack: boolean; tileClass: string; isKakan?: boolean }
interface RiverDisplaySlot {
  key: string
  tile: string
  sourceNodeId: string | null
  isPending: boolean
  isTsumogiri: boolean
  isClaimed: boolean
  isRiichiDiscard: boolean
}

function redFive(tile: string): string {
  if (tile === '5m') return '0m'
  if (tile === '5p') return '0p'
  if (tile === '5s') return '0s'
  return tile
}

function meldDisplayTiles(meld: Record<string, unknown>, actor: number): MeldDisplayTile[] {
  const consumed: string[] = Array.isArray(meld.consumed) ? meld.consumed.map((tile) => String(tile)) : []
  const pai = typeof meld.pai === 'string' ? meld.pai : ''
  const type = typeof meld.type === 'string' ? meld.type : ''
  const fromSeat: number | undefined = meld.from !== undefined ? Number(meld.from) : undefined

  if (type === 'ankan') {
    return consumed.map((tile, i) => {
      const isOuter = i === 0 || i === 3
      let displayTile = tile
      if (!isOuter && (tile === '5m' || tile === '5p' || tile === '5s')) {
        displayTile = redFive(tile)
      }
      return { tile: displayTile, isBack: isOuter, tileClass: '' }
    })
  }
  if (type === 'kakan') {
    const fromPon = fromSeat !== undefined ? (fromSeat - actor + 4) % 4 : -1
    let rotateIndex: number
    if (fromPon === 3) {
      rotateIndex = 0
    } else if (fromPon === 2) {
      rotateIndex = 1
    } else {
      rotateIndex = 2
    }
    return [pai, pai, pai].map((tile, i) => ({
      tile,
      isBack: false,
      tileClass: i === rotateIndex ? 'rotate' : '',
      isKakan: i === rotateIndex,
    }))
  }
  if (type === 'daiminkan') {
    const fromKan = fromSeat !== undefined ? (fromSeat - actor + 4) % 4 : -1
    let ordered: string[]
    let rotateIndex = 1
    if (fromKan === 3) {
      ordered = [pai, ...consumed]
      rotateIndex = 0
    } else if (fromKan === 2) {
      ordered = [consumed[0], pai, consumed[1], consumed[2]]
      rotateIndex = 1
    } else {
      ordered = [...consumed, pai]
      rotateIndex = 3
    }
    return ordered.map((tile, i) => ({
      tile,
      isBack: false,
      tileClass: i === rotateIndex ? 'rotate' : '',
    }))
  }
  if (type === 'chi' && fromSeat !== undefined) {
    const diff = (fromSeat - actor + 4) % 4
    let ordered: string[]
    let rotateIndex: number
    if (diff === 3) {
      ordered = [pai, consumed[0], consumed[1]]
      rotateIndex = 0
    } else if (diff === 2) {
      ordered = [consumed[0], pai, consumed[1]]
      rotateIndex = 1
    } else {
      ordered = [consumed[0], consumed[1], pai]
      rotateIndex = 2
    }
    return ordered.map((tile, i) => ({ tile, isBack: false, tileClass: i === rotateIndex ? 'rotate' : '' }))
  }
  if (type === 'pon') {
    const fromPon = fromSeat !== undefined ? (fromSeat - actor + 4) % 4 : -1
    let ordered: string[]
    let rotateIndex: number
    if (fromPon === 3) {
      ordered = [pai, consumed[0], consumed[1]]
      rotateIndex = 0
    } else if (fromPon === 2) {
      ordered = [consumed[0], pai, consumed[1]]
      rotateIndex = 1
    } else {
      ordered = [consumed[0], consumed[1], pai]
      rotateIndex = 2
    }
    return ordered.filter(Boolean).map((tile, i) => ({
      tile,
      isBack: false,
      tileClass: i === rotateIndex ? 'rotate' : '',
    }))
  }
  const tiles = [...consumed, pai].filter(Boolean)
  return tiles.map((tile, i) => ({ tile, isBack: false, tileClass: i === tiles.length - 1 ? 'rotate' : '' }))
}

function splitHandForView(view: { seat: number; hand: string[] } | undefined | null): HandParts {
  const hand = view?.hand || []
  if (!view) return { closed: [], drawn: null }
  const lastDraw = gameView.table?.lastDrawnSeat === view.seat ? (gameView.table?.lastDrawnTile || null) : null
  const history = gameView.table?.actionHistory || []
  const justDrew = (() => {
    for (let i = history.length - 1; i >= 0; i--) {
      const a = history[i] as Record<string, unknown>
      if (Number(a.actor) !== view.seat) continue
      const t = String(a.type || '')
      if (t === 'tsumo') return true
      if (t === 'dahai') return false
      // reach / pon / chi / kan / hora etc. don't change draw-vs-discard state
    }
    return false
  })()
  if (!justDrew) return { closed: [...hand], drawn: null }
  if (lastDraw) {
    let drawnIdx = hand.lastIndexOf(lastDraw)
    if (drawnIdx === -1 && hand.length % 3 === 2) drawnIdx = hand.length - 1
    if (drawnIdx === -1) return { closed: [...hand], drawn: null }
    const closed = [...hand]
    const [drawn] = closed.splice(drawnIdx, 1)
    return { closed, drawn: drawn || null }
  }
  if (hand.length % 3 === 2) return { closed: hand.slice(0, -1), drawn: hand[hand.length - 1] || null }
  return { closed: [...hand], drawn: null }
}

function compareHandTiles(left: string, right: string): number {
  if (left in HAND_HONOR_ORDER || right in HAND_HONOR_ORDER) {
    if (!(left in HAND_HONOR_ORDER)) return -1
    if (!(right in HAND_HONOR_ORDER)) return 1
    return HAND_HONOR_ORDER[left] - HAND_HONOR_ORDER[right]
  }
  const leftBase = left.replace('r', '')
  const rightBase = right.replace('r', '')
  const suitDelta = (HAND_SUIT_ORDER[leftBase[1]] ?? 9) - (HAND_SUIT_ORDER[rightBase[1]] ?? 9)
  if (suitDelta) return suitDelta
  const rankDelta = Number(leftBase[0]) - Number(rightBase[0])
  if (rankDelta) return rankDelta
  if (left.endsWith('r') !== right.endsWith('r')) return left.endsWith('r') ? 1 : -1
  return left.localeCompare(right)
}

function lastDrawBeforePendingDiscard(seat: number): string | null {
  const history = gameView.table?.actionHistory || []
  let skippedPendingDiscard = false
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const action = history[index]
    if (Number(action.actor ?? -1) !== seat) continue
    const type = String(action.type || '')
    if (type === 'dahai' && !skippedPendingDiscard) {
      skippedPendingDiscard = true
      continue
    }
    if (type === 'reach') continue
    if (type === 'tsumo') return String(action.pai || '') || null
    return null
  }
  return null
}

function deterministicGapIndex(seat: number, tile: string, slotCount: number): number {
  if (slotCount <= 1) return 0
  const table = gameView.table
  // State-derived randomness stays stable when the same node is rendered again.
  const seed = [
    gameView.gameId,
    table?.roundIndex,
    table?.honba,
    table?.drawIndex,
    table?.rivers?.[seat]?.length,
    seat,
    tile,
  ].join('|')
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % slotCount
}

function splitHandForDisplay(view: { seat: number; hand: string[] } | undefined | null): HandParts {
  if (!view) return { closed: [], drawn: null }
  const pending = pendingDiscardBySeat.value[view.seat]
  if (!pending) return splitHandForView(view)

  const remaining = [...view.hand]
  if (pending.tsumogiri) {
    return { closed: remaining, drawn: HAND_DISCARD_GAP }
  }

  const revealed = remaining.some((tile) => tile !== '?')
  const lastDrawnTile = lastDrawBeforePendingDiscard(view.seat)
  let drawn: string | null = null
  if (lastDrawnTile && remaining.length) {
    if (revealed) {
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        if (remaining[index] !== lastDrawnTile) continue
        drawn = remaining.splice(index, 1)[0] || null
        break
      }
    } else {
      drawn = remaining.pop() || null
    }
  }

  if (!revealed) {
    const slotCount = remaining.length + 1
    remaining.splice(deterministicGapIndex(view.seat, pending.pai, slotCount), 0, HAND_DISCARD_GAP)
    return { closed: remaining, drawn }
  }

  const originalClosed = [...remaining, pending.pai].sort(compareHandTiles)
  const gapIndex = originalClosed.indexOf(pending.pai)
  if (gapIndex >= 0) originalClosed[gapIndex] = HAND_DISCARD_GAP
  return { closed: originalClosed, drawn }
}

const southHandParts = computed(() => splitHandForView(southView.value))
const southDisplayHandParts = computed(() => splitHandForDisplay(southView.value))
const eastDisplayHandParts = computed(() => splitHandForDisplay(eastView.value))
const northDisplayHandParts = computed(() => splitHandForDisplay(northView.value))
const westDisplayHandParts = computed(() => splitHandForDisplay(westView.value))

const southHandDisplay = computed(() => (
  southHandParts.value.drawn
    ? [...southHandParts.value.closed, southHandParts.value.drawn]
    : [...southHandParts.value.closed]
))

const southRonRiskSlots = computed(() => {
  const displayParts = southDisplayHandParts.value
  const visualSlots = [
    ...displayParts.closed.map((tile) => ({ tile, isDrawn: false })),
    ...(displayParts.drawn ? [{ tile: displayParts.drawn, isDrawn: true }] : []),
  ]
  return visualSlots.map(({ tile, isDrawn }, index) => {
    const isGap = tile === HAND_DISCARD_GAP
    const isConnectedTile = !isGap && !isDrawn
    const previous = visualSlots[index - 1]
    const next = visualSlots[index + 1]
    const tileIndex = tileIdx(tile)
    return {
      tile,
      index,
      isDrawn,
      isGap,
      connectLeft: isConnectedTile && Boolean(previous && previous.tile !== HAND_DISCARD_GAP && !previous.isDrawn),
      connectRight: isConnectedTile && Boolean(next && next.tile !== HAND_DISCARD_GAP && !next.isDrawn),
      risks: RON_WAIT_OPPONENT_KEYS.map((key) => ({
        key,
        probability: isGap
          ? 0
          : displayedRonProbability(ronWaitPredData.value[key]?.[tileIndex] || 0),
      })),
    }
  })
})
const southRonRiskAdaptiveMax = computed(() => resolveRonBarAdaptiveMaxFromValues(
  southRonRiskSlots.value.flatMap((slot) => slot.risks.map((risk) => risk.probability)),
))
const showSouthRonRiskThreshold = computed(() => (
  southRonRiskAdaptiveMax.value > RON_BAR_ADAPTIVE_MIN
))

const riverTsumogiriFlagsBySeat = computed(() => {
  const result = new Map<number, boolean[]>()
  const history = Array.isArray(gameView.table?.actionHistory) ? gameView.table?.actionHistory || [] : []
  history.forEach((raw) => {
    const action = raw as Record<string, unknown>
    if (String(action.type || '') !== 'dahai') return
    const actor = Number(action.actor ?? -1)
    if (actor < 0 || actor > 3) return
    const flags = result.get(actor) || []
    flags.push(Boolean(action.tsumogiri))
    result.set(actor, flags)
  })
  return result
})

const riverRiichiFlagsBySeat = computed(() => {
  const result = new Map<number, boolean[]>()
  const history = Array.isArray(gameView.table?.actionHistory) ? gameView.table?.actionHistory || [] : []
  history.forEach((raw) => {
    const action = raw as Record<string, unknown>
    if (String(action.type || '') !== 'dahai') return
    const actor = Number(action.actor ?? -1)
    if (actor < 0 || actor > 3) return
    const flags = result.get(actor) || []
    flags.push(Boolean(action.riichi))
    result.set(actor, flags)
  })
  return result
})

const claimedRiverIndicesBySeat = computed(() => {
  const result = new Map<number, Set<number>>()
  const landedCounts = [0, 0, 0, 0]
  const history = Array.isArray(gameView.table?.actionHistory) ? gameView.table?.actionHistory || [] : []
  history.forEach((raw) => {
    const action = raw as Record<string, unknown>
    const type = String(action.type || '')
    if (type === 'dahai') {
      const actor = Number(action.actor ?? -1)
      if (actor >= 0 && actor < 4) landedCounts[actor] += 1
      return
    }
    if (type !== 'chi' && type !== 'pon' && type !== 'daiminkan') return
    const from = Number(action.from ?? -1)
    if (from < 0 || from > 3) return
    const index = landedCounts[from] - 1
    if (index < 0) return
    let claimed = result.get(from)
    if (!claimed) {
      claimed = new Set<number>()
      result.set(from, claimed)
    }
    claimed.add(index)
  })
  return result
})

function riverDisplayRows(view: { seat: number; river: string[] } | undefined | null): RiverDisplaySlot[][] {
  if (!view) return []
  const pending = pendingDiscardBySeat.value[view.seat]
  const claimedIndices = claimedRiverIndicesBySeat.value.get(view.seat) || null
  const tsumogiriFlags = riverTsumogiriFlagsBySeat.value.get(view.seat) || []
  const riichiFlags = riverRiichiFlagsBySeat.value.get(view.seat) || []
  const visibleTiles = view.river.map((tile, landedIndex) => ({
    tile,
    landedIndex,
    isPending: false,
  }))
  if (pending) {
    visibleTiles.push({
      tile: pending.pai,
      landedIndex: -1,
      isPending: true,
    })
  }

  const slots = visibleTiles.map((entry, visibleIndex): RiverDisplaySlot => ({
    key: `${view.seat}-${visibleIndex}`,
    tile: entry.tile,
    sourceNodeId: tableActionNodeIndex.value.discardNodeIdsBySeat[view.seat]?.[
      entry.isPending ? view.river.length : entry.landedIndex
    ] || null,
    isPending: entry.isPending,
    isTsumogiri: entry.isPending ? Boolean(pending?.tsumogiri) : entry.landedIndex >= 0 && Boolean(tsumogiriFlags[entry.landedIndex]),
    isClaimed: !entry.isPending && entry.landedIndex >= 0 && Boolean(claimedIndices?.has(entry.landedIndex)),
    isRiichiDiscard: entry.isPending ? Boolean(pending?.riichi) : entry.landedIndex >= 0 && Boolean(riichiFlags[entry.landedIndex]),
  }))
  return [slots.slice(0, 6), slots.slice(6, 12), slots.slice(12)].filter((row) => row.length > 0)
}

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`
}

function resolveSpecialEntry(action: TrainerAction) {
  if (!gameView.analysis?.specialEntries?.length) return null
  const candidateId = action.candidateId || action.id
  const exactCandidate = gameView.analysis.specialEntries.find((entry) => (
    entry.candidateId === candidateId
  ))
  if (exactCandidate) return exactCandidate
  const actionVariant = action.variant || ''
  return gameView.analysis.specialEntries.find((entry) => {
    if (entry.type !== action.type) return false
    if (entry.variant === actionVariant) return true
    return actionVariant.startsWith(entry.variant + ':')
  }) || null
}

function resolveReactionEntry(action: TrainerAction) {
  const entries = gameView.analysis?.reactionEntries || []
  if (!entries.length) return null
  const candidateId = action.candidateId || action.id
  const exactCandidate = entries.find((entry) => entry.candidateId === candidateId)
  if (exactCandidate) return exactCandidate
  const actionVariant = action.variant || action.type
  const exact = entries.find((entry) => (
    entry.type === action.type && entry.variant === actionVariant
  ))
  if (exact) return exact

  const sameType = entries.filter((entry) => entry.type === action.type)
  return sameType.length === 1 ? sameType[0] : null
}

function resolveDiscardEntry(action: TrainerAction) {
  const entries = gameView.analysis?.discardEntries || []
  const candidateId = action.candidateId || action.id
  const exactCandidate = entries.find((entry) => entry.candidateId === candidateId)
  if (exactCandidate) return exactCandidate
  const exactPhysical = entries.find((entry) => (
    entry.pai === action.pai
    && Boolean(entry.tsumogiri) === Boolean(action.tsumogiri)
  ))
  if (exactPhysical) return exactPhysical
  const sameTile = entries.filter((entry) => entry.pai === action.pai)
  return sameTile.length === 1 ? sameTile[0] : null
}

function analysisEntryIsBest(entry?: {
  candidateId?: string
  type?: string
  variant?: string
  pai?: string
  consumed?: string[]
  tsumogiri?: boolean
  isBest?: boolean
} | null): boolean {
  if (!entry) return false
  if (typeof entry.isBest === 'boolean') return entry.isBest
  const best = gameView.analysis?.bestAction as Record<string, unknown> | null | undefined
  if (!best) return false
  if (entry.type) {
    return best.type === entry.type
      && best.variant === entry.variant
      && [...((best.consumed as string[] | undefined) || [])].sort().join(',')
        === [...(entry.consumed || [])].sort().join(',')
  }
  return best.type === 'dahai'
    && best.pai === entry.pai
    && (
      typeof best.tsumogiri !== 'boolean'
      || Boolean(best.tsumogiri) === Boolean(entry.tsumogiri)
    )
}

function actionDisplayTiles(action: TrainerAction): string[] {
  const consumed = [...(action.consumed || [])]
  if (action.type === 'ankan') {
    const tile = consumed.find((candidate) => candidate.endsWith('r'))
      || action.pai
      || consumed[0]
      || ''
    const family = normalizeTileFamily(tile)
    if (family === '5m' || family === '5p' || family === '5s') {
      return [redFive(family)]
    }
    return [tile]
  }
  if (action.type === 'daiminkan' || action.type === 'kakan') {
    return action.pai ? [action.pai] : consumed.slice(0, 1)
  }
  if (action.type === 'chi' || action.type === 'pon') {
    return consumed
  }
  if (action.pai) consumed.push(action.pai)
  return consumed
}

function resolveRawQValue(action: TrainerAction): number | null {
  if (action.type === 'dahai') {
    const entry = resolveDiscardEntry(action)
    return entry && Number.isFinite(entry.value) ? entry.value : null
  }
  const entry = resolveReactionEntry(action) || resolveSpecialEntry(action)
  return entry && Number.isFinite(entry.value) ? entry.value : null
}

function resolveActionBar(action: TrainerAction): number {
  if (action.type === 'dahai') {
    const entry = resolveDiscardEntry(action)
    return normalizeRecommendationBar(rawAnalysisEntryBar(entry))
  }
  const entry = resolveReactionEntry(action) || resolveSpecialEntry(action)
  return normalizeRecommendationBar(rawAnalysisEntryBar(entry))
}

function rawAnalysisEntryBar(entry?: { bar?: number; probability?: number } | null): number {
  return Math.max(0, Number(entry?.bar ?? entry?.probability) || 0)
}

function resolveReactionAnalysisLabel(entry: { type?: string; variant?: string; label?: string; pai?: string; consumed?: string[] }): string {
  const actionType = entry.type || ''
  if (actionType === 'chi') return t('action.chi')
  if (actionType === 'pon') return t('action.pon')
  if (actionType === 'daiminkan') return t('action.kan')
  if (actionType === 'hora') return t('action.ron')
  if (actionType === 'none') return t('action.skip')
  return reactionTypeLabel(actionType)
}

function resolveSpecialAnalysisLabel(entry: { type?: string; variant?: string; label?: string; pai?: string; consumed?: string[] }): string {
  const actionType = entry.type || ''
  if (actionType === 'reach') return t('action.riichi')
  if (actionType === 'hora') return entry.variant === 'tsumo' ? t('action.tsumo') : t('action.ron')
  if (actionType === 'ankan' || actionType === 'kakan' || actionType === 'daiminkan') return t('action.kan')
  if (actionType === 'ryukyoku') return t('draw.kyuushu')
  if (actionType === 'none') return t('action.skip')
  return entry.label || actionType
}

function analysisActionDisplayTiles(entry: { type?: string; pai?: string; consumed?: string[] }): string[] {
  const type = entry.type || ''
  const consumed = [...(entry.consumed || [])].filter(Boolean)
  if (type === 'chi') return consumed
  if (type === 'pon') {
    const tile = entry.pai || consumed[0]
    return tile ? [tile] : []
  }
  if (type === 'ankan') {
    const tile = consumed.find((candidate) => candidate.endsWith('r')) || entry.pai || consumed[0]
    if (!tile) return []
    const family = normalizeTileFamily(tile)
    return family === '5m' || family === '5p' || family === '5s'
      ? [redFive(family)]
      : [tile]
  }
  if (type === 'daiminkan' || type === 'kakan') {
    const tile = entry.pai || consumed[0]
    return tile ? [tile] : []
  }
  return []
}

const decisionMetricDefinitions = computed<TrainerDecisionMetricDefinition[]>(() => (
  gameView.analysis?.metricDefinitions || []
))

const mergedAnalysisEntries = computed(() => {
  const discardEntries = gameView.analysis?.discardEntries || []
  const specialEntries = gameView.analysis?.specialEntries || []
  const all = [
    ...discardEntries.map((e) => ({
      ...e,
      _kind: 'discard' as const,
      _key: `d:${e.candidateId || `${e.pai}:${Boolean(e.tsumogiri)}`}`,
    })),
    ...specialEntries.map((e) => ({
      ...e,
      _kind: 'special' as const,
      _key: `s:${e.candidateId || e.variant || e.type}`,
    })),
  ]
  const primaryMetric = decisionMetricDefinitions.value.find((metric) => (
    metric.id === gameView.analysis?.primaryMetricId
  ))
  if (primaryMetric?.preferredDirection === 'lower') {
    all.sort((a, b) => (a.value ?? 0) - (b.value ?? 0))
  } else if (primaryMetric?.preferredDirection === 'higher' || !primaryMetric) {
    all.sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  }
  return all
})

function discardVariantLabel(entry: { pai: string; tsumogiri?: boolean }): string {
  const variants = (gameView.analysis?.discardEntries || []).filter((candidate) => (
    candidate.pai === entry.pai
  ))
  if (!variants.some((candidate) => Boolean(candidate.tsumogiri))
    || !variants.some((candidate) => !candidate.tsumogiri)) {
    return ''
  }
  return entry.tsumogiri
    ? t('evaluation.actionSuffix', { action: t('action.tsumogiri') })
    : t('evaluation.actionSuffix', { action: t('action.tedashi') })
}

function formatDecisionMetric(
  value: number | null | undefined,
  metric: TrainerDecisionMetricDefinition,
): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const displayedValue = metric.format === 'percentage' ? value * 100 : value
  const fractionDigits = Number.isInteger(metric.fractionDigits)
    && Number(metric.fractionDigits) >= 0
    && Number(metric.fractionDigits) <= 12
    ? Number(metric.fractionDigits)
    : null
  const text = fractionDigits === null
    ? new Intl.NumberFormat('en-US', {
        useGrouping: metric.format === 'points',
        maximumSignificantDigits: 15,
      }).format(displayedValue)
    : new Intl.NumberFormat('en-US', {
        useGrouping: metric.format === 'points',
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(displayedValue)
  return metric.format === 'percentage' ? `${text}%` : text
}

const recommendationBarMax = computed(() => {
  const entries = [
    ...(gameView.analysis?.discardEntries || []),
    ...(gameView.analysis?.specialEntries || []),
    ...(gameView.analysis?.reactionEntries || []),
  ]
  return entries.reduce((best, entry) => Math.max(best, rawAnalysisEntryBar(entry)), 0)
})

function normalizeRecommendationBar(raw: number): number {
  if (recommendationBarMax.value <= 0) return 0
  return Math.max(0, Math.min(1, raw / recommendationBarMax.value))
}

function resolveAnalysisEntryBar(entry: { bar?: number; probability?: number }): number {
  return normalizeRecommendationBar(rawAnalysisEntryBar(entry))
}

function findQuickPassAction(): TrainerAction | null {
  return specialActions.value.find((action) => action.type === 'none') || null
}

function findQuickTsumogiriAction(): TrainerAction | null {
  if (!southHandDisplay.value?.length) return null
  const lastTile = southHandDisplay.value[southHandDisplay.value.length - 1]
  return discardActions.value.find((action) => action.pai === lastTile) || null
}

function normalizeTrainingMode(mode: string): TrainerSettings['training']['mode'] {
  const MAP: Record<string, TrainerSettings['training']['mode']> = {
    no_review: 'no_review',
    free_play: 'preview_before_click',
    guided: 'threshold_review',
    strict: 'always_review',
    preview_before_click: 'preview_before_click',
    threshold_review: 'threshold_review',
    always_review: 'always_review',
  }
  return MAP[String(mode || '')] || 'threshold_review'
}

function applySettings(nextSettings: TrainerSettings) {
  Object.assign(settings, nextSettings)
  Object.assign(settings.training, nextSettings.training, {
    mode: normalizeTrainingMode(nextSettings.training.mode),
  })
  Object.assign(settings.modeDefaults, nextSettings.modeDefaults)
  Object.assign(settings.display, nextSettings.display || {}, {
    language: normalizeLanguagePreference(nextSettings.display?.language),
    colorScheme: normalizeColorScheme(nextSettings.display?.colorScheme),
    uiScale: normalizeUiScale(nextSettings.display?.uiScale),
    showTsumogiriInPlay: nextSettings.display?.showTsumogiriInPlay !== false,
    tablePosition: normalizeTablePosition(nextSettings.display?.tablePosition),
    workspaceLayout: normalizeWorkspaceLayout(nextSettings.display?.workspaceLayout),
  })
  Object.assign(settings.records, nextSettings.records || {})
  Object.assign(settings.audio, nextSettings.audio)
  Object.assign(settings.engines, nextSettings.engines)
}

function applyStatus(nextStatus: TrainerStatusSnapshot) {
  Object.assign(status, nextStatus)
}

type PendingDiscardView = NonNullable<NonNullable<TrainerGameView['table']>['pendingDiscard']>
type GameViewTransitionDirection = 'forward' | 'backward'

interface PendingDiscardReturnFlight {
  ghost: HTMLElement
  destination: HTMLElement
  backOverlay: HTMLElement | null
  regularPose: HTMLElement | null
  settledImage: HTMLElement | null
  deltaX: number
  deltaY: number
}

let pendingDiscardFlightFrame = 0
let pendingDiscardFlightAnimation: Animation | null = null
let pendingDiscardFlightBackOverlay: HTMLElement | null = null
let pendingDiscardFlightRegularPose: HTMLElement | null = null
let pendingDiscardFlightTarget: HTMLElement | null = null
let pendingDiscardReturnFrame = 0
let pendingDiscardReturnAnimation: Animation | null = null
let pendingDiscardReturnGhost: HTMLElement | null = null
let pendingDiscardReturnDestination: HTMLElement | null = null
let autoAdvanceMotionNotBefore = 0

function holdAutoAdvanceForTableMotion(duration = getUiMotionDurationMs()) {
  if (reduceMotionEnabled.value) return
  autoAdvanceMotionNotBefore = Math.max(
    autoAdvanceMotionNotBefore,
    performance.now() + duration,
  )
}

function pendingDiscardFromTable(table: TrainerGameView['table']): PendingDiscardView | null {
  return table?.pendingRiichiDiscard || table?.pendingDiscard || null
}

function pendingDiscardSignature(pending: PendingDiscardView | null): string {
  if (!pending) return ''
  return [pending.actor, pending.pai, pending.tsumogiri ? 1 : 0, pending.riichi ? 1 : 0].join('|')
}

function cancelPendingDiscardFlight() {
  if (pendingDiscardFlightFrame) {
    cancelAnimationFrame(pendingDiscardFlightFrame)
    pendingDiscardFlightFrame = 0
  }
  pendingDiscardFlightAnimation?.cancel()
  pendingDiscardFlightAnimation = null
  pendingDiscardFlightBackOverlay?.remove()
  pendingDiscardFlightBackOverlay = null
  pendingDiscardFlightRegularPose?.remove()
  pendingDiscardFlightRegularPose = null
  pendingDiscardFlightTarget?.style.removeProperty('visibility')
  pendingDiscardFlightTarget = null
}

function clearPendingDiscardReturnFlight() {
  pendingDiscardReturnGhost?.remove()
  pendingDiscardReturnDestination?.style.removeProperty('visibility')
  pendingDiscardReturnGhost = null
  pendingDiscardReturnDestination = null
}

function cancelPendingDiscardReturnFlight() {
  if (pendingDiscardReturnFrame) {
    cancelAnimationFrame(pendingDiscardReturnFrame)
    pendingDiscardReturnFrame = 0
  }
  pendingDiscardReturnAnimation?.cancel()
  pendingDiscardReturnAnimation = null
  clearPendingDiscardReturnFlight()
}

function shouldAnimateDiscardFaceChange(seat: number): boolean {
  return seat !== status.controlledSeat && !status.visibleHands
}

function createDiscardFlightBackOverlay(
  tile: HTMLElement,
  initialOpacity: number,
  inheritDiscardTone = false,
): HTMLElement | null {
  const sourceImage = tile.querySelector<HTMLElement>('.tileImg:not(.discard-flight-back)')
  if (!sourceImage) return null

  const sourceStyle = getComputedStyle(sourceImage)
  const overlay = document.createElement('img')
  overlay.className = 'tileImg discard-flight-back'
  if (inheritDiscardTone && sourceImage.classList.contains('river-tsumogiri')) {
    overlay.classList.add('river-tsumogiri')
  }
  overlay.setAttribute('src', tileImageSrc('?'))
  overlay.setAttribute('alt', '')
  overlay.setAttribute('aria-hidden', 'true')
  overlay.style.width = sourceStyle.width
  overlay.style.height = sourceStyle.height
  overlay.style.left = `${sourceImage.offsetLeft}px`
  overlay.style.top = `${sourceImage.offsetTop}px`
  overlay.style.right = 'auto'
  overlay.style.bottom = 'auto'
  overlay.style.transform = sourceStyle.transform
  overlay.style.transformOrigin = sourceStyle.transformOrigin
  overlay.style.opacity = `${initialOpacity}`
  tile.appendChild(overlay)
  const sourceRect = sourceImage.getBoundingClientRect()
  const overlayRect = overlay.getBoundingClientRect()
  overlay.style.left = `${sourceImage.offsetLeft + sourceRect.left - overlayRect.left}px`
  overlay.style.top = `${sourceImage.offsetTop + sourceRect.top - overlayRect.top}px`
  return overlay
}

function animateDiscardBackOverlay(
  overlay: HTMLElement,
  direction: 'reveal' | 'hide',
  duration: number,
) {
  const visible = direction === 'reveal' ? '1' : '0'
  const hidden = direction === 'reveal' ? '0' : '1'
  overlay.animate(
    [
      { opacity: hidden, offset: 0 },
      { opacity: hidden, offset: 0.2 },
      { opacity: visible, offset: 0.75 },
      { opacity: visible, offset: 1 },
    ],
    { duration, easing: 'linear', fill: 'forwards' },
  )
}

function createDiscardFlightRegularPose(
  tile: HTMLElement,
  povClass: string,
  initialOpacity: number,
  useBackImage: boolean,
  inheritDiscardTone: boolean,
): HTMLElement | null {
  const sourceImage = tile.querySelector<HTMLElement>('.tileImg:not(.discard-flight-back)')
  if (!sourceImage) return null

  const pose = document.createElement('span')
  pose.className = `discard-flight-regular-pose ${povClass}`
  pose.style.opacity = `${initialOpacity}`

  const poseTile = tile.cloneNode(true) as HTMLElement
  poseTile.classList.remove('river-riichi', 'tileDivPending', 'history-jump-target')
  poseTile.removeAttribute('data-pending-discard-seat')
  poseTile.style.removeProperty('width')
  poseTile.style.removeProperty('height')
  const poseImage = poseTile.querySelector<HTMLImageElement>('.tileImg')
  if (!poseImage) return null
  poseImage.classList.remove('river-riichi', 'last-discard')
  if (!inheritDiscardTone) poseImage.classList.remove('river-tsumogiri')
  if (useBackImage) {
    poseImage.src = tileImageSrc('?')
    poseImage.alt = ''
    poseImage.setAttribute('aria-hidden', 'true')
  }

  pose.appendChild(poseTile)
  tile.appendChild(pose)
  const settledRect = sourceImage.getBoundingClientRect()
  const regularRect = poseImage.getBoundingClientRect()
  const centerOffsetX = ((settledRect.left + settledRect.right) - (regularRect.left + regularRect.right)) / 2
  const centerOffsetY = ((settledRect.top + settledRect.bottom) - (regularRect.top + regularRect.bottom)) / 2
  pose.style.left = `calc(50% + ${centerOffsetX}px)`
  pose.style.top = `calc(50% + ${centerOffsetY}px)`
  return pose
}

function animateDiscardPoseSwap(
  regularPose: HTMLElement,
  settledImage: HTMLElement,
  direction: 'settle' | 'restore',
  duration: number,
) {
  const regularVisible = direction === 'settle' ? '1' : '0'
  const regularHidden = direction === 'settle' ? '0' : '1'
  regularPose.animate(
    [
      { opacity: regularVisible, offset: 0 },
      { opacity: regularVisible, offset: 0.2 },
      { opacity: regularHidden, offset: 0.75 },
      { opacity: regularHidden, offset: 1 },
    ],
    { duration, easing: 'linear', fill: 'forwards' },
  )
  settledImage.animate(
    [
      { opacity: regularHidden, offset: 0 },
      { opacity: regularHidden, offset: 0.2 },
      { opacity: regularVisible, offset: 0.75 },
      { opacity: regularVisible, offset: 1 },
    ],
    { duration, easing: 'linear', fill: 'forwards' },
  )
}

function preparePendingDiscardReturnFlight(seat: number): PendingDiscardReturnFlight | null {
  if (reduceMotionEnabled.value) return null
  const destination = document.querySelector<HTMLElement>(`[data-hand-gap-seat="${seat}"]`)
  const source = document.querySelector<HTMLElement>(`[data-pending-discard-seat="${seat}"]`)
  if (!destination || !source) return null

  const sourceRect = source.getBoundingClientRect()
  const destinationRect = destination.getBoundingClientRect()
  const povClass = [...(source.closest<HTMLElement>('[class*="pov-p"]')?.classList || [])]
    .find((className) => /^pov-p[0-3]$/.test(className))
  if (!povClass) return null

  const ghost = document.createElement('span')
  ghost.className = `discard-return-ghost ${povClass}`
  ghost.style.left = `${sourceRect.left}px`
  ghost.style.top = `${sourceRect.top}px`
  const sourceStyle = getComputedStyle(source)
  for (const property of ['--zoom', '--zoom-tiles', '--tile-img-w', '--tile-img-h', '--tile-w', '--tile-h']) {
    ghost.style.setProperty(property, sourceStyle.getPropertyValue(property))
  }
  const clonedTile = source.cloneNode(true) as HTMLElement
  clonedTile.removeAttribute('data-pending-discard-seat')
  clonedTile.style.width = sourceStyle.width
  clonedTile.style.height = sourceStyle.height
  const sourceImage = source.querySelector<HTMLElement>('.tileImg')
  const clonedImage = clonedTile.querySelector<HTMLElement>('.tileImg')
  const sourceVisualRect = sourceImage?.getBoundingClientRect() || sourceRect
  if (sourceImage && clonedImage) {
    const sourceImageStyle = getComputedStyle(sourceImage)
    clonedImage.style.width = sourceImageStyle.width
    clonedImage.style.height = sourceImageStyle.height
  }
  ghost.appendChild(clonedTile)
  document.body.appendChild(ghost)
  const regularPose = source.classList.contains('river-riichi')
    ? createDiscardFlightRegularPose(
        clonedTile,
        povClass,
        0,
        shouldAnimateDiscardFaceChange(seat),
        false,
      )
    : null
  const backOverlay = !regularPose && shouldAnimateDiscardFaceChange(seat)
    ? createDiscardFlightBackOverlay(clonedTile, 0)
    : null
  destination.style.visibility = 'hidden'

  return {
    ghost,
    destination,
    backOverlay,
    regularPose,
    settledImage: clonedImage,
    deltaX: (destinationRect.left + (destinationRect.width / 2)) - (sourceVisualRect.left + (sourceVisualRect.width / 2)),
    deltaY: (destinationRect.top + (destinationRect.height / 2)) - (sourceVisualRect.top + (sourceVisualRect.height / 2)),
  }
}

function schedulePendingDiscardReturnFlight(flight: PendingDiscardReturnFlight) {
  pendingDiscardReturnGhost = flight.ghost
  pendingDiscardReturnDestination = flight.destination
  void nextTick(() => {
    pendingDiscardReturnFrame = requestAnimationFrame(() => {
      pendingDiscardReturnFrame = 0
      if (!flight.ghost.isConnected) {
        clearPendingDiscardReturnFlight()
        return
      }
      const duration = getUiMotionDurationMs()
      const easing = getUiMotionEasing()
      if (flight.backOverlay) {
        animateDiscardBackOverlay(flight.backOverlay, 'reveal', duration)
      }
      if (flight.regularPose && flight.settledImage) {
        animateDiscardPoseSwap(flight.regularPose, flight.settledImage, 'restore', duration)
      }
      pendingDiscardReturnAnimation = flight.ghost.animate(
        [
          { transform: 'translate(0px, 0px)' },
          { transform: `translate(${flight.deltaX}px, ${flight.deltaY}px)` },
        ],
        { duration, easing, fill: 'forwards' },
      )
      pendingDiscardReturnAnimation.onfinish = () => {
        pendingDiscardReturnAnimation = null
        // Keep the exact endpoint visible for one paint before revealing the hand tile.
        pendingDiscardReturnFrame = requestAnimationFrame(() => {
          pendingDiscardReturnFrame = requestAnimationFrame(() => {
            pendingDiscardReturnFrame = 0
            clearPendingDiscardReturnFlight()
          })
        })
      }
      pendingDiscardReturnAnimation.oncancel = () => {
        pendingDiscardReturnAnimation = null
      }
    })
  })
}

function schedulePendingDiscardFlight(seat: number) {
  if (reduceMotionEnabled.value) return
  void nextTick(() => {
    const gap = document.querySelector<HTMLElement>(`[data-hand-gap-seat="${seat}"]`)
    const target = document.querySelector<HTMLElement>(`[data-pending-discard-seat="${seat}"]`)
    const targetTile = target?.querySelector<HTMLElement>('.tileImg')
    if (!gap || !target || !targetTile || typeof target.animate !== 'function') return

    const povClass = [...(target.closest<HTMLElement>('[class*="pov-p"]')?.classList || [])]
      .find((className) => /^pov-p[0-3]$/.test(className))
    const regularPose = target.classList.contains('river-riichi') && povClass
      ? createDiscardFlightRegularPose(
          target,
          povClass,
          1,
          shouldAnimateDiscardFaceChange(seat),
          true,
        )
      : null
    const backOverlay = !regularPose && shouldAnimateDiscardFaceChange(seat)
      ? createDiscardFlightBackOverlay(target, 1, true)
      : null
    pendingDiscardFlightBackOverlay = backOverlay
    pendingDiscardFlightRegularPose = regularPose
    pendingDiscardFlightTarget = target
    // The controlled seat has no back overlay, but must remain hidden until
    // its start keyframe is ready just like the other three seats.
    target.style.visibility = 'hidden'

    pendingDiscardFlightFrame = requestAnimationFrame(() => {
      pendingDiscardFlightFrame = 0
      if (!gap.isConnected || !target.isConnected || !targetTile.isConnected) {
        cancelPendingDiscardFlight()
        return
      }

      const gapRect = gap.getBoundingClientRect()
      const targetRect = targetTile.getBoundingClientRect()
      const deltaX = (gapRect.left + (gapRect.width / 2)) - (targetRect.left + (targetRect.width / 2))
      const deltaY = (gapRect.top + (gapRect.height / 2)) - (targetRect.top + (targetRect.height / 2))
      const duration = getUiMotionDurationMs()
      const easing = getUiMotionEasing()
      const finalTransform = getComputedStyle(target).transform
      const settledTransform = finalTransform === 'none' ? 'translate(0px, 0px)' : finalTransform
      if (backOverlay) {
        animateDiscardBackOverlay(backOverlay, 'hide', duration)
      }
      if (regularPose) {
        animateDiscardPoseSwap(regularPose, targetTile, 'settle', duration)
      }

      pendingDiscardFlightAnimation = target.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px) ${settledTransform}` },
          { transform: settledTransform },
        ],
        { duration, easing },
      )
      pendingDiscardFlightAnimation.pause()
      pendingDiscardFlightAnimation.currentTime = 0
      target.style.removeProperty('visibility')
      pendingDiscardFlightFrame = requestAnimationFrame(() => {
        pendingDiscardFlightFrame = 0
        if (!target.isConnected || pendingDiscardFlightAnimation === null) return
        holdAutoAdvanceForTableMotion(duration)
        scheduleAutoAdvance()
        pendingDiscardFlightAnimation.play()
      })
      pendingDiscardFlightAnimation.onfinish = () => {
        pendingDiscardFlightAnimation = null
        backOverlay?.remove()
        regularPose?.remove()
        if (pendingDiscardFlightBackOverlay === backOverlay) {
          pendingDiscardFlightBackOverlay = null
        }
        if (pendingDiscardFlightRegularPose === regularPose) {
          pendingDiscardFlightRegularPose = null
        }
        if (pendingDiscardFlightTarget === target) {
          pendingDiscardFlightTarget = null
        }
        scheduleAutoAdvance()
      }
      pendingDiscardFlightAnimation.oncancel = () => {
        pendingDiscardFlightAnimation = null
        backOverlay?.remove()
        regularPose?.remove()
        if (pendingDiscardFlightBackOverlay === backOverlay) {
          pendingDiscardFlightBackOverlay = null
        }
        if (pendingDiscardFlightRegularPose === regularPose) {
          pendingDiscardFlightRegularPose = null
        }
        target.style.removeProperty('visibility')
        if (pendingDiscardFlightTarget === target) {
          pendingDiscardFlightTarget = null
        }
      }
    })
  })
}

watch(reduceMotionEnabled, (reduced) => {
  if (!reduced) return
  cancelPendingDiscardFlight()
  cancelPendingDiscardReturnFlight()
})

function decisionAnalysisPositionKey(gameId: string | null | undefined, nodeId: string | null | undefined) {
  if (!gameId || !nodeId) return null
  return `${gameId}\u0000${nodeId}`
}

function cacheDecisionAnalysis(gameId: string | null | undefined, nodeId: string | null | undefined, analysis: DecisionAnalysis) {
  const key = decisionAnalysisPositionKey(gameId, nodeId)
  if (key) decisionAnalysisEventCache.set(key, analysis)
}

function playPrefetchPositionKey(gameId: string | null | undefined, nodeId: string | null | undefined) {
  if (!gameId || !nodeId) return null
  return `${gameId}\u0000${nodeId}`
}

function applyPlayPrefetchStatus(prefetch?: TrainerEnvironmentResponse['playPrefetch']) {
  const currentKey = playPrefetchPositionKey(gameView.gameId, gameView.currentNodeId)
  const eventReady = currentKey ? earlyPlayPrefetchReady.delete(currentKey) : false
  playPrefetchReady.value = Boolean(prefetch?.ready || eventReady)
  playPrefetchWaiting.value = Boolean(prefetch?.waiting && !playPrefetchReady.value)
  scheduleAutoAdvance()
}

function resolveNextDecisionAnalysis(nextView: TrainerGameView, isNewGame: boolean): TrainerGameView['analysis'] {
  if (isNewGame) decisionAnalysisEventCache.clear()
  if (nextView.analysis) {
    cacheDecisionAnalysis(nextView.gameId, nextView.currentNodeId, nextView.analysis)
    return nextView.analysis
  }
  if (!effectiveDecisionRecommendationsEnabled.value || !nextView.legalActions.length) return null

  const key = decisionAnalysisPositionKey(nextView.gameId, nextView.currentNodeId)
  const eventAnalysis = key ? decisionAnalysisEventCache.get(key) : null
  if (eventAnalysis) return eventAnalysis
  return null
}

function opponentAnalysisRoundKey(view: TrainerGameView): string | null {
  if (!view.gameId || !view.table) return null
  const roundRootId = view.tree?.currentRoundRootId
  if (roundRootId) return `${view.gameId}\u0000${roundRootId}`
  return `${view.gameId}\u0000${view.table.roundIndex}\u0000${view.table.honba}`
}

function treeNodeCount(tree: TrainerGameView['tree']): number {
  const nodes = tree?.nodes
  if (Array.isArray(nodes)) return nodes.length
  return nodes && typeof nodes === 'object' ? Object.keys(nodes).length : 0
}

function treeContainsNode(tree: TrainerGameView['tree'], nodeId: string | null | undefined): boolean {
  if (!nodeId) return false
  const nodes = tree?.nodes
  if (Array.isArray(nodes)) return nodes.some((node) => node.id === nodeId)
  return Boolean(nodes && typeof nodes === 'object' && Object.prototype.hasOwnProperty.call(nodes, nodeId))
}

function applyGameView(nextView: TrainerGameView, transitionDirection: GameViewTransitionDirection = 'forward') {
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
    cancelPendingWheelNavigation()
    latestNavigationIntentId += 1
    nodeCommentLocalDrafts.clear()
  }
  gameView.gameId = nextView.gameId
  gameView.matchId = nextView.matchId
  gameView.readOnly = Boolean(nextView.readOnly)
  gameView.sourceUrl = nextView.sourceUrl || null
  gameView.readOnlyReason = nextView.readOnlyReason || null
  gameView.currentNodeId = nextView.currentNodeId
  gameView.nodeComment = nextView.nodeComment || ''
  syncNodeCommentFromView(nextView)
  gameView.opponentAnalysis = nextView.opponentAnalysis || null
  const prefetchKey = playPrefetchPositionKey(nextView.gameId, nextView.currentNodeId)
  if (prefetchKey && earlyPlayPrefetchReady.has(prefetchKey)) {
    playPrefetchReady.value = true
    playPrefetchWaiting.value = false
  }
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
  if (wheelNavigationGeneration === 0) {
    wheelNavigationCursorNodeId = nextView.currentNodeId
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

function cloneSettingsDraftFromCurrent() {
  Object.assign(settingsDraft, JSON.parse(JSON.stringify(settings)))
}

function clearAutoAdvanceTimer() {
  if (autoAdvanceTimer.value !== null) {
    window.clearTimeout(autoAdvanceTimer.value)
    autoAdvanceTimer.value = null
  }
}

function clearActionAnnouncementTimer() {
  if (actionAnnouncementTimer.value !== null) {
    window.clearTimeout(actionAnnouncementTimer.value)
    actionAnnouncementTimer.value = null
  }
}

function hasRecommendationAnalysis(): boolean {
  const analysis = gameView.analysis
  return Boolean(analysis?.discardEntries?.length || analysis?.reactionEntries?.length || analysis?.specialEntries?.length)
}

function resolveActionAnnouncementText(node?: TrainerTreeNode | null): string | null {
  if (!node?.action) return null
  const action = node.action as Record<string, unknown>
  const type = String(action.type || '')
  if (type === 'reach') return t('action.riichi')
  if (type === 'chi') return t('action.chi')
  if (type === 'pon') return t('action.pon')
  if (type === 'daiminkan' || type === 'ankan' || type === 'kakan') return t('action.kan')
  if (type === 'hora') {
    const variant = String(action.variant || '')
    const actor = Number(action.actor ?? -1)
    const target = Number(action.target ?? -999)
    return variant === 'tsumo' || actor === target ? t('action.tsumo') : t('action.ronShort')
  }
  return null
}

function triggerActionAnnouncementForCurrentNode() {
  if (!gameView.currentNodeId) return
  const node = nodeMapById.value.get(gameView.currentNodeId)
  const text = resolveActionAnnouncementText(node)
  if (!text) return
  const actor = Number((node?.action as Record<string, unknown> | null)?.actor ?? -1)
  const position = tableSeatViews.value.find((entry) => entry.seat === actor)?.position || 'south'
  clearActionAnnouncementTimer()
  actionAnnouncement.key = `${gameView.currentNodeId}:${text}:${Date.now()}`
  actionAnnouncement.text = text
  actionAnnouncement.position = position
  actionAnnouncement.visible = true
  actionAnnouncementTimer.value = window.setTimeout(() => {
    actionAnnouncement.visible = false
    actionAnnouncementTimer.value = null
  }, 1500)
}

function setRecordPath(nextPath: string | null | undefined) {
  recordPath.value = nextPath || ''
}

async function showRecordInFolder() {
  if (!recordPath.value || !window.trainerAPI) return
  await window.trainerAPI.showRecordInFolder()
}

function openExternalLink(url: string) {
  void window.trainerAPI?.openExternal(url).catch((error) => {
    console.error('Failed to open external link:', error)
  })
}

function openEngineLegalDocument(kind: 'license' | 'notice', index: number) {
  if (!activeCatalogEngine.value) return
  void window.trainerAPI?.openEngineLegalDocument({
    engineId: activeCatalogEngine.value.id,
    kind,
    index,
  }).catch((error) => {
    console.error('Failed to open engine legal document:', error)
  })
}

async function refreshGameView() {
  if (!window.trainerAPI) return
  const response = await window.trainerAPI.getGameView()
  applyStatus(response.state)
  applyGameView(response.view)
}

async function refreshBootstrapState() {
  if (!window.trainerAPI) {
    bootstrapError.value = t('error.desktopBridge')
    return
  }
  try {
    // Load settings first — this works even if the Python backend is down
    let nextSettings: TrainerSettings
    try {
      nextSettings = await window.trainerAPI.getSettings()
      applySettings(nextSettings)
      captureRuntimeEngineProfile('decision', nextSettings.engines)
      captureRuntimeEngineProfile('opponent', nextSettings.engines)
      markConfiguredEngineStarting('decision', nextSettings.engines)
      markConfiguredEngineStarting('opponent', nextSettings.engines)
    } catch {
      // Settings file not readable? Use defaults already in `settings`
    }
    const nextStatus = await window.trainerAPI.getStatus()
    applyStatus(nextStatus)
    markConfiguredEngineStarting('decision', settings.engines)
    markConfiguredEngineStarting('opponent', settings.engines)
    await syncAnalysisVisibilityToBackend()
    const restored = await window.trainerAPI.restoreStartupRecovery()
    if (restored) {
      applyStatus(restored.state)
      applyGameView(restored.view)
      setRecordPath(restored.path)
      recoveryRecord.value = Boolean(restored.recoveryRecord)
    } else {
      await refreshGameView()
    }
    if (window.trainerAPI.getRecordDirty) {
      recordDirty.value = await window.trainerAPI.getRecordDirty()
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

async function createGame() {
  if (!window.trainerAPI || gameFileOperation.value !== null) return
  clearCloseRecordConfirmation()
  gameFileOperation.value = 'create'
  try {
    await flushNodeComment()
    applyStatus(await window.trainerAPI.createGame())
    setRecordPath('')
    recoveryRecord.value = false
    await refreshGameView()
  } finally {
    gameFileOperation.value = null
  }
}

async function openGame() {
  if (!window.trainerAPI || gameFileOperation.value !== null) return
  clearCloseRecordConfirmation()
  gameFileOperation.value = 'open'
  try {
    await flushNodeComment()
    const result = await window.trainerAPI.openGame()
    if (!result) return
    applyStatus(result.state)
    applyGameView(result.view)
    setRecordPath(result.path)
    recordDirty.value = Boolean(result.recordDirty)
    recoveryRecord.value = Boolean(result.recoveryRecord)
  } finally {
    gameFileOperation.value = null
  }
}

function openRecordImportPanel() {
  showRecordImportPanel.value = true
}

function closeRecordImportPanel() {
  showRecordImportPanel.value = false
}

async function handleRecordImported(result: TrainerRecordImportResult) {
  applyStatus(result.state)
  applyGameView(result.view)
  setRecordPath('')
  recordDirty.value = Boolean(result.recordDirty)
  recoveryRecord.value = false
  showRecordImportPanel.value = false
  if (result.reconstruction) {
    await openWallView()
    wallClipboardMessage.value = t('wall.reconstructedRounds', { count: result.reconstruction.roundCount })
  }
}

function openCustomTenhouExport() {
  if (!gameView.currentNodeId) return
  showCustomTenhouExport.value = true
  focusFloatingPanel('customExport')
}

async function saveGame() {
  if (!window.trainerAPI || !recordDirty.value || gameFileOperation.value !== null) return
  gameFileOperation.value = 'save'
  try {
    await flushNodeComment()
    const result = await window.trainerAPI.saveGame()
    if (!result) return
    applyStatus(result.state)
    applyGameView(result.view)
    setRecordPath(result.path)
    recordDirty.value = Boolean(result.recordDirty)
    recoveryRecord.value = Boolean(result.recoveryRecord)
  } finally {
    gameFileOperation.value = null
  }
}

async function saveGameAs() {
  if (!window.trainerAPI || gameFileOperation.value !== null) return
  gameFileOperation.value = 'save-as'
  try {
    await flushNodeComment()
    const result = await window.trainerAPI.saveGameAs()
    if (!result) return
    applyStatus(result.state)
    applyGameView(result.view)
    setRecordPath(result.path)
    recordDirty.value = Boolean(result.recordDirty)
    recoveryRecord.value = Boolean(result.recoveryRecord)
  } finally {
    gameFileOperation.value = null
  }
}

function clearCloseRecordConfirmation() {
  closeRecordConfirmationPending.value = false
  if (closeRecordConfirmationTimer !== null) {
    window.clearTimeout(closeRecordConfirmationTimer)
    closeRecordConfirmationTimer = null
  }
}

function requestCloseRecordConfirmation() {
  closeRecordConfirmationPending.value = true
  if (closeRecordConfirmationTimer !== null) {
    window.clearTimeout(closeRecordConfirmationTimer)
  }
  closeRecordConfirmationTimer = window.setTimeout(() => {
    closeRecordConfirmationPending.value = false
    closeRecordConfirmationTimer = null
  }, DELETE_CONFIRMATION_TIMEOUT_MS)
}

watch(recordDirty, (dirty) => {
  if (!dirty) clearCloseRecordConfirmation()
})

async function closeGame() {
  if (!window.trainerAPI || !status.gameLoaded || gameFileOperation.value !== null) return
  if (recordDirty.value && !closeRecordConfirmationPending.value) {
    requestCloseRecordConfirmation()
    return
  }

  clearCloseRecordConfirmation()
  gameFileOperation.value = 'close'
  try {
    await flushNodeComment()
    gameplayResponseGeneration += 1
    cancelPendingWheelNavigation()
    clearAutoAdvanceTimer()
    showWallView.value = false
    closeRoundMapOverlay()
    wallTiles.value = []
    const response = await window.trainerAPI.closeGame()
    applyStatus(response.state)
    applyGameView(response.view)
    setRecordPath('')
    recordDirty.value = false
    recoveryRecord.value = false
  } finally {
    gameFileOperation.value = null
  }
}

function openSettingsPanel() {
  cloneSettingsDraftFromCurrent()
  showSettingsPanel.value = true
}

function closeSettingsPanel() {
  showSettingsPanel.value = false
}

async function saveSettingsPanel() {
  if (!window.trainerAPI) return
  settingsDraft.display.language = normalizeLanguagePreference(settingsDraft.display.language)
  settingsDraft.display.colorScheme = normalizeColorScheme(settingsDraft.display.colorScheme)
  settingsDraft.display.uiScale = normalizeUiScale(settingsDraft.display.uiScale)
  settingsDraft.display.tablePosition = normalizeTablePosition(settingsDraft.display.tablePosition)
  settingsDraft.display.workspaceLayout = normalizeWorkspaceLayout(settingsDraft.display.workspaceLayout)
  settingsDraft.training.mistakeThreshold = Math.max(
    0,
    Math.min(1, Number(settingsDraft.training.mistakeThreshold) || 0),
  )
  const next = JSON.parse(JSON.stringify(settings)) as TrainerSettings
  next.training.mistakeThreshold = settingsDraft.training.mistakeThreshold
  next.display = JSON.parse(JSON.stringify(settingsDraft.display))
  next.records = JSON.parse(JSON.stringify(settingsDraft.records))
  next.audio = JSON.parse(JSON.stringify(settingsDraft.audio))
  const saved = await window.trainerAPI.saveSettings(next)
  applySettings(saved)
  showSettingsPanel.value = false
}

async function saveQuickSettings(mutator: (draft: TrainerSettings) => void) {
  if (!window.trainerAPI) return
  const next = JSON.parse(JSON.stringify(settings)) as TrainerSettings
  mutator(next)
  next.training.mode = normalizeTrainingMode(next.training.mode)
  const saved = await window.trainerAPI.saveSettings(next)
  applySettings(saved)
  cloneSettingsDraftFromCurrent()
}

async function setQuickTrainingMode(mode: TrainerSettings['training']['mode']) {
  if (currentTrainingMode.value === mode) return
  await saveQuickSettings((next) => {
    next.training.mode = mode
  })
}

async function onQuickAudioVolumeInput(event: Event) {
  const target = event.target as HTMLInputElement | null
  if (!target) return
  quickVolumeDragValue.value = Math.max(0, Math.min(100, Number(target.value || 0)))
}

async function commitQuickAudioVolume(event: Event) {
  const target = event.target as HTMLInputElement | null
  if (!target) return
  const volume = Math.max(0, Math.min(100, Number(target.value || 0)))
  await saveQuickSettings((next) => {
    next.audio.volume = volume
  })
  quickVolumeDragValue.value = null
}

async function onQuickThinkingTimeInput(event: Event) {
  const target = event.target as HTMLInputElement | null
  if (!target) return
  quickThinkingDragValue.value = Math.max(0, Math.min(4, Number(target.value || 0)))
}

async function commitQuickThinkingTime(event: Event) {
  const target = event.target as HTMLInputElement | null
  if (!target) return
  const maxS = Math.max(0, Math.min(4, Number(target.value || 0)))
  const quarter = maxS / 4
  await saveQuickSettings((next) => {
    next.training.thinkingTimeMaxS = maxS
    next.training.thinkingTimeMinS = quarter
    next.modeDefaults.autoAdvanceDelayMs = Math.round(quarter * 1000)
  })
  quickThinkingDragValue.value = null
}

function getSoundSource(event: string): string | null {
  const selectedPack = settings.runtime?.soundPackCatalog.packs.find(
    (pack) => pack.id === settings.audio.soundPackId,
  )
  return selectedPack?.sounds[event] || null
}

function preloadTileImage(src: string): Promise<void> {
  const image = new Image()
  image.decoding = 'async'
  preloadedTileImages.push(image)

  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      tileArtworkLoadedCount.value += 1
      resolve()
    }
    const loaded = () => {
      // Resource load is enough to make the cached SVG available to every tile
      // element. Decoding may continue off the startup critical path.
      if (typeof image.decode === 'function') {
        void image.decode().catch(() => undefined)
      }
      finish()
    }

    image.addEventListener('load', loaded, { once: true })
    image.addEventListener('error', finish, { once: true })
    image.src = src
    if (image.complete) {
      if (image.naturalWidth > 0) loaded()
      else finish()
    }
  })
}

function warmStaticAssets(): Promise<void> {
  if (staticAssetsWarmupPromise) return staticAssetsWarmupPromise

  const tileWarmup = Promise.all(tileArtworkSources.map(preloadTileImage)).then(() => undefined)

  staticAssetsWarmupPromise = tileWarmup
  return staticAssetsWarmupPromise
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })
}

async function prepareRendererForDisplay() {
  await nextTick()
  updateTreeViewport()
  const bootstrapRefresh = refreshBootstrapState()
  await warmStaticAssets()
  await nextPaint()
  tileArtworkReady.value = true
  await bootstrapRefresh
}

function playSoundEvent(event: string) {
  const src = getSoundSource(event)
  const volume = Math.max(0, Math.min(1, settings.audio.volume / 100))
  if (!src || volume <= 0) return
  const audio = new Audio(src)
  audio.volume = volume
  audio.preload = 'auto'
  activeAudioPlayers.add(audio)
  const cleanup = () => {
    activeAudioPlayers.delete(audio)
    audio.removeEventListener('ended', cleanup)
    audio.removeEventListener('error', cleanup)
  }
  audio.addEventListener('ended', cleanup)
  audio.addEventListener('error', cleanup)
  void audio.play().catch(cleanup)
}

function announcementSoundEvent(type: string): string | null {
  const map: Record<string, string> = {
    pon: 'call.pon',
    daiminkan: 'call.kan',
    ankan: 'call.kan',
    kakan: 'call.kan',
    chi: 'call.chi',
    reach: 'call.riichi',
    ron: 'win.ron',
    tsumo: 'win.tsumo',
  }
  return map[type] || null
}

function actionSignature(action: TrainerGameView['table']['lastAction']) {
  if (!action) return ''
  return [
    action.type || '',
    action.actor ?? '',
    action.pai || '',
    action.variant || '',
    action.target ?? '',
    action.reason || '',
    action.riichi ? '1' : '0',
    Array.isArray(action.consumed) ? action.consumed.join(',') : '',
  ].join('|')
}

type SoundTransitionView = Pick<TrainerGameView, 'table' | 'legalActions' | 'pendingReview'>

function hasSpecialChoiceActions(view: SoundTransitionView): boolean {
  return (view.legalActions || []).some((action) => action.type !== 'dahai')
}

function handleSoundTransitions(
  prevView: SoundTransitionView,
  nextView: SoundTransitionView,
  isNewGame: boolean,
  transitionDirection: GameViewTransitionDirection,
) {
  if (bootstrapError.value || isNewGame) return
  if (!prevView.table || !nextView.table) return

  const hadPendingDiscard = Boolean(prevView.table.pendingDiscard || prevView.table.pendingRiichiDiscard)
  const hasPendingDiscard = Boolean(nextView.table.pendingDiscard || nextView.table.pendingRiichiDiscard)
  if (transitionDirection === 'forward' && hadPendingDiscard && !hasPendingDiscard) {
    playSoundEvent('action.confirmed')
  }

  const prevActionSig = actionSignature(prevView.table.lastAction)
  const nextAction = nextView.table.lastAction
  const nextActionSig = actionSignature(nextAction)
  if (nextAction && nextActionSig && nextActionSig !== prevActionSig) {
    if (nextAction.type === 'dahai') {
      playSoundEvent('tile.discard')
    } else if (nextAction.type === 'reach') {
      const soundEvent = announcementSoundEvent('reach')
      if (soundEvent) playSoundEvent(soundEvent)
    } else if (['chi', 'pon', 'daiminkan', 'ankan', 'kakan'].includes(nextAction.type)) {
      const soundEvent = announcementSoundEvent(nextAction.type)
      if (soundEvent) playSoundEvent(soundEvent)
    } else if (nextAction.type === 'hora') {
      const variant = nextAction.variant === 'tsumo' || nextAction.actor === nextAction.target ? 'tsumo' : 'ron'
      const soundEvent = announcementSoundEvent(variant)
      if (soundEvent) playSoundEvent(soundEvent)
    }
  }

  if (status.mode === 'play' && !hasSpecialChoiceActions(prevView) && hasSpecialChoiceActions(nextView)) {
    playSoundEvent('action.required')
  }

  if (status.mode === 'play' && !prevView.pendingReview && nextView.pendingReview) {
    playSoundEvent('review.required')
  }

  if (!prevView.table.resultInfo && nextView.table.resultInfo) {
    playSoundEvent('round.result')
  }
}

async function refreshWallView(closeOnError = false, showLoading = false) {
  if (!showWallView.value || !window.trainerAPI?.getWallView || !gameView.table) return
  const generation = ++wallRefreshGeneration
  const expectedGameId = gameView.gameId
  const expectedNodeId = gameView.currentNodeId
  if (showLoading) {
    wallLoading.value = true
    wallTiles.value = []
    wallViewComplete.value = false
    wallCanReconstruct.value = false
    wallSeed.value = null
    wallOrigin.value = 'generated'
    wallSourceUrl.value = ''
  }
  try {
    const result = await window.trainerAPI.getWallView()
    if (
      generation !== wallRefreshGeneration
      || !showWallView.value
      || gameView.gameId !== expectedGameId
      || gameView.currentNodeId !== expectedNodeId
    ) return
    wallTiles.value = result.tiles || []
    wallViewComplete.value = Boolean(result.complete)
    wallCanReconstruct.value = Boolean(result.canReconstruct)
    wallSeed.value = result.seed ?? null
    wallOrigin.value = result.origin || 'generated'
    wallSourceUrl.value = result.sourceUrl || ''
  } catch {
    if (closeOnError && generation === wallRefreshGeneration) showWallView.value = false
  } finally {
    if (generation === wallRefreshGeneration) wallLoading.value = false
  }
}

async function openWallView() {
  if (!window.trainerAPI?.getWallView) return
  showWallView.value = true
  focusFloatingPanel('wall')
  wallClipboardMessage.value = ''
  await refreshWallView(true, true)
}

async function reconstructImportedWalls() {
  if (!window.trainerAPI?.reconstructWalls || wallReconstructing.value) return
  wallReconstructing.value = true
  wallClipboardMessage.value = ''
  try {
    const response = await window.trainerAPI.reconstructWalls(wallReconstructionSeed.value)
    applyStatus(response.state)
    applyGameView(response.view)
    wallReconstructionSeed.value = ''
    await refreshWallView(false, true)
    wallClipboardMessage.value = t('wall.reconstructedRounds', { count: response.reconstruction.roundCount })
  } catch (error) {
    wallClipboardMessage.value = error instanceof Error ? error.message : t('wall.reconstructFailed')
  } finally {
    wallReconstructing.value = false
  }
}

const TENHOU_HONOR_TO_TILE: Record<string, string> = {
  '1z': 'E',
  '2z': 'S',
  '3z': 'W',
  '4z': 'N',
  '5z': 'P',
  '6z': 'F',
  '7z': 'C',
}
const TILE_TO_TENHOU_HONOR = Object.fromEntries(
  Object.entries(TENHOU_HONOR_TO_TILE).map(([tenhou, tile]) => [tile, tenhou]),
) as Record<string, string>

function encodeWallClipboardTile(tile: string): string {
  if (TILE_TO_TENHOU_HONOR[tile]) return TILE_TO_TENHOU_HONOR[tile]
  const redFive = tile.match(/^5([mps])r$/)
  return redFive ? `0${redFive[1]}` : tile
}

function parseWallClipboardText(text: string): string[] {
  const compact = text.replace(/\s+/g, '')
  if (!compact) return []
  const matches = compact.match(/5[mps]r|0[mps]|[1-9][mps]|[1-7]z|[ESWNPFC]/g)
  if (!matches || matches.join('') !== compact) return []
  return matches.map((tile) => {
    if (TENHOU_HONOR_TO_TILE[tile]) return TENHOU_HONOR_TO_TILE[tile]
    const redFive = tile.match(/^0([mps])$/)
    return redFive ? `5${redFive[1]}r` : tile
  })
}

async function copyWallToClipboard() {
  if (!wallTiles.value.length || !window.trainerAPI?.writeClipboardText) return
  const text = wallTiles.value.map((tile) => encodeWallClipboardTile(tile.tile)).join('')
  try {
    await window.trainerAPI.writeClipboardText(text)
    wallClipboardMessage.value = t('wall.copied')
  } catch {
    wallClipboardMessage.value = t('wall.copyFailed')
  }
}

async function importWallFromClipboard() {
  if (!window.trainerAPI?.importWall || !window.trainerAPI?.readClipboardText || isReadOnlyRecord.value) return
  try {
    const raw = await window.trainerAPI.readClipboardText()
    const tiles = parseWallClipboardText(raw)
    if (tiles.length !== 136) {
      wallClipboardMessage.value = t('wall.invalidClipboard')
      return
    }
    const confirmed = window.confirm(t('wall.importConfirm'))
    if (!confirmed) {
      wallClipboardMessage.value = t('wall.importCanceled')
      return
    }
    const response = await window.trainerAPI.importWall(tiles)
    applyStatus(response.state)
    applyGameView(response.view)
    await refreshWallView()
    wallClipboardMessage.value = t('wall.imported')
  } catch (error) {
    wallClipboardMessage.value = error instanceof Error ? error.message : t('wall.importFailed')
  }
}

async function toggleMode() {
  if (!window.trainerAPI || !status.gameLoaded || isReadOnlyRecord.value) return
  gameplayResponseGeneration += 1
  cancelPendingWheelNavigation()
  clearAutoAdvanceTimer()
  const nextMode = status.mode === 'play' ? 'research' : 'play'
  applyStatus(await window.trainerAPI.setMode(nextMode))
  await refreshGameView()
}

async function showRoundMapInResearchMode() {
  if (!window.trainerAPI || !status.gameLoaded) return
  if (status.mode !== 'research') {
    gameplayResponseGeneration += 1
    cancelPendingWheelNavigation()
    clearAutoAdvanceTimer()
    applyStatus(await window.trainerAPI.setMode('research'))
    await refreshGameView()
  }
  roundMapOverlayOpen.value = true
  roundMapHoveredRoundId.value = null
  focusFloatingPanel('roundMap')
}

async function toggleVisibleHands() {
  if (!window.trainerAPI) return
  applyStatus(await window.trainerAPI.toggleVisibleHands())
  await refreshGameView()
}

async function switchSeat(seat: number, label: string) {
  if (!window.trainerAPI || seatSwitchInFlight.value || seat === status.controlledSeat) return
  seatSwitchInFlight.value = true
  pendingSeatSwitchLabel.value = label
  try {
    gameView.analysis = null
    applyStatus(await window.trainerAPI.requestSeatSwitch(seat))
    await refreshGameView()
  } finally {
    seatSwitchInFlight.value = false
    pendingSeatSwitchLabel.value = ''
  }
}

function isUserDiscard(tile: string, seat: number): boolean {
  return seat === status.controlledSeat
    && gameView.table?.currentActor === seat
    && gameView.legalActions.some((action) => action.type === 'dahai' && action.pai === tile)
}

async function discardTile(tile: string, fromDrawn = false) {
  if (!window.trainerAPI || actionRequestInFlight.value || !isUserDiscard(tile, status.controlledSeat)) return
  if (isReadOnlyRecord.value || status.mode !== 'play') return
  const responseGeneration = gameplayResponseGeneration
  actionRequestInFlight.value = true
  try {
    const response = await window.trainerAPI.submitUserAction({ type: 'dahai', pai: tile, fromDrawn })
    if (responseGeneration !== gameplayResponseGeneration) return
    applyStatus(response.state)
    applyGameView(response.view)
    applyPlayPrefetchStatus(response.playPrefetch)
  } finally {
    actionRequestInFlight.value = false
  }
}

async function submitAction(action: TrainerAction) {
  if (!window.trainerAPI || actionRequestInFlight.value || isReadOnlyRecord.value || status.mode !== 'play') return
  if (action.type === 'dahai') {
    await discardTile(action.pai || '', Boolean(action.tsumogiri))
    return
  }
  const responseGeneration = gameplayResponseGeneration
  actionRequestInFlight.value = true
  try {
    const response = await window.trainerAPI.submitUserAction({
      type: action.type,
      variant: action.variant,
      candidateId: action.candidateId || action.id,
    })
    if (responseGeneration !== gameplayResponseGeneration) return
    applyStatus(response.state)
    applyGameView(response.view)
    applyPlayPrefetchStatus(response.playPrefetch)
  } finally {
    actionRequestInFlight.value = false
  }
}

function resolveNodeTransitionDirection(nodeId: string): GameViewTransitionDirection {
  const targetNode = nodeMapById.value.get(nodeId)
  const currentNode = gameView.currentNodeId ? nodeMapById.value.get(gameView.currentNodeId) : null
  return targetNode && currentNode && targetNode.depth < currentNode.depth ? 'backward' : 'forward'
}

async function jumpToNode(nodeId: string, navigationIntentId?: number) {
  if (!window.trainerAPI) return
  cancelPendingWheelNavigation()
  const intentId = navigationIntentId ?? ++latestNavigationIntentId
  latestNavigationIntentId = Math.max(latestNavigationIntentId, intentId)
  wheelNavigationCursorNodeId = nodeId
  const targetNode = nodeMapById.value.get(nodeId)
  const transitionDirection = resolveNodeTransitionDirection(nodeId)
  if (targetNode?.parentId) {
    branchReturnMap.value = {
      ...branchReturnMap.value,
      [targetNode.parentId]: nodeId,
    }
  }
  const response = await window.trainerAPI.jumpToNode(nodeId, gameView.tree?.revision)
  if (intentId !== latestNavigationIntentId) return
  applyStatus(response.state)
  applyGameView(response.view, transitionDirection)
  wheelNavigationCursorNodeId = response.view.currentNodeId
}

async function dispatchQueuedWheelNavigation() {
  if (!window.trainerAPI || wheelNavigationRequestInFlight || !wheelNavigationQueuedNodeId) return
  const nodeId = wheelNavigationQueuedNodeId
  const transitionDirection = wheelNavigationQueuedDirection ?? resolveNodeTransitionDirection(nodeId)
  const generation = wheelNavigationGeneration
  wheelNavigationQueuedNodeId = null
  wheelNavigationQueuedDirection = null
  wheelNavigationRequestInFlight = true

  try {
    const response = await window.trainerAPI.jumpToNode(nodeId, gameView.tree?.revision)
    if (generation !== wheelNavigationGeneration || generation !== latestNavigationIntentId) return
    applyStatus(response.state)
    applyGameView(response.view, transitionDirection)
  } finally {
    wheelNavigationRequestInFlight = false
    if (generation === wheelNavigationGeneration && !wheelNavigationQueuedNodeId) {
      wheelNavigationGeneration = 0
      wheelNavigationCursorNodeId = gameView.currentNodeId
    }
    if (wheelNavigationQueuedNodeId) {
      void dispatchQueuedWheelNavigation()
    }
  }
}

async function advanceGame() {
  if (!window.trainerAPI || isReadOnlyRecord.value || advanceRequestInFlight.value || status.mode !== 'play') return
  const responseGeneration = gameplayResponseGeneration
  advanceRequestInFlight.value = true
  playPrefetchReady.value = false
  const currentPrefetchKey = playPrefetchPositionKey(gameView.gameId, gameView.currentNodeId)
  if (currentPrefetchKey) earlyPlayPrefetchReady.delete(currentPrefetchKey)
  try {
    const response = await window.trainerAPI.advanceGame()
    if (responseGeneration !== gameplayResponseGeneration) return
    applyStatus(response.state)
    if (response.playPrefetch?.committed !== false) {
      applyGameView(response.view)
    }
    applyPlayPrefetchStatus(response.playPrefetch)
  } finally {
    advanceRequestInFlight.value = false
    if (playPrefetchReady.value) scheduleAutoAdvance()
  }
}

function continueFromResult() {
  if (resultIsMatchEnd.value) return
  void advanceGame()
}

async function confirmPendingReview() {
  if (!window.trainerAPI || isReadOnlyRecord.value || status.mode !== 'play') return
  const responseGeneration = gameplayResponseGeneration
  const response = await window.trainerAPI.confirmPendingReview()
  if (responseGeneration !== gameplayResponseGeneration) return
  applyStatus(response.state)
  applyGameView(response.view)
  applyPlayPrefetchStatus(response.playPrefetch)
}

function formatActionValue(action: TrainerAction): string {
  if (action.type !== 'dahai') {
    const special = resolveSpecialEntry(action)
    if (special) return special.value.toFixed(3)
    if (action.type === 'hora') return t('action.win')
    if (action.type === 'reach') return t('action.riichi')
    if (action.type === 'ryukyoku') return t('action.drawResult')
  }
  if (action.value !== undefined) return action.value.toFixed(3)
  if (!action.pai || !gameView.analysis?.discardEntries?.length) return '-'
  const entry = resolveDiscardEntry(action)
  return entry ? entry.value.toFixed(3) : '-'
}

function resolveDisplayedActionBar(action: TrainerAction): number {
  if (!showTrainingRecommendations.value || !hasRecommendationAnalysis()) return 0
  return resolveActionBar(action)
}

function resolveDisplayedDiscardSlotBar(slot: DiscardBarSlot): number {
  if (!showTrainingRecommendations.value || !hasRecommendationAnalysis()) return 0
  if (!slot.entry) return 0
  return resolveAnalysisEntryBar(slot.entry)
}

function clampBarScale(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function barFillStyle(value: number) {
  return { transform: `scaleY(${clampBarScale(value)})` }
}

function barUpperStyle(value: number) {
  return { transform: `scaleY(${1 - clampBarScale(value)})` }
}

function isBestAction(action?: TrainerAction): boolean {
  if (!action) return false
  if (action.type === 'dahai') return analysisEntryIsBest(resolveDiscardEntry(action))
  return analysisEntryIsBest(resolveReactionEntry(action) || resolveSpecialEntry(action))
}

function navigateTreeByOffset(offset: number) {
  const cursorNodeId = wheelNavigationCursorNodeId || gameView.currentNodeId
  if (!cursorNodeId) return
  // Rendering filters links outside the active round, but wheel navigation must
  // retain those links to reach the adjacent round on the same branch.
  const node = nodeMapById.value.get(cursorNodeId)
  if (!node) return
  let targetNodeId: string | null = null
  let transitionDirection: GameViewTransitionDirection
  if (offset < 0) {
    if (!node.parentId) return
    if (!nodeMapById.value.has(node.parentId)) {
      const activeRound = activeRoundRootId.value
        ? roundRootById.value.get(activeRoundRootId.value)
        : null
      if (cursorNodeId !== activeRoundRootId.value || !activeRound?.parentRoundId) return
    }
    branchReturnMap.value = {
      ...branchReturnMap.value,
      [node.parentId]: node.id,
    }
    targetNodeId = node.parentId
    transitionDirection = 'backward'
  } else {
    const children = (node.children || []).filter(
      (childId) => nodeMapById.value.has(childId) || roundRootById.value.has(childId),
    )
    if (!children.length) return
    const rememberedChild = branchReturnMap.value[node.id]
    targetNodeId = children.includes(rememberedChild) ? rememberedChild : null
    if (!targetNodeId) {
      targetNodeId = node.mainChildId && children.includes(node.mainChildId)
        ? node.mainChildId
        : children[0]
    }
    if (!targetNodeId) return
    if (rememberedChild && targetNodeId === rememberedChild) {
      const nextMap = { ...branchReturnMap.value }
      delete nextMap[node.id]
      branchReturnMap.value = nextMap
    }
    transitionDirection = 'forward'
  }

  wheelNavigationCursorNodeId = targetNodeId
  if (wheelNavigationGeneration === 0) {
    wheelNavigationGeneration = ++latestNavigationIntentId
  }
  wheelNavigationQueuedNodeId = targetNodeId
  wheelNavigationQueuedDirection = transitionDirection
  void dispatchQueuedWheelNavigation()
}

const ANKAN_CHOICE_TIMEOUT_MS = 6000

function scheduleAutoAdvance() {
  clearAutoAdvanceTimer()
  if (!window.trainerAPI || status.mode !== 'play' || gameView.pendingReview || isReadOnlyRecord.value) return
  const isTerminal = gameView.table?.phase === 'round_result' || gameView.table?.phase === 'match_end'
  if (gameView.table?.resultInfo || isTerminal) return
  const d = settings.modeDefaults.autoAdvanceDelayMs
  const motionDelay = reduceMotionEnabled.value
    ? 0
    : Math.max(0, Math.ceil(autoAdvanceMotionNotBefore - performance.now()))
  const scheduleAdvance = (delayMs: number) => {
    autoAdvanceTimer.value = window.setTimeout(() => {
      autoAdvanceTimer.value = null
      // The animation's actual finish event reschedules advancement precisely.
      if (pendingDiscardFlightAnimation !== null) return
      void advanceGame()
    }, Math.max(delayMs, motionDelay))
  }
  if (playPrefetchReady.value) {
    scheduleAdvance(d)
    return
  }
  if (playPrefetchWaiting.value) return
  if (gameView.table?.autoAdvanceMode === 'ai_think') {
    scheduleAdvance(0)
    return
  }
  if (gameView.table?.phase === 'game_end') {
    scheduleAdvance(d)
    return
  }
  if (gameView.table?.phase === 'reach_declaration') {
    if (gameView.legalActions.length > 0) return
    scheduleAdvance(d)
    return
  }
  if (gameView.table && gameView.table.phase === 'draw_or_discard' && gameView.table.currentActor === status.controlledSeat) {
    scheduleAdvance(30)
    return
  }
  if (gameView.table?.riichiDiscardState === 'pending_pause') {
    scheduleAdvance(d)
    return
  }
  if (gameView.table?.riichiDiscardState === 'ankan_choice') {
    scheduleAdvance(ANKAN_CHOICE_TIMEOUT_MS)
    return
  }
  if (gameView.table?.riichiAccepted?.[status.controlledSeat] && gameView.table?.riichiDiscardState == null && gameView.legalActions.length === 0) {
    scheduleAdvance(d)
    return
  }
  if (gameView.legalActions.length > 0) return
  if (gameView.table && (gameView.table.phase === 'discard' || gameView.table.phase === 'draw_or_discard') && gameView.table.currentActor !== status.controlledSeat) {
    scheduleAdvance(d)
    return
  }
  if (gameView.table?.reactionWindow) {
    const reactionDelay = Math.max(d, Math.round((gameView.table.reactionWindow.thinkingTimeS || 0) * 1000))
    scheduleAdvance(reactionDelay)
    return
  }
  if (gameView.table?.kanReactionWindow) {
    const reactionDelay = Math.max(d, Math.round((gameView.table.kanReactionWindow.thinkingTimeS || 0) * 1000))
    scheduleAdvance(reactionDelay)
  }
}

watch(
  () => [
    gameView.currentNodeId,
    gameView.table?.phase,
    gameView.table?.autoAdvanceMode,
    gameView.table?.riichiDiscardState,
    gameView.table?.reactionWindow,
    gameView.table?.kanReactionWindow,
    gameView.legalActions.length,
    gameView.pendingReview?.proposedNodeId,
    status.mode,
  ],
  () => { scheduleAutoAdvance() },
)

watchEffect(() => {
  document.title = windowTitle.value
})

watch(
  () => gameView.currentNodeId,
  async () => {
    triggerActionAnnouncementForCurrentNode()
    await nextTick()
    updateTreeViewport()
    if (!treeAutoFollowSuspended) keepCurrentTreeDotVisible()
  },
)

watch(
  () => [treeSvgH.value, treeDots.value.length],
  async () => {
    await nextTick()
    updateTreeViewport()
  },
)

const tableStageEl = ref<HTMLElement | null>(null)
let tableZoomRaf = 0
let tableZoomPassesPending = 0
const handleWindowResize = () => scheduleTableZoomRecalc()

function scheduleTableZoomRecalc(passes = 12) {
  tableZoomPassesPending = Math.max(tableZoomPassesPending, passes)
  if (tableZoomRaf) return
  tableZoomRaf = window.requestAnimationFrame(() => {
    tableZoomRaf = 0
    recalcTableZoom()
    tableZoomPassesPending = Math.max(0, tableZoomPassesPending - 1)
    if (tableZoomPassesPending > 0) {
      scheduleTableZoomRecalc(tableZoomPassesPending)
    } else {
      tableZoomPassesPending = 0
    }
  })
}

function recalcTableZoom() {
  const stage = tableStageEl.value
  if (!stage) return false
  const currentZoom = Math.max(0.1, tableZoom.value)
  const style = window.getComputedStyle(stage)
  const padX = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0')
  const padY = parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0')
  const availW = Math.max(0, stage.clientWidth - padX)
  const availH = Math.max(0, stage.clientHeight - padY)

  let nextZoom = currentZoom

  if (availW > 0 && availH > 0) {
    const zoomByWidth = ((3 * availW) + 16) / 1978
    const zoomByHeight = (availH + 7.04) / 720.5099
    nextZoom = Math.max(0.1, Math.min(zoomByWidth, zoomByHeight))
  }

  if (availW > 0 && availH > 0) {
    const padLeft = parseFloat(style.paddingLeft || '0')
    const padRight = parseFloat(style.paddingRight || '0')
    const padTop = parseFloat(style.paddingTop || '0')
    const padBottom = parseFloat(style.paddingBottom || '0')
    const contentScrollW = Math.max(0, stage.scrollWidth - padLeft - padRight)
    const contentScrollH = Math.max(0, stage.scrollHeight - padTop - padBottom)
    const overflowScale = Math.min(
      contentScrollW > 0 ? availW / contentScrollW : 1,
      contentScrollH > 0 ? availH / contentScrollH : 1,
    )
    if (Number.isFinite(overflowScale) && overflowScale > 0 && overflowScale < 1) {
      nextZoom *= overflowScale
    }
  }

  if (Math.abs(nextZoom - tableZoom.value) > 0.0001) {
    tableZoom.value = nextZoom
    return true
  }
  return false
}

watch(uiScale, async () => {
  await nextTick()
  scheduleTableZoomRecalc()
  updateTreeViewport()
  resizeNodeComment()
})

watch(treePanelCollapsed, async (collapsed) => {
  if (collapsed) return
  await nextTick()
  updateTreeViewport()
  resizeNodeComment()
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

function handlePythonEvent(event: TrainerPythonEvent) {
  if (event.type === 'auto_analysis_progress' && event.autoAnalysis) {
    if (event.gameId && event.gameId !== gameView.gameId) return
    status.autoAnalysis = { ...event.autoAnalysis }
    return
  }
  if (event.type === 'play_prefetch_ready' && event.gameId && event.nodeId) {
    const key = playPrefetchPositionKey(event.gameId, event.nodeId)
    if (key) earlyPlayPrefetchReady.add(key)
    if (event.gameId === gameView.gameId && event.nodeId === gameView.currentNodeId) {
      playPrefetchReady.value = true
      playPrefetchWaiting.value = false
      scheduleAutoAdvance()
    }
    return
  }
  if (event.gameId && event.gameId !== gameView.gameId) return
  if (event.autoAnalysis) {
    status.autoAnalysis = { ...event.autoAnalysis }
  } else if (event.state?.autoAnalysis) {
    status.autoAnalysis = { ...event.state.autoAnalysis }
  }
  if (event.type === 'auto_analysis_tree_updates') {
    event.treeComparisons?.forEach((update) => {
      const node = nodeMapById.value.get(update.id)
      if (node) node.comparison = update.comparison
    })
    if (gameView.tree && typeof event.treeRevision === 'number') {
      gameView.tree.revision = event.treeRevision
    }
    return
  }
  if (event.type === 'model_activity') {
    const activityState = normalizeModelActivityState(event.activityState ?? event.active)
    const averageMs = Number(event.averageMs)
    const errors = status.modelActivity?.errors || {
      decision: [null, null, null, null],
      opponentAnalysis: null,
    }
    if (event.model === 'decision' && Number.isInteger(event.seat)) {
      if (event.runtime) {
        status.modelRuntime.decision = { ...event.runtime }
      }
      const seat = Number(event.seat)
      if (seat >= 0 && seat < 4) {
        const decision = [...(status.modelActivity?.decision || ['idle', 'idle', 'idle', 'idle'])]
        const decisionErrors = [...errors.decision]
        const decisionPerformance = [...(status.modelPerformance?.decision || [0, 0, 0, 0])]
        decision[seat] = activityState
        decisionErrors[seat] = activityState === 'error' ? String(event.error || t('error.unknown')) : null
        if (Number.isFinite(averageMs) && averageMs >= 0) decisionPerformance[seat] = averageMs
        status.modelPerformance = {
          decision: decisionPerformance,
          opponentAnalysis: status.modelPerformance?.opponentAnalysis || 0,
        }
        status.modelActivity = {
          decision,
          opponentAnalysis: normalizeModelActivityState(status.modelActivity?.opponentAnalysis),
          errors: {
            decision: decisionErrors,
            opponentAnalysis: errors.opponentAnalysis,
          },
        }
      }
    } else if (event.model === 'opponent_analysis') {
      if (event.runtime) {
        status.modelRuntime.opponentAnalysis = { ...event.runtime }
      }
      if (Number.isFinite(averageMs) && averageMs >= 0) {
        status.modelPerformance = {
          decision: [...(status.modelPerformance?.decision || [0, 0, 0, 0])],
          opponentAnalysis: averageMs,
        }
      }
      status.modelActivity = {
        decision: [...(status.modelActivity?.decision || ['idle', 'idle', 'idle', 'idle'])]
          .map(normalizeModelActivityState),
        opponentAnalysis: activityState,
        errors: {
          decision: [...errors.decision],
          opponentAnalysis: activityState === 'error' ? String(event.error || t('error.unknown')) : null,
        },
      }
      if (activityState === 'error') {
        if (!shantenResultHasRows(gameView.opponentAnalysis)) {
          clearOpponentAnalysisWithoutMotion()
        }
        void fetchShantenOnce()
      }
    }
    return
  }
  if (event.type === 'opponent_analysis_ready' && event.opponentAnalysis) {
    if (event.gameId && event.gameId !== gameView.gameId) return
    if (event.nodeId && event.nodeId !== gameView.currentNodeId) return
    if (Number.isInteger(event.seat) && Number(event.seat) !== status.controlledSeat) return
    applyShantenResult(event.opponentAnalysis)
    return
  }
  if (event.type === 'analysis_ready' && event.nodeId && event.analysis) {
    if (!effectiveDecisionRecommendationsEnabled.value) return
    if (event.gameId && event.gameId !== gameView.gameId) return
    const analysisSeat = typeof (event.analysis as Record<string, unknown>).seat === 'number'
      ? Number((event.analysis as Record<string, unknown>).seat)
      : null
    if (analysisSeat !== null && analysisSeat !== status.controlledSeat) return
    if (event.state) {
      applyStatus(event.state as TrainerStatusSnapshot)
    }
    if (event.treeComparisons?.length) {
      event.treeComparisons.forEach((update) => {
        const node = nodeMapById.value.get(update.id)
        if (node) node.comparison = update.comparison
      })
    }
    if (gameView.tree && typeof event.treeRevision === 'number') {
      gameView.tree.revision = event.treeRevision
    }
    const analysis = event.analysis as DecisionAnalysis
    cacheDecisionAnalysis(event.gameId || gameView.gameId, event.nodeId, analysis)
    if (event.nodeId === gameView.currentNodeId) {
      gameView.analysis = analysis
    }
  }
}

let unsubscribePythonEvents: (() => void) | null = null
let unsubscribeUiZoomShortcut: (() => void) | null = null
let unsubscribeRecordDirtyChanged: (() => void) | null = null
let unsubscribeBeforeClose: (() => void) | null = null

async function fetchAndShowMjaiDebug() {
  showMjaiDebug.value = true
  analysisCacheClearMessage.value = ''
  if (window.trainerAPI?.getLatestMjaiDebug) {
    try {
      const result = await window.trainerAPI.getLatestMjaiDebug()
      mjaiDebugData.value = (result as Record<string, unknown>).debug as Record<string, unknown> || {}
    } catch {
      mjaiDebugData.value = { error: 'Failed to fetch mjai debug data' }
    }
  }
  if (window.trainerAPI?.getShantenMjai) {
    try {
      const result = await window.trainerAPI.getShantenMjai()
      shantenMjaiData.value = (result as Record<string, unknown>).debug as Record<string, unknown> || {}
    } catch {
      shantenMjaiData.value = { error: 'Failed to fetch shanten mjai' }
    }
  }
}

async function clearLoadedAnalysisCaches() {
  if (!window.trainerAPI?.clearAnalysisCaches || clearingAnalysisCaches.value) return
  clearingAnalysisCaches.value = true
  analysisCacheClearMessage.value = ''
  try {
    const response = await window.trainerAPI.clearAnalysisCaches()
    applyStatus(response.state)
    decisionAnalysisEventCache.clear()
    gameView.analysis = null
    gameView.comparison = null
    gameView.pendingReview = null
    treeNodeList.value.forEach((node) => {
      node.comparison = null
    })
    if (gameView.tree) gameView.tree.revision = response.cleared.treeRevision

    shantenPredData.value = {}
    shantenGTData.value = {}
    ronWaitPredData.value = {}
    ronWaitGTData.value = {}
    shantenRawData.value = {}
    shantenStatus.value = t('debug.cacheCleared')

    const { decisionEntries, opponentEntries, comparisons } = response.cleared
    analysisCacheClearMessage.value = t('debug.cacheSummary', {
      decision: decisionEntries,
      opponent: opponentEntries,
      comparisons,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    analysisCacheClearMessage.value = t('debug.clearFailed', { message })
  } finally {
    clearingAnalysisCaches.value = false
  }
}

function nextUiScale(direction: 'in' | 'out' | 'reset'): number {
  if (direction === 'reset') return 1
  const current = uiScale.value
  if (direction === 'in') {
    return UI_SCALE_STEPS.find((step) => step > current + 0.001) ?? UI_SCALE_STEPS.at(-1) ?? 2
  }
  return [...UI_SCALE_STEPS].reverse().find((step) => step < current - 0.001) ?? UI_SCALE_STEPS[0]
}

async function changeUiScale(direction: 'in' | 'out' | 'reset') {
  const next = nextUiScale(direction)
  if (next === uiScale.value) return
  settings.display.uiScale = next
  if (showSettingsPanel.value) settingsDraft.display.uiScale = next
  try {
    await window.trainerAPI?.saveSettings({
      display: { ...settings.display, uiScale: next },
    })
  } catch (error) {
    console.warn('Failed to save UI scale:', error)
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
  if (e.key === 'F1') {
    e.preventDefault()
    if (showMjaiDebug.value) {
      showMjaiDebug.value = false
    } else {
      void fetchAndShowMjaiDebug()
    }
  }
}

onMounted(() => {
  window.addEventListener('resize', handleWindowResize)
  window.addEventListener('resize', updateTreeViewport)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('wheel', onUiScaleWheel, { capture: true, passive: false })
  autoAnalysisResizeObserver = new ResizeObserver(scheduleAutoAnalysisCanvasDraw)
  if (autoAnalysisCanvasEl.value) autoAnalysisResizeObserver.observe(autoAnalysisCanvasEl.value)
  scheduleAutoAnalysisCanvasDraw()
  scheduleTableZoomRecalc()
  void refreshRuntimeMetrics()
  runtimeMetricsTimer = window.setInterval(() => {
    void refreshRuntimeMetrics()
  }, 2000)
  void prepareRendererForDisplay()
  if (window.trainerAPI?.onPythonEvent) {
    unsubscribePythonEvents = window.trainerAPI.onPythonEvent(handlePythonEvent)
  }
  if (window.trainerAPI?.onRecordDirtyChanged) {
    unsubscribeRecordDirtyChanged = window.trainerAPI.onRecordDirtyChanged((dirty) => {
      recordDirty.value = dirty
    })
  }
  if (window.trainerAPI?.onUiZoomShortcut) {
    unsubscribeUiZoomShortcut = window.trainerAPI.onUiZoomShortcut((direction) => {
      void changeUiScale(direction)
    })
  }
  if (window.trainerAPI?.onBeforeClose) {
    unsubscribeBeforeClose = window.trainerAPI.onBeforeClose(() => flushNodeComment())
  }
})

onBeforeUnmount(() => {
  removeDockPanelPointerListeners()
  cancelEngineAutosaveTimer()
  flushNodeCommentInBackground()
  if (deleteEngineConfirmationTimer !== null) {
    window.clearTimeout(deleteEngineConfirmationTimer)
  }
  if (deleteNodeConfirmationTimer !== null) {
    window.clearTimeout(deleteNodeConfirmationTimer)
  }
  cancelPendingDiscardFlight()
  cancelPendingDiscardReturnFlight()
  clearAutoAdvanceTimer()
  cancelPendingWheelNavigation()
  clearActionAnnouncementTimer()
  if (runtimeMetricsTimer !== null) {
    window.clearInterval(runtimeMetricsTimer)
    runtimeMetricsTimer = null
  }
  window.removeEventListener('resize', handleWindowResize)
  window.removeEventListener('resize', updateTreeViewport)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('wheel', onUiScaleWheel, true)
  autoAnalysisResizeObserver?.disconnect()
  autoAnalysisResizeObserver = null
  if (autoAnalysisCanvasRaf) {
    cancelAnimationFrame(autoAnalysisCanvasRaf)
    autoAnalysisCanvasRaf = 0
  }
  if (tableZoomRaf) {
    cancelAnimationFrame(tableZoomRaf)
    tableZoomRaf = 0
  }
  if (treeViewportRaf) {
    cancelAnimationFrame(treeViewportRaf)
    treeViewportRaf = 0
  }
  document.documentElement.classList.remove('reduce-motion')
  tableZoomPassesPending = 0
  if (unsubscribePythonEvents) {
    unsubscribePythonEvents()
    unsubscribePythonEvents = null
  }
  if (unsubscribeUiZoomShortcut) {
    unsubscribeUiZoomShortcut()
    unsubscribeUiZoomShortcut = null
  }
  if (unsubscribeRecordDirtyChanged) {
    unsubscribeRecordDirtyChanged()
    unsubscribeRecordDirtyChanged = null
  }
  if (unsubscribeBeforeClose) {
    unsubscribeBeforeClose()
    unsubscribeBeforeClose = null
  }
})
</script>
