import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import type { TranslationParams } from './i18n'
import type { GameView } from './contracts/game'
import type { StudioStatus } from './contracts/runtime'

export interface WallTile {
  index: number
  tile: string
  status: string
}

interface WallViewOptions {
  gameView: GameView
  readOnlyRecord: Readonly<Ref<boolean>>
  t: (key: string, params?: TranslationParams) => string
  focus: () => void
  applyStatus: (status: StudioStatus) => void
  applyGameView: (view: GameView) => void
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

export function encodeWallClipboardTile(tile: string): string {
  if (TILE_TO_TENHOU_HONOR[tile]) return TILE_TO_TENHOU_HONOR[tile]
  const redFive = tile.match(/^5([mps])r$/)
  return redFive ? `0${redFive[1]}` : tile
}

export function parseWallClipboardText(text: string): string[] {
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

export function buildWallTileRows(tiles: WallTile[]): WallTile[][][] {
  const rows: WallTile[][][] = []
  const sectionEnds = [53, 122, tiles.length]
  let sectionStart = 0
  for (const sectionEnd of sectionEnds) {
    if (sectionEnd <= sectionStart) continue
    const groups: WallTile[][] = []
    for (let index = sectionStart; index < sectionEnd; index += 4) {
      groups.push(tiles.slice(index, Math.min(index + 4, sectionEnd)))
    }
    for (let index = 0; index < groups.length; index += 4) {
      rows.push(groups.slice(index, index + 4))
    }
    sectionStart = sectionEnd
  }
  return rows
}

export function useWallView({
  gameView,
  readOnlyRecord,
  t,
  focus,
  applyStatus,
  applyGameView,
}: WallViewOptions) {
  const showWallView = ref(false)
  const wallTiles = ref<WallTile[]>([])
  const wallLoading = ref(false)
  const wallViewComplete = ref(false)
  const wallCanReconstruct = ref(false)
  const wallSeed = ref<number | null>(null)
  const wallOrigin = ref<'generated' | 'imported' | 'reconstructed'>('generated')
  const wallSourceUrl = ref('')
  const wallReconstructionSeed = ref('')
  const wallReconstructing = ref(false)
  const wallClipboardMessage = ref('')
  const wallTileRows = computed(() => buildWallTileRows(wallTiles.value))
  let refreshGeneration = 0

  function clearWallResult() {
    wallTiles.value = []
    wallViewComplete.value = false
    wallCanReconstruct.value = false
    wallSeed.value = null
    wallOrigin.value = 'generated'
    wallSourceUrl.value = ''
  }

  function closeWallView(clearResult = false) {
    refreshGeneration += 1
    showWallView.value = false
    wallLoading.value = false
    wallReconstructing.value = false
    if (clearResult) clearWallResult()
  }

  async function refreshWallView(closeOnError = false, showLoading = false) {
    if (!showWallView.value || !window.studioAPI?.getWallView || !gameView.table) return
    const generation = ++refreshGeneration
    const expectedGameId = gameView.gameId
    const expectedNodeId = gameView.currentNodeId
    if (showLoading) {
      wallLoading.value = true
      clearWallResult()
    }
    try {
      const result = await window.studioAPI.getWallView()
      if (
        generation !== refreshGeneration
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
      if (closeOnError && generation === refreshGeneration) closeWallView()
    } finally {
      if (generation === refreshGeneration) wallLoading.value = false
    }
  }

  async function openWallView() {
    if (!window.studioAPI?.getWallView) return
    showWallView.value = true
    focus()
    wallClipboardMessage.value = ''
    await refreshWallView(true, true)
  }

  function reportReconstructedRounds(count: number) {
    wallClipboardMessage.value = t('wall.reconstructedRounds', { count })
  }

  async function reconstructImportedWalls() {
    if (!window.studioAPI?.reconstructWalls || wallReconstructing.value) return
    wallReconstructing.value = true
    wallClipboardMessage.value = ''
    try {
      const response = await window.studioAPI.reconstructWalls(wallReconstructionSeed.value)
      applyStatus(response.state)
      applyGameView(response.view)
      wallReconstructionSeed.value = ''
      await refreshWallView(false, true)
      reportReconstructedRounds(response.reconstruction.roundCount)
    } catch (error) {
      wallClipboardMessage.value = error instanceof Error ? error.message : t('wall.reconstructFailed')
    } finally {
      wallReconstructing.value = false
    }
  }

  async function copyWallToClipboard() {
    if (!wallTiles.value.length || !window.studioAPI?.writeClipboardText) return
    const text = wallTiles.value.map((tile) => encodeWallClipboardTile(tile.tile)).join('')
    try {
      await window.studioAPI.writeClipboardText(text)
      wallClipboardMessage.value = t('wall.copied')
    } catch {
      wallClipboardMessage.value = t('wall.copyFailed')
    }
  }

  async function importWallFromClipboard() {
    if (!window.studioAPI?.importWall || !window.studioAPI?.readClipboardText || readOnlyRecord.value) return
    try {
      const tiles = parseWallClipboardText(await window.studioAPI.readClipboardText())
      if (tiles.length !== 136) {
        wallClipboardMessage.value = t('wall.invalidClipboard')
        return
      }
      if (!window.confirm(t('wall.importConfirm'))) {
        wallClipboardMessage.value = t('wall.importCanceled')
        return
      }
      const response = await window.studioAPI.importWall(tiles)
      applyStatus(response.state)
      applyGameView(response.view)
      await refreshWallView()
      wallClipboardMessage.value = t('wall.imported')
    } catch (error) {
      wallClipboardMessage.value = error instanceof Error ? error.message : t('wall.importFailed')
    }
  }

  onBeforeUnmount(() => closeWallView(true))

  return {
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
  }
}
